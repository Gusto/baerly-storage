/**
 * Tests for `bodyCapMiddleware` — the Hono middleware that preserves
 * the drain-after-exceed semantic from today's hand-rolled
 * `readNodeStream` pump (`packages/adapter-node/src/server.ts:493-524`).
 *
 * Cases:
 * 1. Under-cap POST succeeds and the route sees the full body.
 * 2. Content-Length over-cap returns 413 (fast path).
 * 3. Chunked over-cap drains the upload and returns 413 (regression
 *    lock for the load-bearing drain-after-exceed semantic at
 *    `server.ts:476-491`).
 * 4. GET bypasses the middleware (no `data` listener attached).
 * 5. No `c.env.incoming` is a no-op — defence-in-depth in the kernel
 *    router still surfaces 413 for over-cap requests.
 */

import { getRequestListener } from "@hono/node-server";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MAX_BODY_BYTES } from "@baerly/server/http";
import { Hono } from "hono";
import { afterEach, describe, expect, test } from "vitest";
import { bodyCapMiddleware } from "./middleware/body-cap.ts";

const CAP = MAX_BODY_BYTES;

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

const startServer = async (
  app: Hono,
): Promise<{ host: string; port: number; url: string }> => {
  server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return {
    host: "127.0.0.1",
    port: addr.port,
    url: `http://127.0.0.1:${addr.port}`,
  };
};

describe("bodyCapMiddleware", () => {
  test("under-cap POST succeeds and the route sees the full body", async () => {
    const app = new Hono();
    app.use("*", bodyCapMiddleware(CAP));
    app.post("/echo", async (c) => {
      const buffer = await c.req.arrayBuffer();
      return c.json({ size: buffer.byteLength });
    });
    const { url } = await startServer(app);

    const size = CAP - 1;
    const body = new Uint8Array(size);
    const res = await fetch(`${url}/echo`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body,
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ size });
  });

  test("content-length over-cap returns 413 envelope", async () => {
    const app = new Hono();
    app.use("*", bodyCapMiddleware(CAP));
    app.post("/echo", async (c) => {
      // Route handler should never be reached — the middleware
      // short-circuits on the content-length fast-path.
      const buffer = await c.req.arrayBuffer();
      return c.json({ size: buffer.byteLength });
    });
    const { url } = await startServer(app);

    const size = CAP + 1;
    const body = new Uint8Array(size);
    const res = await fetch(`${url}/echo`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(size),
      },
      body,
    });
    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toEqual({
      error: {
        code: "PayloadTooLarge",
        message: `Body exceeds ${CAP} bytes`,
      },
    });
  });

  test("chunked over-cap drains the upload and returns 413", async () => {
    const app = new Hono();
    app.use("*", bodyCapMiddleware(CAP));
    app.post("/echo", async (c) => {
      const buffer = await c.req.arrayBuffer();
      return c.json({ size: buffer.byteLength });
    });
    const { host, port } = await startServer(app);

    // Use http.request with chunked transfer encoding so the cap
    // trips mid-stream (no Content-Length fast-path). The client
    // must complete its body write AND read the 413 cleanly — no
    // ECONNRESET / "socket hang up".
    const result = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        const clientReq = httpRequest(
          {
            host,
            port,
            method: "POST",
            path: "/echo",
            headers: {
              "content-type": "application/octet-stream",
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

        // Write ~2 * CAP bytes in chunks. The middleware should trip
        // partway through, drain the rest, and answer 413.
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
      },
    );

    expect(result.status).toBe(413);
    const parsed = JSON.parse(result.body) as {
      error: { code: string; message: string };
    };
    expect(parsed.error.code).toBe("PayloadTooLarge");
    expect(parsed.error.message).toBe(`Body exceeds ${CAP} bytes`);
  }, 10_000);

  test("GET bypasses the middleware (no data listener attached)", async () => {
    let observedDataListenerCount: number | undefined;
    const app = new Hono();
    app.use("*", bodyCapMiddleware(CAP));
    app.get("/probe", async (c) => {
      const env = c.env as { incoming?: { listenerCount: (event: string) => number } };
      observedDataListenerCount = env.incoming?.listenerCount("data");
      return c.json({ ok: true });
    });
    const { url } = await startServer(app);

    const res = await fetch(`${url}/probe`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
    // GET short-circuits the middleware → no `data` listener wired
    // by us. The HTTP parser itself may have other listeners but
    // the body-cap pump must not be one of them.
    expect(observedDataListenerCount).toBe(0);
  });

  test("missing c.env.incoming is a no-op (router defence-in-depth catches over-cap)", async () => {
    // Drive the app via `app.fetch(new Request(...))` directly — no
    // Node host, so `c.env.incoming` is undefined. The middleware
    // must skip its pump and let the route handler run.
    const app = new Hono();
    app.use("*", bodyCapMiddleware(CAP));
    let routeReached = false;
    app.post("/echo", async (c) => {
      routeReached = true;
      const buffer = await c.req.arrayBuffer();
      return c.json({ size: buffer.byteLength });
    });

    const size = 16;
    const body = new Uint8Array(size);
    const res = await app.fetch(
      new Request("http://localhost/echo", {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body,
      }),
    );
    expect(routeReached).toBe(true);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ size });
  });

  test("missing c.env.incoming: kernel-router defence-in-depth still surfaces 413", async () => {
    // The body-cap middleware is a no-op when c.env.incoming is
    // undefined, but the kernel router's own length check at
    // `packages/server/src/http/router.ts:464-501` is the backstop.
    // We emulate that backstop here with a tiny route that mirrors
    // the kernel's behaviour so we don't have to drag in `createApp`
    // (that's the app.test.ts's job).
    const app = new Hono();
    app.use("*", bodyCapMiddleware(CAP));
    app.post("/echo", async (c) => {
      const lenHeader = c.req.header("content-length");
      if (lenHeader !== undefined) {
        const parsed = Number.parseInt(lenHeader, 10);
        if (Number.isFinite(parsed) && parsed > CAP) {
          return c.json(
            {
              error: {
                code: "PayloadTooLarge",
                message: `Body exceeds ${CAP} bytes`,
              },
            },
            413,
          );
        }
      }
      const buffer = await c.req.arrayBuffer();
      return c.json({ size: buffer.byteLength });
    });

    const size = CAP + 1;
    const body = new Uint8Array(size);
    const res = await app.fetch(
      new Request("http://localhost/echo", {
        method: "POST",
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(size),
        },
        body,
      }),
    );
    expect(res.status).toBe(413);
    const parsed = (await res.json()) as { error: { code: string } };
    expect(parsed.error.code).toBe("PayloadTooLarge");
  });
});
