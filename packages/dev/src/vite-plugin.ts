import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
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

/**
 * Inject `Authorization: ${value}` into a Node `IncomingMessage` such
 * that BOTH the parsed (`req.headers`) and the wire-form (`req.rawHeaders`)
 * views agree.
 *
 * Why both: `req.headers` is the parsed-and-lowercased JS map most
 * connect-style middleware reads, but Node→Fetch bridges typically
 * rebuild the Fetch `Headers` from `req.rawHeaders` (the original
 * `[name, value, name, value, …]` wire array) to preserve case and
 * multi-value semantics. `@cloudflare/vite-plugin`'s `createHeaders()`
 * does exactly that — so mutating `req.headers` alone silently drops
 * the bearer token when the in-process Worker receives the request.
 * Treat any new injection in this file as obligated to touch both.
 */
const injectAuthorizationHeader = (
  req: {
    headers: Record<string, string | string[] | undefined>;
    rawHeaders?: string[];
  },
  value: string,
): void => {
  req.headers["authorization"] = value;
  const raw = req.rawHeaders;
  if (raw === undefined) {
    return;
  }
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]!.toLowerCase() === "authorization") {
      raw[i + 1] = value;
      return;
    }
  }
  raw.push("Authorization", value);
};

export interface BaerlyDevAuthOptions {
  /** Bearer token to inject on matched paths. */
  readonly secret: string;
  /** Pathname prefix to match. Default "/v1". */
  readonly prefix?: string;
}

/**
 * Vite dev plugin: inject `Authorization: Bearer ${secret}` on every
 * request whose URL starts with `prefix` (default `/v1`). Use this
 * to keep the bearer token out of the SPA bundle — the browser sends
 * the request, Vite's middleware adds the header, and the upstream
 * handler (in-process worker or proxied Node server) sees an
 * authenticated request.
 *
 * @example
 * ```ts
 * import { baerlyDevAuth, loadDevVars } from "baerly-storage/dev/vite";
 *
 * const vars = loadDevVars(".dev.vars");
 * export default defineConfig({
 *   plugins: [
 *     cloudflare(),
 *     baerlyDevAuth({ secret: vars["SHARED_SECRET"] ?? "" }),
 *   ],
 * });
 * ```
 */
export function baerlyDevAuth(opts: BaerlyDevAuthOptions): Plugin {
  if (opts.secret === "") {
    throw new Error(
      "baerlyDevAuth: secret must be non-empty. Set SHARED_SECRET in .dev.vars / .env.",
    );
  }
  const prefix = opts.prefix ?? "/v1";
  return {
    name: "baerly-dev-auth",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "";
        if (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)) {
          injectAuthorizationHeader(req, `Bearer ${opts.secret}`);
        }
        next();
      });
    },
  };
}

/**
 * Parse a `.dev.vars` / `.env` file. Supports `KEY=value`, `# comments`,
 * blank lines, and single- or double-quoted values. Returns `{}` if
 * the file does not exist.
 */
export function loadDevVars(path: string): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const rawLine of readFileSync(path, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const eq = line.indexOf("=");
    if (eq === -1) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

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
        // Inject the bearer token server-side so the SPA never sees
        // the secret. The verifier inside app.fetch validates the
        // injected header normally. Mutates both `req.headers` and
        // `req.rawHeaders` — see `injectAuthorizationHeader`'s JSDoc.
        injectAuthorizationHeader(req, `Bearer ${opts.secret}`);
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
