/**
 * Tests for `staticAssetsMiddleware` — the Hono middleware mounted by
 * `createApp` when `opts.webRoot` is set. Mirrors the most load-bearing
 * cases from `server-static.test.ts`, with focused per-middleware unit
 * coverage of MIME mapping, SPA fallback, and traversal rejection.
 *
 * Covers:
 *   - happy path: GET an on-disk file with the right MIME / Cache-Control
 *   - off-by-default: no middleware when `webRoot` is unset
 *   - traversal rejection (`..%2F..`)
 *   - SPA fallback for HTML navigation
 *   - `/v1/*` precedence (middleware short-circuits on prefix)
 */

import { getRequestListener } from "@hono/node-server";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage, type Verifier } from "@baerly/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createApp, type CreateAppOptions } from "./app.ts";

const denyVerifier: Verifier = async () => null;
const trivialVerifier: Verifier = async () => ({
  tenantPrefix: "acme",
  identity: { kind: "test" },
});

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

describe("staticAssetsMiddleware via createApp", () => {
  let webRoot: string;

  beforeEach(async () => {
    webRoot = await mkdtemp(join(tmpdir(), "baerly-app-static-"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>app</title>");
    await mkdir(join(webRoot, "assets"));
    await writeFile(join(webRoot, "assets", "app.hash.js"), "export const x = 1;");
  });

  afterEach(async () => {
    await rm(webRoot, { recursive: true, force: true });
  });

  test("serves an on-disk file with the correct MIME and Cache-Control", async () => {
    const url = await startApp({
      app: "tickets",
      storage: new MemoryStorage(),
      verifier: denyVerifier,
      webRoot,
    });
    const res = await fetch(`${url}/index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    await expect(res.text()).resolves.toContain("<title>app</title>");
  });

  test("is off by default when webRoot is unset (cascade owns the 404)", async () => {
    const url = await startApp({
      app: "tickets",
      storage: new MemoryStorage(),
      verifier: trivialVerifier,
    });
    const res = await fetch(`${url}/index.html`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).not.toMatch(/^text\/html/);
    const body = await res.text();
    expect(body).not.toContain("<title>app</title>");
  });

  test("rejects URL-encoded `..` traversal attempts", async () => {
    const url = await startApp({
      app: "tickets",
      storage: new MemoryStorage(),
      verifier: trivialVerifier,
      webRoot,
    });
    const res = await fetch(`${url}/..%2F..%2Fetc%2Fpasswd`, {
      headers: { Accept: "application/json" },
    });
    // Falls through to the cascade, which 404s the unknown path.
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("root:");
    expect(body.length).toBeLessThan(1024);
  });

  test("falls back to index.html for HTML navigation that misses on disk", async () => {
    const url = await startApp({
      app: "tickets",
      storage: new MemoryStorage(),
      verifier: denyVerifier,
      webRoot,
    });
    const res = await fetch(`${url}/some/spa/route`, {
      headers: { Accept: "text/html,application/xhtml+xml" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    await expect(res.text()).resolves.toContain("<title>app</title>");
  });

  test("does not shadow GET /v1/healthz (middleware skips on /v1/* prefix)", async () => {
    const url = await startApp({
      app: "tickets",
      storage: new MemoryStorage(),
      verifier: denyVerifier,
      webRoot,
    });
    const res = await fetch(`${url}/v1/healthz`);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true });
  });
});
