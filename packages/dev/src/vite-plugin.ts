import type { AddressInfo } from "node:net";
import type { Plugin } from "vite";
import { createListener } from "@baerly/adapter-node";
import { Db } from "@baerly/server";
import { sharedSecret } from "@baerly/server/auth";
import { type DevBannerHint, printDevBanner } from "./dev-banner.ts";
import { ensureTable } from "./ensure-table.ts";
import { LocalFsStorage } from "./local-fs.ts";

export interface BaerlyDevOptions {
  /** App namespace (matches createListener's `app`). */
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
      // Return a post-hook so the middleware mounts after Vite's own
      // internal middleware stack is installed.
      return async () => {
        const storage = new LocalFsStorage({ root: opts.dataDir });

        for (const table of opts.tables) {
          await ensureTable(storage, { app: opts.app, tenant: opts.tenant, table });
        }

        if (opts.seed !== undefined) {
          const db = Db.create({ storage, app: opts.app, tenant: opts.tenant });
          await opts.seed(db);
        }

        const listener = createListener({
          app: opts.app,
          storage,
          verifier: sharedSecret({ secret: opts.secret, tenantPrefix: opts.tenant }),
        });

        server.middlewares.use((req, res, next) => {
          const url = req.url;
          if (url === undefined) {
            next();
            return;
          }
          if (isV1Path(url)) {
            listener(req as never, res as never);
          } else {
            next();
          }
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
      };
    },
  };
}
