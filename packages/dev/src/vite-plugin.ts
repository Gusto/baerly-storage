import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { getRequestListener } from "@hono/node-server";
import type { Plugin } from "vite";
import { baerlyNode } from "@baerly/adapter-node";
import type { BaerlyAppConfig, Verifier } from "@baerly/protocol";
import { Db, resolveVerifier } from "@baerly/server";
import { type DevBannerHint, printDevBanner } from "./dev-banner.ts";
import { ensureTable } from "./ensure-table.ts";
import { LocalFsStorage } from "./local-fs.ts";

export interface BaerlyDevOptions {
  /**
   * The project's `baerly.config.ts`. `app`, `tenant`, `auth`, and the
   * table set (`Object.keys(config.collections)`) are derived from it.
   * Per-collection schemas/indexes flow through to the in-process
   * listener the same way `baerlyNode` / `baerlyWorker` pipe them.
   */
  readonly config: BaerlyAppConfig;
  /**
   * Shared-secret token. **Optional.** Required only when
   * `config.auth === "shared-secret"` and `verifier` is unset — in
   * that branch, clients must send `Authorization: Bearer <secret>`
   * AND the middleware injects the same bearer server-side before
   * forwarding to the in-process listener.
   *
   * Ignored when `config.auth === "none"` (no bearer to inject) or
   * when `verifier` is supplied (the operator owns the auth seam).
   *
   * Throwing the symmetric `InvalidConfig` on a misconfig matches
   * production behaviour: forgetting `SHARED_SECRET` in dev fails
   * fast at `vite dev` startup with the same locked wording the
   * adapter would emit.
   */
  readonly secret?: string;
  /**
   * Per-request `Verifier`. **Optional.** When set, overrides both
   * `config.auth` and `secret` (same precedence as the production
   * adapter factories). Use for dev-mode JWT validation against a
   * staging IdP, or any custom auth shape.
   */
  readonly verifier?: Verifier;
  /** Absolute path to the data directory for LocalFsStorage. */
  readonly dataDir: string;
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
  /**
   * Pathname prefixes to match. Default `["/v1", "/api"]` — the
   * baerly cascade lives at `/v1/*`, and `/api/*` is the canonical
   * namespace for custom Worker routes (the "wrap `baerly.fetch!`"
   * recipe in the scaffold's AGENTS.md). Covering both by default
   * closes a recurring "added a custom route, browser silently 401s"
   * trap: agents typically edit `src/server/index.ts` without touching
   * `vite.config.ts`, so a `"/v1"`-only default leaves their new route
   * unauthenticated in `vite dev` and `pnpm verify` is silent on it.
   *
   * Override when you mount under a different namespace, or pass
   * `prefix: "/v1"` to opt out of `/api/*` injection entirely (rare —
   * the bearer is a harmless extra header on unmatched routes).
   */
  readonly prefix?: string | readonly string[];
}

const normalisePrefixes = (prefix: string | readonly string[] | undefined): readonly string[] => {
  if (prefix === undefined) {
    return ["/v1", "/api"];
  }
  if (typeof prefix === "string") {
    return [prefix];
  }
  return prefix;
};

const matchesAnyPrefix = (url: string, prefixes: readonly string[]): boolean => {
  for (const prefix of prefixes) {
    if (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)) {
      return true;
    }
  }
  return false;
};

/**
 * Vite dev plugin: inject `Authorization: Bearer ${secret}` on every
 * request whose URL starts with one of `prefix` (default
 * `["/v1", "/api"]`). Use this to keep the bearer token out of the
 * SPA bundle — the browser sends the request, Vite's middleware adds
 * the header, and the upstream handler (in-process worker or proxied
 * Node server) sees an authenticated request.
 *
 * **Custom Worker routes.** `baerlyWorker` only sees `/v1/*`; the
 * default `prefix` also covers `/api/*` because that's the canonical
 * namespace for the "wrap `baerly.fetch!`" recipe (a server-side
 * endpoint the SPA client can't run on its own, e.g. an endpoint
 * that needs `db.transaction(...)`). If you mount under a different
 * namespace, override:
 *
 * ```ts
 * baerlyDevAuth({ secret, prefix: ["/v1", "/internal"] });
 * ```
 *
 * The bearer is dev-only convenience — production deploys put the
 * SPA, the baerly cascade, AND your custom routes behind the same
 * tenant boundary (CF Access, an upstream JWT, …), so this matters
 * exclusively while `vite dev` is the front door.
 *
 * @example
 * ```ts
 * import { baerlyDevAuth, loadDevVars } from "@gusto/baerly-storage/dev/vite";
 *
 * const { SHARED_SECRET } = loadDevVars(".dev.vars", "SHARED_SECRET");
 * export default defineConfig({
 *   plugins: [
 *     cloudflare(),
 *     baerlyDevAuth({ secret: SHARED_SECRET ?? "" }),
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
  const prefixes: readonly string[] = normalisePrefixes(opts.prefix);
  return {
    name: "baerly-dev-auth",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "";
        if (matchesAnyPrefix(url, prefixes)) {
          injectAuthorizationHeader(req, `Bearer ${opts.secret}`);
        }
        next();
      });
    },
  };
}

/**
 * Parse a `.dev.vars` / `.env` file and return the values for the
 * requested `keys`. Supports `KEY=value`, `# comments`, blank lines,
 * and single- or double-quoted values. Keys missing from the file
 * (or the whole file when it does not exist) come back as
 * `undefined` — fall back with `??` at the call site.
 *
 * The return type is `Record<K, string | undefined>` where `K` is
 * the union of literal key names you pass in, so property access
 * works under strict `noPropertyAccessFromIndexSignature`:
 *
 * ```ts
 * const { SHARED_SECRET } = loadDevVars(".dev.vars", "SHARED_SECRET");
 * //      ^? string | undefined
 * ```
 */
