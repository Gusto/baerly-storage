/**
 * Tests for `applyBodyCap` — the helper invoked from `createApp`
 * that enforces `MAX_BODY_BYTES` against Node-hosted requests.
 *
 * Replaces the pre-pivot `bodyCapMiddleware` (which attached
 * `incoming.on("data", ...)` and raced with `@hono/node-server`'s
 * own body reader). The new design wraps `req.body` with a counting
 * `TransformStream` that sits in the same reader chain as the
 * kernel router's `c.req.arrayBuffer()` consumer, so there is no
 * race. On cap-trip in either path the upstream
 * `IncomingMessage` is drained (`resume()`) so the 413 envelope
 * reaches the client cleanly.
 *
 * Cases:
 * 1. GET/HEAD/OPTIONS bypass — `applyBodyCap` returns the request
 *    unchanged regardless of declared length.
 * 2. No upstream `incoming` (non-Node host) — no-op pass-through.
 * 3. Under-cap chunked body — wrapped body delivers every byte
 *    downstream.
 * 4. Content-Length over-cap — direct 413 `Response`, `incoming`
 *    drained.
 * 5. Chunked over-cap — wrapped body errors with a
 *    `BaerlyError{code:"PayloadTooLarge"}` partway through the
 *    stream, `incoming` drained.
 * 6. Real-wire regression — a real Node HTTP server fronted by
 *    `createApp` + `getRequestListener` receives a chunked POST
 *    well past the cap with no `Content-Length`. The client must
 *    finish its write AND read the 413 envelope cleanly.
 */

import { getRequestListener } from "@hono/node-server";
import { BaerlyError, MemoryStorage, type Verifier } from "@baerly/protocol";
import { MAX_BODY_BYTES } from "@baerly/server/http";
import { type Server, createServer, request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { applyBodyCap } from "./middleware/body-cap.ts";
import { createApp } from "./app.ts";

const CAP = MAX_BODY_BYTES;

function fakeIncoming(): { resume: () => void; resumed: number } {
  const state = { resumed: 0 };
  return {
    resume: () => {
      state.resumed += 1;
    },
    get resumed() {
      return state.resumed;
    },
  };
}

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[i]!);
      i += 1;
    },
  });
}

async function readAll(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const out: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    out.push(value);
    total += value.byteLength;
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const buf of out) {
    merged.set(buf, offset);
    offset += buf.byteLength;
  }
  return merged;
}

describe("applyBodyCap", () => {
  test("GET requests pass through unchanged", () => {
    const incoming = fakeIncoming();
    const req = new Request("http://localhost/v1/c/c", { method: "GET" });
    const result = applyBodyCap(req, { incoming }, CAP);
    expect(result).toBe(req);
    expect(incoming.resumed).toBe(0);
  });

  test.each(["HEAD", "OPTIONS"])("%s requests pass through unchanged", (method) => {
    const incoming = fakeIncoming();
    const req = new Request("http://localhost/v1/c/c", { method });
    const result = applyBodyCap(req, { incoming }, CAP);
    expect(result).toBe(req);
    expect(incoming.resumed).toBe(0);
  });

  test("no upstream `incoming` is a no-op (kernel defence-in-depth handles cap)", () => {
    const req = new Request("http://localhost/v1/c/c", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"x":1}',
    });
    const result = applyBodyCap(req, {}, CAP);
    expect(result).toBe(req);
  });

  test("under-cap chunked body: wrapped request delivers every byte", async () => {
    const incoming = fakeIncoming();
    const total = 4096;
    const chunkSize = 1024;
    const chunks = Array.from({ length: total / chunkSize }, () => new Uint8Array(chunkSize));
    const req = new Request("http://localhost/v1/c/c", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: stream(chunks),
      // @ts-expect-error duplex is a Node/undici extension for streaming request bodies
      duplex: "half",
    });
    const result = applyBodyCap(req, { incoming }, CAP);
    expect(result).not.toBe(req);
    expect(result).toBeInstanceOf(Request);
    const wrapped = result as Request;
    const bytes = await readAll(wrapped.body!);
    expect(bytes.byteLength).toBe(total);
    expect(incoming.resumed).toBe(0);
  });

  test("content-length over cap: returns 413 envelope and drains incoming", async () => {
    const incoming = fakeIncoming();
    const size = CAP + 1;
    const req = new Request("http://localhost/v1/c/c", {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(size),
      },
      body: new Uint8Array(size),
    });
    const result = applyBodyCap(req, { incoming }, CAP);
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({
      error: { code: "PayloadTooLarge", message: `Body exceeds ${CAP} bytes` },
    });
    expect(incoming.resumed).toBe(1);
  });

  test("chunked over cap: wrapped body errors with PayloadTooLarge and drains incoming", async () => {
    const incoming = fakeIncoming();
    // No Content-Length header → slow path. Send 2x the cap in
    // CAP/4-sized chunks so the trip lands mid-stream.
    const chunkSize = Math.floor(CAP / 4);
    const total = 2 * CAP;
    const chunks: Uint8Array[] = [];
    let remaining = total;
    while (remaining > 0) {
      const next = Math.min(chunkSize, remaining);
      chunks.push(new Uint8Array(next));
      remaining -= next;
    }
    const req = new Request("http://localhost/v1/c/c", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: stream(chunks),
      // @ts-expect-error duplex is a Node/undici extension for streaming request bodies
      duplex: "half",
    });
    const result = applyBodyCap(req, { incoming }, CAP);
    expect(result).toBeInstanceOf(Request);
    const wrapped = result as Request;

    let caught: unknown;
    try {
      await readAll(wrapped.body!);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BaerlyError);
    expect((caught as BaerlyError).code).toBe("PayloadTooLarge");
    expect(incoming.resumed).toBe(1);
  });
});

describe("createApp + applyBodyCap real-wire regression", () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => {
          if (err !== undefined && err !== null) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
      server = undefined;
    }
  });

  test("chunked POST without content-length: client receives 413 cleanly", async () => {
    const storage = new MemoryStorage();
    const verifier: Verifier = async () => ({ tenantPrefix: "acme", identity: {} });
    const app = createApp({ app: "t", storage, verifier });

    server = createServer(getRequestListener(app.fetch));
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;

    // Stream ~2x cap of bytes in chunks. The middleware should trip
    // partway, drain the rest of the upload, and answer 413.
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const clientReq = httpRequest(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: "/v1/c/c",
          headers: {
            authorization: "Bearer dev",
            "content-type": "application/json",
            "transfer-encoding": "chunked",
          },
        },
        (clientRes) => {
          let body = "";
          clientRes.setEncoding("utf-8");
          clientRes.on("data", (chunk: string) => {
            body += chunk;
          });
          clientRes.on("end", () => {
            resolve({ status: clientRes.statusCode ?? 0, body });
          });
          clientRes.on("error", reject);
        },
      );
      clientReq.on("error", reject);

      const chunkSize = 64 * 1024;
      const total = 2 * CAP;
      let written = 0;
      const writeNext = (): void => {
        while (written < total) {
          const remaining = total - written;
          const buf = new Uint8Array(Math.min(chunkSize, remaining));
          const ok = clientReq.write(buf);
          written += buf.byteLength;
          if (!ok) {
            clientReq.once("drain", writeNext);
            return;
          }
        }
        clientReq.end();
      };
      writeNext();
    });

    expect(result.status).toBe(413);
    const parsed = JSON.parse(result.body) as { error: { code: string; message: string } };
    expect(parsed.error.code).toBe("PayloadTooLarge");
    expect(parsed.error.message).toBe(`Body exceeds ${CAP} bytes`);
  }, 10_000);
});
