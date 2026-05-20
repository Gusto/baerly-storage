import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  extname,
  relative as relativePath,
  resolve as resolvePath,
  sep as pathSep,
} from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { MiddlewareHandler } from "hono";

/**
 * Map a file extension to its `Content-Type`. The set is deliberately
 * small — every entry corresponds to something Vite or a typical SPA
 * pipeline actually emits. Unknown extensions fall back to
 * `application/octet-stream`, which keeps the browser from sniffing
 * untrusted bytes as HTML.
 */
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

interface Options {
  readonly webRoot: string;
}

/**
 * Serve files from `webRoot` for GET/HEAD requests that miss `/v1/*`.
 *
 * HTML navigation (`Accept: text/html`) that misses an on-disk file
 * falls back to `<webRoot>/index.html` (SPA shell). Non-HTML misses
 * pass through `next()` so the cascade emits its 404 envelope.
 *
 * Path resolution rejects `..` segments and absolute paths so the
 * middleware can't escape `webRoot`. Pure `node:fs` + `node:path` —
 * no new dependency.
 *
 * The response body is built as
 * `new Response(Readable.toWeb(createReadStream(...)))`, keeping the
 * middleware Fetch-shaped so it composes cleanly with other Hono
 * middleware. The actual byte pump runs through
 * `@hono/node-server`'s response writer, which handles backpressure +
 * client-disconnect cleanly.
 *
 * Mirrors the imperative `serveStaticAsset` in
 * `packages/adapter-node/src/server.ts` (which the hand-rolled
 * `handle()` bridge still uses until T04 cuts over).
 */
export function staticAssetsMiddleware(opts: Options): MiddlewareHandler {
  return async (c, next) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") {
      return next();
    }
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/v1/")) {
      return next();
    }

    const resolved = resolveUnderWebRoot(path, opts.webRoot);
    if (resolved === null) {
      // Traversal / absolute path / NUL byte / malformed encoding.
      // Fall through to the cascade.
      return next();
    }

    const primary = await statFile(resolved);
    let target = resolved;
    let stats = primary;
    if (stats === null) {
      if (!wantsHtmlFallback(c.req.header("accept"))) {
        return next();
      }
      const indexPath = resolvePath(opts.webRoot, "index.html");
      const fallback = await statFile(indexPath);
      if (fallback === null) {
        return next();
      }
      target = indexPath;
      stats = fallback;
    }

    const ext = extname(target).toLowerCase();
    const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
    // Vite emits long-lived hashed bundles under `assets/`; everything
    // else (including `index.html`, which is fetched on every nav)
    // wants a fresh copy.
    const relForCache = relativePath(opts.webRoot, target).split(pathSep).join("/");
    const cacheControl =
      relForCache.startsWith("assets/") && target !== resolvePath(opts.webRoot, "index.html")
        ? "public, max-age=3600"
        : "no-cache";

    const headers: Record<string, string> = {
      "content-type": contentType,
      "content-length": String(stats.size),
      "cache-control": cacheControl,
    };

    if (method === "HEAD") {
      return new Response(null, { status: 200, headers });
    }

    const nodeWeb = Readable.toWeb(createReadStream(target)) as unknown as NodeReadableStream<
      Uint8Array
    >;
    return new Response(nodeWeb as unknown as ReadableStream<Uint8Array>, {
      status: 200,
      headers,
    });
  };
}

/**
 * Resolve a request path under `webRoot` without allowing `..` escape
 * or absolute-segment hijacking. Returns the resolved absolute path on
 * success, or `null` when the request should fall through (traversal
 * attempt, NUL byte, malformed URL encoding).
 */
function resolveUnderWebRoot(reqPath: string, webRoot: string): string | null {
  let relative = reqPath;
  if (relative === "" || relative === "/") {
    relative = "/index.html";
  } else if (relative.endsWith("/")) {
    relative = `${relative}index.html`;
  }

  // Reject NUL bytes immediately — no filesystem call should ever see
  // one.
  if (relative.includes("\0")) {
    return null;
  }

  // Walk the segments, URL-decoding each one in isolation. Decoding
  // the whole path string would let `%2F` (`/`) sneak through as a
  // segment separator that bypasses the per-segment `..` check.
  const segments: string[] = [];
  for (const raw of relative.split("/")) {
    if (raw === "") {
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (decoded === "" || decoded === ".") {
      continue;
    }
    if (decoded === "..") {
      return null;
    }
    if (decoded.includes("\0")) {
      return null;
    }
    if (decoded.includes("/") || decoded.includes("\\")) {
      return null;
    }
    segments.push(decoded);
  }

  const resolved = resolvePath(webRoot, ...segments);
  const rel = relativePath(webRoot, resolved);
  // `path.relative` returns `""` when `resolved === webRoot` (the
  // directory itself) and a `..`-prefixed path when `resolved` escapes
  // `webRoot`. Both are rejected.
  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${pathSep}`)) {
    return null;
  }
  return resolved;
}

/**
 * Determine whether the request should fall back to `index.html` on a
 * filesystem miss. Browsers send `Accept: text/html,...` for SPA
 * navigations; programmatic `fetch()` calls for missing JSON / image
 * assets do not, and they get the kernel's 404 envelope instead.
 */
function wantsHtmlFallback(accept: string | undefined): boolean {
  if (typeof accept !== "string") {
    return false;
  }
  return accept.includes("text/html");
}

/**
 * `fs.stat` that returns `null` for the missing-file cases that this
 * handler treats as a fall-through (ENOENT / ENOTDIR / non-file).
 * Other errors (EACCES, EIO, ...) propagate.
 */
async function statFile(target: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    const stats = await stat(target);
    return stats.isFile() ? stats : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return null;
    }
    throw error;
  }
}