export function loadDevVars<K extends string>(
  path: string,
  ...keys: readonly K[]
): Record<K, string | undefined> {
  const out = {} as Record<K, string | undefined>;
  for (const key of keys) {
    out[key] = undefined;
  }
  if (!existsSync(path)) {
    return out;
  }
  const wanted = new Set<string>(keys);
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
    if (!wanted.has(key)) {
      continue;
    }
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key as K] = value;
  }
  return out;
}

/**
 * Resolution order for the in-process verifier (mirrors
 * `baerlyNode` / `baerlyWorker`):
 *
 *   1. `opts.verifier` set → use as-is.
 *   2. else `opts.config.auth === "shared-secret"` → require
 *      `opts.secret`; build `sharedSecret({ secret, tenantPrefix:
 *      config.tenant })`. Throws `BaerlyError("InvalidConfig", ...)`
 *      at Vite startup when `opts.secret` is empty/unset — same
 *      locked wording the production adapter would emit.
 *   3. else `opts.config.auth === "none"` → pin every request to
 *      `config.tenant`; no header check.
 *
 * Bearer injection on `/v1/*` only fires in branch 2 (and only when
 * branch 1 didn't win) — the dev convenience that lets the SPA call
 * the listener without putting the secret in the browser bundle.
 * Branch 3 leaves the `Authorization` header alone.
 *
 * Verifier resolution happens eagerly at factory time so a misconfig
 * fails Vite startup, not the first `/v1/*` round-trip.
 */
export function baerlyDev(opts: BaerlyDevOptions): Plugin {
  // Resolution order: opts.verifier → config.auth.shared-secret →
  // config.auth.none → throw. Mirrors `baerlyWorker` / `baerlyNode`.
  // The synthetic `readEnv` hoists `opts.secret` to `SHARED_SECRET`
  // so the same resolver works — `baerlyDev` takes the secret as a
  // typed option rather than reading `process.env` directly.
  const verifier = resolveVerifier({
    factoryVerifier: opts.verifier,
    config: opts.config,
    readEnv: (k) => (k === "SHARED_SECRET" ? opts.secret : process.env[k]),
  });

  // Bearer injection only matters in the shared-secret branch (and
  // only when no override owns auth). For "none" or any custom
  // verifier, the `Authorization` header reaches the listener
  // unchanged.
  const bearerForInjection: string | undefined =
    opts.verifier === undefined && opts.config.auth === "shared-secret" ? opts.secret : undefined;

  return {
    name: "baerly-dev",
    apply: "serve",
    configureServer(server) {
      // Mount in the configureServer body (not a post-hook) so the
      // middleware runs BEFORE Vite's internal SPA history fallback.
      // Otherwise /v1/* requests get caught by the SPA fallback and
      // served the index.html shell.
      const app = opts.config.app;
      const tenant = opts.config.tenant;
      const tables = Object.keys(opts.config.collections);
      const ready = (async () => {
        const storage = new LocalFsStorage({ root: opts.dataDir });
        for (const table of tables) {
          await ensureTable(storage, { app, tenant, table });
        }
        if (opts.seed !== undefined) {
          const db = Db.create({ storage, app, tenant, config: opts.config });
          await opts.seed(db);
        }
        const requestHandler = baerlyNode({
          config: opts.config,
          storage,
          verifier,
        }).fetch;
        return getRequestListener(requestHandler);
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
        // the secret. Only runs for `config.auth === "shared-secret"`
        // without a `verifier:` override — otherwise the header
        // reaches the listener unchanged. Mutates both `req.headers`
        // and `req.rawHeaders` — see `injectAuthorizationHeader`'s
        // JSDoc.
        if (bearerForInjection !== undefined) {
          injectAuthorizationHeader(req, `Bearer ${bearerForInjection}`);
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
            name: opts.config.app,
            primaryUrl: { label: "App", url },
            ...(opts.hints !== undefined && { hints: opts.hints }),
          });
        });
      }
    },
  };
}
