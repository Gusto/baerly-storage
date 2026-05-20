import type { IncomingMessage } from "node:http";
import type { Context, MiddlewareHandler } from "hono";

interface NodeBindings {
  readonly incoming?: IncomingMessage;
}

/**
 * Cap request bodies at `maxBytes`. When the cap trips, the
 * IncomingMessage is **drained** (not destroyed) so the client can
 * finish writing and read the 413 envelope cleanly. Destroying tears
 * down the shared req/res socket before the 413 flushes and surfaces
 * as a client-side "socket hang up" — verified against Node's
 * `fetch()`, which won't read the response until its outbound body
 * write completes.
 *
 * Only attaches to `POST`/`PUT`/`PATCH`/`DELETE`. GET/HEAD/OPTIONS
 * short-circuit. When `c.env.incoming` is undefined (non-Node host),
 * the middleware is a no-op and the kernel router's own defence-in-
 * depth length check at `packages/server/src/http/router.ts:464-501`
 * remains the backstop.
 */
export function bodyCapMiddleware(maxBytes: number): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return next();
    }

    const incoming = (c.env as NodeBindings | undefined)?.incoming;
    if (incoming === undefined) {
      // No underlying IncomingMessage (test host, non-Node, etc.).
      // Defence-in-depth in router.ts catches over-cap bodies.
      return next();
    }

    // Content-Length fast-path. Drain the rest of the upload so the
    // 413 reaches the client cleanly.
    const lenHeader = c.req.header("content-length");
    if (lenHeader !== undefined) {
      const parsed = Number.parseInt(lenHeader, 10);
      if (Number.isFinite(parsed) && parsed > maxBytes) {
        incoming.resume();
        c.res = cap413(c, maxBytes);
        return;
      }
    }

    let total = 0;
    let tripped = false;
    let trippedResolve: (() => void) | undefined;
    const trippedPromise = new Promise<void>((resolve) => {
      trippedResolve = resolve;
    });

    const onData = (chunk: Buffer): void => {
      if (tripped) {
        return;
      }
      total += chunk.byteLength;
      if (total > maxBytes) {
        tripped = true;
        incoming.removeListener("data", onData);
        // Drain — do NOT destroy/pause. See JSDoc above.
        incoming.resume();
        trippedResolve?.();
      }
    };
    const cleanup = (): void => {
      incoming.removeListener("data", onData);
      // Resolve the trip promise on terminal events so the race
      // doesn't hang if the upload completes cleanly.
      trippedResolve?.();
    };
    incoming.on("data", onData);
    incoming.once("end", cleanup);
    incoming.once("close", cleanup);

    const handlerPromise = next();
    await Promise.race([handlerPromise, trippedPromise]);

    if (tripped) {
      // Replace whatever the route handler produced (or didn't
      // produce yet) with the 413 envelope. The router's defence-
      // in-depth length check at router.ts:464-501 is a backstop
      // for any race where the handler resolved with a partial
      // body before our promise won.
      c.res = cap413(c, maxBytes);
      return;
    }

    // Handler returned cleanly; ensure we await it (Promise.race
    // doesn't keep the promise alive if trippedPromise won).
    await handlerPromise;
  };
}

function cap413(c: Context, maxBytes: number): Response {
  return c.json(
    {
      error: {
        code: "PayloadTooLarge",
        message: `Body exceeds ${maxBytes} bytes`,
      },
    },
    413,
  );
}
