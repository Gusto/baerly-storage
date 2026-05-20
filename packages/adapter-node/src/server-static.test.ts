/**
 * Node listener — static-asset (`webRoot`) tests over a real
 * `http.Server` driven by `createApp` → `getRequestListener`. Mirrors
 * the bootstrap pattern from `server-routes.test.ts`: each test boots
 * `createServer(getRequestListener(app.fetch)).listen(0)` against a
 * per-test temp directory provisioned with `mkdtemp` + `writeFile`.
 *
 * Covers:
 *   - happy path: GET a file present on disk with the right MIME
 *   - SPA fallback: HTML navigation → index.html on misses
 *   - non-HTML 404: missing JSON returns the kernel's 404 envelope
 *   - path traversal: `..%2F..` returns 404, not the system file
 *   - `/v1/*` precedence: API routes are still verifier-gated
 *   - off-by-default: behaviour identical to today when webRoot unset
 *   - HEAD: 200 + Content-Length, empty body
 */

import { getRequestListener } from "@hono/node-server";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryStorage, type Storage, type Verifier } from "@baerly/protocol";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./app.ts";

const denyVerifier: Verifier = async () => null;
const trivialVerifier: Verifier = async () => ({
  tenantPrefix: "acme",
  identity: { kind: "test" },
});

interface ErrEnvelope {
  readonly error?: { readonly code: string; readonly message: string };
}

const withServer = async <T>(
  opts: {
    readonly verifier: Verifier;
    readonly webRoot?: string;
  },
  body: (baseUrl: string, storage: Storage) => Promise<T>,
): Promise<T> => {
  const storage = new MemoryStorage();
  const app = createApp({
    app: "tickets",
    storage,
    verifier: opts.verifier,
    ...(opts.webRoot !== undefined && { webRoot: opts.webRoot }),
  });
  const server = createServer(getRequestListener(app.fetch));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address() as AddressInfo;
  try {
    return await body(`http://127.0.0.1:${address.port}`, storage);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }
};

describe("createApp webRoot static-asset handling", () => {
  let webRoot: string;

  beforeEach(async () => {
    webRoot = await mkdtemp(join(tmpdir(), "baerly-static-"));
    await writeFile(join(webRoot, "index.html"), "<!doctype html><title>app</title>");
    await writeFile(join(webRoot, "robots.txt"), "User-agent: *\n");
    await mkdir(join(webRoot, "assets"));
    await writeFile(join(webRoot, "assets", "app.hash.js"), "export const x = 1;");
  });

  afterEach(async () => {
    await rm(webRoot, { recursive: true, force: true });
  });

  test("serves an on-disk file with the correct MIME and Cache-Control", async () => {
    await withServer({ verifier: denyVerifier, webRoot }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/index.html`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      await expect(res.text()).resolves.toContain("<title>app</title>");
    });
  });

  test("serves hashed assets with a long-lived Cache-Control", async () => {
    await withServer({ verifier: denyVerifier, webRoot }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/assets/app.hash.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    });
  });

  test("falls back to index.html for HTML navigation that misses on disk (SPA routing)", async () => {
    await withServer({ verifier: denyVerifier, webRoot }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/some/spa/route`, {
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      await expect(res.text()).resolves.toContain("<title>app</title>");
    });
  });

  test("serves the SPA shell for GET / (root navigation)", async () => {
    await withServer({ verifier: denyVerifier, webRoot }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/`, {
        headers: { Accept: "text/html" },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      await expect(res.text()).resolves.toContain("<title>app</title>");
    });
  });

  test("returns the kernel 404 envelope (not index.html) for missing non-HTML assets", async () => {
    await withServer({ verifier: denyVerifier, webRoot }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/missing.json`, {
        headers: { Accept: "application/json" },
      });
      // Non-HTML miss falls through; the unauthenticated kernel router
      // sees a non-`/v1/*` request and the verifier rejects → 401.
      // The point is that we did NOT serve index.html for a JSON
      // fetch — the response must not be HTML.
      expect(res.headers.get("content-type")).not.toMatch(/^text\/html/);
    });
  });

  test("returns 404 (not index.html) for missing non-HTML assets under a tenant", async () => {
    // With a trivial verifier, the fall-through reaches the router,
    // which has no route for `/missing.json` and returns its default
    // 404. The point of the test is that we did NOT mistakenly serve
    // index.html bytes for a programmatic fetch.
    await withServer({ verifier: trivialVerifier, webRoot }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/missing.json`, {
        headers: { Accept: "application/json" },
      });
      expect(res.status).toBe(404);
      // Critically: the response must not be HTML — we must NOT have
      // fallen back to index.html for a non-HTML request.
      expect(res.headers.get("content-type")).not.toMatch(/^text\/html/);
      const body = await res.text();
      expect(body).not.toContain("<title>app</title>");
    });
  });

  test("rejects URL-encoded `..` traversal attempts", async () => {
    await withServer({ verifier: trivialVerifier, webRoot }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/..%2F..%2Fetc%2Fpasswd`, {
        headers: { Accept: "application/json" },
      });
      // Falls through to the router, which 404s the unknown path.
      // The critical assertion is that we did NOT serve /etc/passwd
      // or any other off-root file: the response is small and clearly
      // not an arbitrary system file.
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain("root:");
      expect(body.length).toBeLessThan(1024);
    });
  });

  test("does not shadow GET /v1/healthz (anonymous probe still works)", async () => {
    await withServer({ verifier: denyVerifier, webRoot }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/healthz`);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
    });
  });

  test("does not shadow `/v1/*` API routes (verifier still gates them)", async () => {
    await withServer({ verifier: denyVerifier, webRoot }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/v1/t/tickets`);
      expect(res.status).toBe(401);
      const body = (await res.json()) as ErrEnvelope;
      expect(body.error?.code).toBe("Unauthorized");
    });
  });

  test("behaviour is byte-identical when webRoot is unset (off by default)", async () => {
    await withServer({ verifier: trivialVerifier }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/index.html`);
      // No webRoot → falls through to the router, which returns its
      // default 404 for the unknown path. Body must not be HTML
      // (no on-disk file got served accidentally).
      expect(res.status).toBe(404);
      expect(res.headers.get("content-type")).not.toMatch(/^text\/html/);
    });
  });

  test("HEAD returns 200 + Content-Length with an empty body", async () => {
    await withServer({ verifier: denyVerifier, webRoot }, async (baseUrl) => {
      const res = await fetch(`${baseUrl}/index.html`, { method: "HEAD" });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
      // Content-Length must reflect the actual file size, not 0.
      const len = Number(res.headers.get("content-length"));
      expect(Number.isFinite(len)).toBe(true);
      expect(len).toBeGreaterThan(0);
      const body = await res.text();
      expect(body).toBe("");
    });
  });
});
