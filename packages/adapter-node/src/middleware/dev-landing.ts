import { type DevLandingOptions, renderDevLanding } from "@baerly/dev";
import type { MiddlewareHandler } from "hono";

interface Options {
  readonly dev: DevLandingOptions;
}

/**
 * Opt-in dev landing-page short-circuit. Serves `GET /` with a
 * human-readable HTML page that links to the configured UI URL, and
 * `GET /favicon.ico` with 204 No Content. Bypasses verifier and
 * observability so it doesn't flood logs in dev.
 *
 * Other methods and other paths fall through to the cascade. Mounted
 * by {@link createApp} (in `app.ts`) ahead of `staticAssetsMiddleware`
 * so the dev short-circuit wins over any on-disk `index.html` /
 * `favicon.ico` that might live in `webRoot`.
 *
 * Mirrors the imperative dev-landing block in
 * `packages/adapter-node/src/server.ts` (which the hand-rolled
 * `handle()` bridge still uses until the bridge cutover).
 */
export function devLandingMiddleware(opts: Options): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.method !== "GET") {
      return next();
    }
    const path = new URL(c.req.url).pathname;
    if (path === "/") {
      const body = renderDevLanding(opts.dev);
      return new Response(body, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          // Buffer.byteLength (not body.length) — the rendered HTML
          // may contain multi-byte UTF-8 characters.
          "content-length": String(Buffer.byteLength(body)),
        },
      });
    }
    if (path === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }
    return next();
  };
}
