import type { HttpBindings } from "@hono/node-server";
import { BaerlyError } from "@baerly/protocol";

/**
 * Body-cap enforcement for Node-hosted requests. Replaces the
 * pre-pivot `bodyCapMiddleware` that attached `incoming.on("data",
 * ...)` — that listener raced with `@hono/node-server`'s own body
 * reader and dropped the first chunks of every POST. Wrapping
 * `req.body` with a counting `TransformStream` puts the cap in the
 * same reader chain as the kernel router's `c.req.arrayBuffer()`
 * consumer, so there is no race.
 *
 * Two cap-trip paths, both drain the upstream `IncomingMessage`
 * (`resume()`) so the client's body write completes and the 413
 * envelope reaches it cleanly (without drain, closing the response
 * mid-upload surfaces client-side as "socket hang up"):
 *
 *   - Content-Length fast path → returns a 413 `Response` directly.
 *   - Chunked slow path → wraps `req.body` with a counting
 *     `TransformStream` that errors with `BaerlyError{code:
 *     "PayloadTooLarge"}` when the running count exceeds `max`.
 *     The kernel router's `readJsonBody` recognises the
 *     `BaerlyError` and re-throws it verbatim; `mapToResponse`
 *     surfaces the same 413 envelope as the fast path.
 *
 * Returns the original `Request` unchanged for `GET`/`HEAD`/
 * `OPTIONS` (no body to cap) and for hosts that don't expose an
 * `IncomingMessage` on the Hono context's env binding — defence-in-
 * depth lives in the kernel router's `readJsonBody`.
 */
export function applyBodyCap(req: Request, env: unknown, max: number): Request | Response {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
    return req;
  }
  const incoming = (env as HttpBindings | undefined)?.incoming;
  if (incoming === undefined) {
    return req;
  }

  const lenHeader = req.headers.get("content-length");
  if (lenHeader !== null) {
    const parsed = Number.parseInt(lenHeader, 10);
    if (Number.isFinite(parsed) && parsed > max) {
      incoming.resume();
      return cap413(max);
    }
  }

  const body = req.body;
  if (body === null) {
    return req;
  }

  let count = 0;
  let tripped = false;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (tripped) {
        return;
      }
      count += chunk.byteLength;
      if (count > max) {
        tripped = true;
        incoming.resume();
        controller.error(new BaerlyError("PayloadTooLarge", `Body exceeds ${max} bytes`));
        return;
      }
      controller.enqueue(chunk);
    },
  });

  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: body.pipeThrough(counter),
    // `duplex` is required by Node/undici for streaming request bodies; the
    // standard DOM `RequestInit` doesn't surface it yet.
    duplex: "half",
  } as RequestInit & { duplex: "half" });
}

function cap413(max: number): Response {
  return new Response(
    JSON.stringify({
      error: { code: "PayloadTooLarge", message: `Body exceeds ${max} bytes` },
    }),
    { status: 413, headers: { "content-type": "application/json" } },
  );
}
