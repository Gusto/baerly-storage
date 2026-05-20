import { MAX_BODY_BYTES } from "@baerly/server/http";
import { Hono } from "hono";
import { bodyCapMiddleware } from "./middleware/body-cap.ts";
import { type CreateFetchHandlerOptions, createFetchHandler } from "./server.ts";

/**
 * Options for {@link createApp}.
 *
 * Same shape as `CreateFetchHandlerOptions` today — adds room for
 * `dev` / `webRoot` middleware mounting in subsequent tickets.
 */
export type CreateAppOptions = CreateFetchHandlerOptions;

/**
 * Build a Hono app that serves the baerly cascade plus Node-host
 * middleware (body-cap, plus dev-landing / static-assets in later
 * tickets when opted in).
 *
 * The returned app's `.fetch` is `(req: Request) => Promise<Response>`
 * — feed it to `@hono/node-server`'s `serve({ fetch })`, mount under
 * another Hono app via `app.route(prefix, baerlyApp)`, or convert
 * to a Node listener via `getRequestListener(baerlyApp.fetch)`.
 */
export function createApp(opts: CreateAppOptions): Hono {
  const fetchHandler = createFetchHandler(opts);
  const app = new Hono();

  app.use("*", bodyCapMiddleware(MAX_BODY_BYTES));

  app.all("*", async (c) => fetchHandler(c.req.raw));

  return app;
}
