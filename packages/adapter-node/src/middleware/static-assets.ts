import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, MiddlewareHandler } from "hono";

interface Options {
  readonly webRoot: string;
}

/**
 * Serve files from `webRoot` for GET/HEAD requests that miss `/v1/*`,
 * via `@hono/node-server/serve-static`.
 *
 * That handler owns MIME types, `Content-Length`, `Last-Modified`,
 * Range requests, and request-path validation, falling through to the
 * cascade's 404 envelope on a rejected path. Hono hands it the path
 * already `decodeURI`'d, so `%20` and UTF-8 escapes name ordinary
 * files. What still holds a `%` after that decode is an encoded
 * reserved character (`%2F`, `%3F`, `%23`) or a literal `%` (`%25`),
 * and those are rejected, as are `.`/`..` segments and repeated or
 * back-slashes. This wrapper adds what it does not:
 *
 * - Dotfiles and dot-directories (`/.env`, `/.git/config`) fall
 *   through, except `/.well-known/*`.
 * - A file whose real path (after symlinks) leaves `webRoot` falls
 *   through.
 * - HTML navigation (`Accept: text/html`) that misses on disk gets
 *   `<webRoot>/index.html` (SPA shell). Other misses fall through.
 * - `Cache-Control`: `public, max-age=3600` under `assets/` (Vite's
 *   hashed bundles), `no-cache` everywhere else.
 */
export function staticAssetsMiddleware(opts: Options): MiddlewareHandler {
  const root = resolve(opts.webRoot);
  const onFound = (path: string, c: Context): void => {
    const rel = relative(root, resolve(path)).split(sep).join("/");
    c.header("Cache-Control", rel.startsWith("assets/") ? "public, max-age=3600" : "no-cache");
  };
  const files = serveStatic({
    root,
    // `serveStatic` joins the validated request path onto `root`, so
    // rejecting here (with a path that cannot stat) is the one place
    // that sees the final filesystem target before it is opened.
    rewriteRequestPath: (path) => (servesFromRoot(root, path) ? path : UNSERVABLE),
    onFound,
  });
  const shell = serveStatic({ root, path: "index.html", onFound });

  return async (c, next) => {
    const method = c.req.method;
    if ((method !== "GET" && method !== "HEAD") || c.req.path.startsWith("/v1/")) {
      return next();
    }
    if (hasDotSegment(c.req.path)) {
      return next();
    }
    // Hono's `Next` resolves to void, so a response produced inside it
    // has to land on `c.res` rather than be returned.
    return files(c, async () => {
      if (
        c.req.header("accept")?.includes("text/html") !== true ||
        !servesFromRoot(root, "index.html")
      ) {
        await next();
        return;
      }
      const res = await shell(c, next);
      if (res !== undefined) {
        c.res = res;
      }
    });
  };
}

/** A path `statSync` rejects (NUL byte), so `serveStatic` treats it as a miss. */
const UNSERVABLE = "/\0";

/** `.well-known` is the one dot-directory a web app is expected to publish (RFC 8615). */
function hasDotSegment(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith(".") && segment !== ".well-known");
}

/**
 * True when `requestPath` (already validated by `serveStatic`) names a
 * missing file, or an existing file or directory whose real path stays
 * inside `root`. For a directory, its `index.html` is checked too,
 * since that is what `serveStatic` opens.
 */
function servesFromRoot(root: string, requestPath: string): boolean {
  const target = join(root, requestPath);
  const realRoot = realpathOrNull(root);
  if (realRoot === null) {
    return true;
  }
  const candidates = [target];
  if (isDirectory(target)) {
    candidates.push(join(target, "index.html"));
  }
  return candidates.every((candidate) => {
    const real = realpathOrNull(candidate);
    if (real === null) {
      return true;
    }
    const rel = relative(realRoot, real);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
