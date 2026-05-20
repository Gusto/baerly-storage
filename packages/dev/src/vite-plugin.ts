import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import type { Plugin } from "vite";
import { createApp } from "@baerly/adapter-node";
import { Db } from "@baerly/server";
import { sharedSecret } from "@baerly/server/auth";
import { type DevBannerHint, printDevBanner } from "./dev-banner.ts";
import { ensureTable } from "./ensure-table.ts";
import { LocalFsStorage } from "./local-fs.ts";

export interface BaerlyDevOptions {
  /** App namespace (matches createApp's `app`). */
  readonly app: string;
  /** Tenant namespace passed to ensureTable + sharedSecret. */
  readonly tenant: string;
  /** Shared-secret token; clients send `Authorization: Bearer <secret>`. */
  readonly secret: string;
  /** Absolute path to the data directory for LocalFsStorage. */
  readonly dataDir: string;
  /** Tables to ensure() at startup. */
  readonly tables: readonly string[];
  /** Optional async seed callback, invoked after ensureTable, before mount. */
  readonly seed?: (db: Db) => Promise<void>;
  /** Extra hints appended to the dev banner. */
  readonly hints?: readonly DevBannerHint[];
  /** Set to false to suppress the dev banner. Default: true. */
  readonly banner?: boolean;
}

const isV1Path = (url: string): boolean =>
  url === "/v1" || url.startsWith("/v1/") || url.startsWith("/v1?");

export function baerlyDev(opts: BaerlyDevOptions): Plugin {
  return {
    name: "baerly-dev",
    apply: "serve",
    configureServer(server) {
      // Mount in the configureServer body (not a post-hook) so the
      // middleware runs BEFORE Vite's internal SPA history fallback.
      // Otherwise /v1/* requests get caught by the SPA fallback and
      // served the index.html shell.
      const ready = (async () => {
        const storage = new LocalFsStorage({ root: opts.dataDir });
        for (const table of opts.tables) {
          await ensureTable(storage, { app: opts.app, tenant: opts.tenant, table });
        }
        if (opts.seed !== undefined) {
          const db = Db.create({ storage, app: opts.app, tenant: opts.tenant });
          await opts.seed(db);
        }
        const app = createApp({
          app: opts.app,
          storage,
          verifier: sharedSecret({ secret: opts.secret, tenantPrefix: opts.tenant }),
        });
        return getRequestListener(app.fetch);
      })();

      // Surface setup failures eagerly; without this an unhandled
      // rejection would silently kill the dev server.
      ready.catch((error: unknown) => {
        console.error("[baerly-dev] setup failed:", error);
      });

      server.middlewares.use((req, res, next) => {
        const url = req.url;
        if (url === undefined || !isV1Path(url)) {
          next();
          return;
        }
        ready.then(
          (listener) => {
            listener(req as never, res as never);
          },
          (error: unknown) => {
            res.statusCode = 503;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "baerly-dev setup failed", message: String(error) }));
          },
        );
      });

      if (opts.banner !== false) {
        server.httpServer?.once("listening", () => {
          const address = server.httpServer?.address();
          const port =
            typeof address === "object" && address !== null
              ? (address as AddressInfo).port
              : undefined;
          const url = port !== undefined ? `http://localhost:${port}/` : "http://localhost/";
          printDevBanner({
            name: opts.app,
            primaryUrl: { label: "App", url },
            ...(opts.hints !== undefined && { hints: opts.hints }),
          });
        });
      }
    },
  };
}
