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
 *   - containment: raw `..` / `%`-encoded traversal, symlinks that
 *     leave `webRoot`, and dotfiles all fall through to the 404
 */

import { getRequestListener } from "@hono/node-server";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage } from "@baerly/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createApp, type CreateAppOptions } from "./app.ts";
import { trivialVerifier, denyVerifier } from "../../../tests/fixtures/test-verifier.ts";

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

  test("sends Last-Modified and answers a Range request with 206", async () => {
    const url = await startApp({
      app: "tickets",
      storage: new MemoryStorage(),
      verifier: denyVerifier,
      webRoot,
    });
    const res = await fetch(`${url}/assets/app.hash.js`, { headers: { Range: "bytes=0-5" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 0-5/19");
    expect(res.headers.get("last-modified")).not.toBeNull();
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    await expect(res.text()).resolves.toBe("export");
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

/**
 * GET `path` verbatim. `fetch()` runs the WHATWG URL parser, which
 * collapses `..` and `%2e%2e` segments before the request leaves the
 * client, so traversal probes go over `node:http` instead.
 */
const rawGet = (
  baseUrl: string,
  path: string,
  headers: Record<string, string> = { accept: "application/json" },
): Promise<{ status: number; body: string }> => {
  const { hostname, port } = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
};

describe("staticAssetsMiddleware containment", () => {
  const SECRET = "outside-webroot-secret";
  let base: string;
  let webRoot: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "baerly-static-contain-"));
    webRoot = join(base, "web");
    const outside = join(base, "outside");
    await mkdir(join(webRoot, "assets"), { recursive: true });
    await mkdir(join(webRoot, ".well-known"));
    await mkdir(join(webRoot, ".git"));
    await mkdir(outside);
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>app</title>");
    await writeFile(join(webRoot, "robots.txt"), "User-agent: *\n");
    await writeFile(join(webRoot, ".env"), SECRET);
    await writeFile(join(webRoot, ".git", "config"), SECRET);
    await writeFile(join(webRoot, ".well-known", "security.txt"), "Contact: x\n");
    await writeFile(join(outside, "secret.txt"), SECRET);
    await writeFile(join(outside, "index.html"), SECRET);
    await symlink(join(outside, "secret.txt"), join(webRoot, "leak.txt"));
    await symlink(outside, join(webRoot, "linked"));
    await symlink(join(webRoot, "robots.txt"), join(webRoot, "alias.txt"));
  });

  afterEach(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const start = (): Promise<string> =>
    startApp({
      app: "tickets",
      storage: new MemoryStorage(),
      verifier: trivialVerifier,
      webRoot,
    });

  // A bare `..` or `%2e%2e` segment never reaches the middleware:
  // `@hono/node-server` builds the request URL with the WHATWG parser,
  // which resolves dot segments first (`/%2e%2e/x` arrives as `/x`).
  // These probes keep the dots inside one segment, or encode them past
  // that parser.
  test.each([
    "/%2E%2E%2Foutside%2Fsecret.txt",
    "/assets/..%2f..%2foutside%2fsecret.txt",
    "/..%5coutside%5csecret.txt",
    "/%252e%252e%252foutside%252fsecret.txt",
    "//outside/secret.txt",
  ])("does not serve a traversal probe: %s", async (path) => {
    const url = await start();
    const res = await rawGet(url, path);
    expect(res.status).toBe(404);
    expect(res.body).not.toContain(SECRET);
  });

  test.each(["/leak.txt", "/linked/secret.txt", "/linked/", "/linked"])(
    "does not follow a symlink out of webRoot: %s",
    async (path) => {
      const url = await start();
      const res = await rawGet(url, path);
      expect(res.status).toBe(404);
      expect(res.body).not.toContain(SECRET);
    },
  );

  test.each([
    ["/my%20file.txt", "space"],
    ["/caf%C3%A9.txt", "utf8"],
  ])("serves a percent-encoded filename: %s", async (path, body) => {
    await writeFile(join(webRoot, "my file.txt"), "space");
    await writeFile(join(webRoot, "café.txt"), "utf8");
    const url = await start();
    const res = await rawGet(url, path);
    expect(res.status).toBe(200);
    expect(res.body).toBe(body);
  });

  test("does not serve a path holding a literal `%` (`%25`)", async () => {
    await writeFile(join(webRoot, "100%.txt"), "percent");
    const url = await start();
    const res = await rawGet(url, "/100%25.txt");
    expect(res.status).toBe(404);
    expect(res.body).not.toContain("percent");
  });

  test("serves a symlink that stays inside webRoot", async () => {
    const url = await start();
    const res = await rawGet(url, "/alias.txt");
    expect(res.status).toBe(200);
    expect(res.body).toBe("User-agent: *\n");
  });

  test.each(["/.env", "/.git/config", "/assets/.env"])(
    "does not serve a dotfile: %s",
    async (path) => {
      await writeFile(join(webRoot, "assets", ".env"), SECRET);
      const url = await start();
      const res = await rawGet(url, path);
      expect(res.status).toBe(404);
      expect(res.body).not.toContain(SECRET);
    },
  );

  test("a dotfile is a 404 even for HTML navigation (no SPA shell)", async () => {
    const url = await start();
    const res = await rawGet(url, "/.env", { accept: "text/html" });
    expect(res.status).toBe(404);
    expect(res.body).not.toContain(SECRET);
  });

  test("serves /.well-known/*", async () => {
    const url = await start();
    const res = await rawGet(url, "/.well-known/security.txt");
    expect(res.status).toBe(200);
    expect(res.body).toBe("Contact: x\n");
  });

  test("an escaping symlink is a miss, so HTML navigation still gets the SPA shell", async () => {
    const url = await start();
    const res = await rawGet(url, "/leak.txt", { accept: "text/html" });
    expect(res.status).toBe(200);
    expect(res.body).toContain("<title>app</title>");
    expect(res.body).not.toContain(SECRET);
  });

  test.each(["/missing/spa/route", "/index.html", "/"])(
    "does not serve an escaping index.html symlink for HTML navigation: %s",
    async (path) => {
      await rm(join(webRoot, "index.html"));
      await symlink(join(base, "outside", "index.html"), join(webRoot, "index.html"));
      const url = await start();
      const res = await rawGet(url, path, { accept: "text/html" });
      expect(res.status).toBe(404);
      expect(res.body).not.toContain(SECRET);
    },
  );

  test("serves an in-root index.html symlink as the SPA shell", async () => {
    await rm(join(webRoot, "index.html"));
    await writeFile(join(webRoot, "shell.html"), "<!doctype html><title>linked app</title>");
    await symlink(join(webRoot, "shell.html"), join(webRoot, "index.html"));
    const url = await start();
    const res = await rawGet(url, "/missing/spa/route", { accept: "text/html" });
    expect(res.status).toBe(200);
    expect(res.body).toContain("<title>linked app</title>");
  });
});
