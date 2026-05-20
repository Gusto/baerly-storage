/**
 * Tests for `devLandingMiddleware` — the Hono middleware mounted by
 * `createApp` when `opts.dev` is set. Mirrors the load-bearing cases
 * from `server-routes.test.ts`'s "createApp dev landing" block,
 * with focused per-middleware unit coverage.
 *
 * Covers:
 *   - off-by-default when `opts.dev` is unset
 *   - GET / returns 200 HTML with the right content-length
 *   - GET /favicon.ico returns 204 No Content
 *   - POST / falls through (method is not GET)
 *   - GET /unrelated falls through (path is not handled)
 *   - precedence: dev wins over static-assets for `/favicon.ico`
 */

import { getRequestListener } from "@hono/node-server";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDevLanding } from "@baerly/dev";
import { MemoryStorage, type Verifier } from "@baerly/protocol";
import { afterEach, describe, expect, test } from "vitest";
import { createApp, type CreateAppOptions } from "./app.ts";

const denyVerifier: Verifier = async () => null;

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

const startApp = async (opts: CreateAppOptions): Promise<string> => {
  const app = createApp(opts);
  server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address() as AddressInfo;
  return `http://127.0.0.1:${addr.port}`;
};

describe("devLandingMiddleware via createApp", () => {
  test("off-by-default: GET / falls through when opts.dev is unset", async () => {
    // No `dev`, no `webRoot` — the cascade owns the request. The
    // deny verifier short-circuits `/` with 401, proving the dev
    // middleware did not run (otherwise we'd see 200 HTML).
    const app = createApp({
      app: "tickets",
      storage: new MemoryStorage(),
      verifier: denyVerifier,
    });
    const res = await app.fetch(new Request("http://localhost/"));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).not.toMatch(/^text\/html/);
  });

  test("GET / returns 200 HTML with the right content-length", async () => {
    const dev = { app: "tickets", uiUrl: "http://localhost:5173" };
    const app = createApp({
      app: "tickets",
      storage: new MemoryStorage(),
      verifier: denyVerifier,
      dev,
    });
    const res = await app.fetch(new Request("http://localhost/"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const expectedBody = renderDevLanding(dev);
    expect(res.headers.get("content-length")).toBe(String(Buffer.byteLength(expectedBody)));
    const body = await res.text();
    expect(body).toBe(expectedBody);
    expect(body).toContain("<code>tickets</code>");
    expect(body).toContain('href="http://localhost:5173"');
  });

  test("GET /favicon.ico returns 204 with no body", async () => {
    const app = createApp({
      app: "tickets",
      storage: new MemoryStorage(),
      verifier: denyVerifier,
      dev: { app: "tickets", uiUrl: "http://localhost:5173" },
    });
    const res = await app.fetch(new Request("http://localhost/favicon.ico"));
    expect(res.status).toBe(204);
    // 204 must not carry a content-length per RFC 9110; the Response
    // ctor with a null body omits the header.
    expect(res.headers.get("content-length")).toBeNull();
    await expect(res.text()).resolves.toBe("");
  });

  test("POST / falls through to the cascade (method must be GET)", async () => {
    const app = createApp({
      app: "tickets",
      storage: new MemoryStorage(),
      verifier: denyVerifier,
      dev: { app: "tickets", uiUrl: "http://localhost:5173" },
    });
    const res = await app.fetch(new Request("http://localhost/", { method: "POST", body: "" }));
    // denyVerifier answers 401 — the dev short-circuit is GET-only.
    expect(res.status).toBe(401);
  });

  test("GET /unrelated falls through (path is not / or /favicon.ico)", async () => {
    const app = createApp({
      app: "tickets",
      storage: new MemoryStorage(),
      verifier: denyVerifier,
      dev: { app: "tickets", uiUrl: "http://localhost:5173" },
    });
    const res = await app.fetch(new Request("http://localhost/unrelated"));
    // Falls through; denyVerifier turns it into 401.
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).not.toMatch(/^text\/html/);
  });

  test("precedence: dev wins over static-assets for GET /favicon.ico", async () => {
    // Mount BOTH `dev` and `webRoot`. The temp webRoot contains a
    // distinct `favicon.ico` payload; the dev middleware must short-
    // circuit with 204 BEFORE static-assets has a chance to serve
    // the on-disk file. This is the load-bearing precedence
    // assertion the bridge cutover (T04) needs to keep passing.
    const webRoot = await mkdtemp(join(tmpdir(), "baerly-dev-precedence-"));
    try {
      await writeFile(join(webRoot, "index.html"), "<!doctype html><title>on-disk</title>");
      await writeFile(join(webRoot, "favicon.ico"), "ON-DISK-FAVICON-BYTES");

      const url = await startApp({
        app: "tickets",
        storage: new MemoryStorage(),
        verifier: denyVerifier,
        webRoot,
        dev: { app: "tickets", uiUrl: "http://localhost:5173" },
      });

      // /favicon.ico: dev wins → 204 empty, NOT the on-disk bytes.
      const favRes = await fetch(`${url}/favicon.ico`);
      expect(favRes.status).toBe(204);
      await expect(favRes.text()).resolves.toBe("");

      // / : dev wins → the rendered landing HTML, NOT the on-disk
      // `<title>on-disk</title>`.
      const rootRes = await fetch(`${url}/`);
      expect(rootRes.status).toBe(200);
      expect(rootRes.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const body = await rootRes.text();
      expect(body).toContain("<code>tickets</code>");
      expect(body).not.toContain("on-disk");
    } finally {
      await rm(webRoot, { recursive: true, force: true });
    }
  });
});
