import { type DevLandingOptions } from "@baerly/dev";
import { MAX_BODY_BYTES } from "@baerly/server/http";
import { Hono } from "hono";
import { bodyCapMiddleware } from "./middleware/body-cap.ts";
import { devLandingMiddleware } from "./middleware/dev-landing.ts";
import { staticAssetsMiddleware } from "./middleware/static-assets.ts";
import { type CreateFetchHandlerOptions, createFetchHandler } from "./server.ts";

/**
 * Options for {@link createApp}.
 *
 * Extends {@link CreateFetchHandlerOptions} with the Node-host
 * affordances mounted ahead of the cascade.
 */
export interface CreateAppOptions extends CreateFetchHandlerOptions {
  /**
   * Optional static-asset root. When set, the app serves files from
   * this directory for any GET/HEAD request that misses `/v1/*`. See
   * {@link staticAssetsMiddleware} for details (MIME mapping, SPA
   * fallback, traversal rejection).
   */
  readonly webRoot?: string;
  /**
   * Opt-in dev affordance. When set, `GET /` returns a human-readable
   * HTML landing page linking to the configured UI URL, and
   * `GET /favicon.ico` returns 204 No Content. Bypasses verifier and
   * observability so it doesn't flood logs. Leave unset in production.
   */
  readonly dev?: DevLandingOptions;
}

/**
 * Build a Hono app that serves the baerly cascade plus Node-host
 * middleware (dev-landing when `dev` is set, then static-assets when
 * `webRoot` is set, then body-cap, then the cascade).
 *
 * The returned app's `.fetch` is `(req: Request) => Promise<Response>`
 * — feed it to `@hono/node-server`'s `serve({ fetch })`, mount under
 * another Hono app via `app.route(prefix, baerlyApp)`, or convert
 * to a Node listener via `getRequestListener(baerlyApp.fetch)`.
 */
export function createApp(opts: CreateAppOptions): Hono {
  const fetchHandler = createFetchHandler(opts);
  const app = new Hono();

  // Order: dev-landing → static-assets → body-cap → cascade. The
  // dev short-circuit must precede static-assets so a `webRoot` that
  // happens to contain `index.html` / `favicon.ico` doesn't shadow
  // the dev affordance.
  if (opts.dev !== undefined) {
    app.use("*", devLandingMiddleware({ dev: opts.dev }));
  }
  if (opts.webRoot !== undefined) {
    app.use("*", staticAssetsMiddleware({ webRoot: opts.webRoot }));
  }

  app.use("*", bodyCapMiddleware(MAX_BODY_BYTES));

  app.all("*", async (c) => fetchHandler(c.req.raw));

  return app;
}
