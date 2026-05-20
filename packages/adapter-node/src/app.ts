import { MAX_BODY_BYTES } from "@baerly/server/http";
import { Hono } from "hono";
import { bodyCapMiddleware } from "./middleware/body-cap.ts";
import { staticAssetsMiddleware } from "./middleware/static-assets.ts";
import { type CreateFetchHandlerOptions, createFetchHandler } from "./server.ts";

/**
 * Options for {@link createApp}.
 *
 * Extends {@link CreateFetchHandlerOptions} with the Node-host
 * affordances mounted ahead of the cascade. `dev` (the landing page)
 * lands in T03.
 */
export interface CreateAppOptions extends CreateFetchHandlerOptions {
  /**
   * Optional static-asset root. When set, the app serves files from
   * this directory for any GET/HEAD request that misses `/v1/*`. See
   * {@link staticAssetsMiddleware} for details (MIME mapping, SPA
   * fallback, traversal rejection).
   */
  readonly webRoot?: string;
}

/**
 * Build a Hono app that serves the baerly cascade plus Node-host
 * middleware (body-cap, plus static-assets when `webRoot` is set, plus
 * dev-landing in a later ticket).
 *
 * The returned app's `.fetch` is `(req: Request) => Promise<Response>`
 * — feed it to `@hono/node-server`'s `serve({ fetch })`, mount under
 * another Hono app via `app.route(prefix, baerlyApp)`, or convert
 * to a Node listener via `getRequestListener(baerlyApp.fetch)`.
 */
export function createApp(opts: CreateAppOptions): Hono {
  const fetchHandler = createFetchHandler(opts);
  const app = new Hono();

  // Order: dev-landing (T03) → static-assets → body-cap → cascade.
  if (opts.webRoot !== undefined) {
    app.use("*", staticAssetsMiddleware({ webRoot: opts.webRoot }));
  }

  app.use("*", bodyCapMiddleware(MAX_BODY_BYTES));

  app.all("*", async (c) => fetchHandler(c.req.raw));

  return app;
}
