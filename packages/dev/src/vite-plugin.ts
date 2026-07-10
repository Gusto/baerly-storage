import type { AddressInfo } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getRequestListener } from "@hono/node-server";
import type { Plugin } from "vite";
import { baerlyNode } from "@baerly/adapter-node";
import { BaerlyError, type BaerlyAppConfig, type Verifier } from "@baerly/protocol";
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
   *
   * **Optional.** If omitted, the config is loaded at dev-server startup
   * from `configPath`, or — if that's also omitted — by convention from
   * `<viteRoot>/src/baerly.config.ts`.
   *
   * Prefer omitting it (convention or `configPath`). Passing the object
   * means the caller's `vite.config` must `import` the config module,
   * which forces Nx's `@nx/vite` / `@nx/vitest` inference plugins to
   * bundle that module — and its transitive imports — while creating the
   * project graph. That pulls unresolved imports into the config bundle
   * and forces the app into the root `nx.json` inference-exclusion lists.
   * Letting `baerlyDev` load the config itself (below) keeps the caller's
   * `vite.config` import-free, the same way `reactRouter()` loads
   * `react-router.config.ts` by convention.
   */
  readonly config?: BaerlyAppConfig;
  /**
   * Absolute path to the `baerly.config` module (its default export is
   * the `BaerlyAppConfig`). Loaded lazily via Vite's `ssrLoadModule` at
   * dev-server startup. Overrides the `<viteRoot>/src/baerly.config.ts`
   * convention. Ignored when `config` is provided.
   */
  readonly configPath?: string;
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
  /**
   * Absolute path to the data directory for LocalFsStorage.
   * **Optional** — defaults to `<vite root>/.baerly-data`, so the dev
   * server runs zero-config.
   */
  readonly dataDir?: string;
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
 * that fans a write across several documents server-side). If you
 * mount under a different namespace, override:
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
 *   2. else `config.auth === "shared-secret"` → require
 *      `opts.secret`; build `sharedSecret({ secret, tenantPrefix:
 *      config.tenant })`. Throws `BaerlyError("InvalidConfig", ...)`
 *      when `opts.secret` is empty/unset — same locked wording the
 *      production adapter would emit.
 *   3. else `config.auth === "none"` → pin every request to
 *      `config.tenant`; no header check.
 *
 * Bearer injection on `/v1/*` only fires in branch 2 (and only when
 * branch 1 didn't win) — the dev convenience that lets the SPA call
 * the listener without putting the secret in the browser bundle.
 * Branch 3 leaves the `Authorization` header alone.
 *
 * When an explicit `config` object is passed, verifier resolution happens
 * eagerly at factory time so a misconfig fails Vite startup, not the first
 * `/v1/*` round-trip. When the config is loaded lazily (`configPath` or the
 * `<viteRoot>/src/baerly.config.ts` convention), that resolution is deferred
 * to dev-server startup, once the config is available.
 */
function resolveAuth(opts: BaerlyDevOptions, config: BaerlyAppConfig) {
  // Resolution order: opts.verifier → config.auth.shared-secret →
  // config.auth.none → throw. Mirrors `baerlyWorker` / `baerlyNode`. The
  // synthetic `readEnv` hoists `opts.secret` to `SHARED_SECRET` so the same
  // resolver works — `baerlyDev` takes the secret as a typed option rather
  // than reading `process.env` directly.
  const verifier = resolveVerifier({
    factoryVerifier: opts.verifier,
    config,
    readEnv: (k) => (k === "SHARED_SECRET" ? opts.secret : process.env[k]),
  });
  // Bearer injection only matters in the shared-secret branch (and only when
  // no override owns auth). For "none" or any custom verifier, the
  // `Authorization` header reaches the listener unchanged.
  const bearerForInjection: string | undefined =
    opts.verifier === undefined && config.auth === "shared-secret" ? opts.secret : undefined;
  return { verifier, bearerForInjection };
}

export function baerlyDev(opts: BaerlyDevOptions): Plugin {
  // Eager, factory-time auth resolution when a `config` object is passed —
  // preserves fail-fast startup on misconfig. When `config` is omitted it's
  // loaded lazily in `configureServer` (see below) and auth resolves there.
  const eagerAuth = opts.config !== undefined ? resolveAuth(opts, opts.config) : undefined;
  return {
    name: "baerly-dev",
    apply: "serve",
    configureServer(server) {
      // Everything below runs at dev-server startup, NOT at plugin-factory
      // time. That lets callers omit `config` and instead have us load
      // `baerly.config` here (via `configPath`, or by convention) — so their
      // `vite.config` never imports the config module. Resolving it here
      // rather than in the factory is what keeps baerly apps out of Nx's
      // inference-plugin exclusion lists (see `BaerlyDevOptions.config`).
      //
      // Mount the middleware in the configureServer body (not a post-hook) so
      // it runs BEFORE Vite's internal SPA history fallback; otherwise /v1/*
      // requests get caught by the fallback and served the index.html shell.
      const ready = (async () => {
        // Resolution order for the config source: explicit `config` object →
        // explicit `configPath` → convention `<viteRoot>/src/baerly.config.ts`.
        let config: BaerlyAppConfig;
        if (opts.config !== undefined) {
          config = opts.config;
        } else {
          const configPath = opts.configPath ?? resolve(server.config.root, "src/baerly.config.ts");
          const mod = (await server.ssrLoadModule(configPath)) as { default?: unknown };
          // Mirrors packages/cli/src/config.ts's loadAppConfig: a module with no
          // (or a misnamed) default export would otherwise silently become
          // `undefined` here, surfacing later as a bare `TypeError` on the first
          // `config.app` read with no hint that the real problem is the export.
          if (
            mod.default === undefined ||
            typeof mod.default !== "object" ||
            mod.default === null
          ) {
            throw new BaerlyError(
              "InvalidConfig",
              `baerly-dev: ${configPath} must default-export a BaerlyAppConfig object`,
            );
          }
          config = mod.default as BaerlyAppConfig;
        }

        // Reuse the eager (factory-time) auth resolution when a `config` object
        // was passed; otherwise resolve now that the loaded config is available.
        const { verifier, bearerForInjection } = eagerAuth ?? resolveAuth(opts, config);

        const app = config.app;
        const tenant = config.tenant;
        const tables = Object.keys(config.collections);
        const storage = new LocalFsStorage({
          root: opts.dataDir ?? resolve(server.config.root, ".baerly-data"),
        });
        for (const table of tables) {
          await ensureTable(storage, { app, tenant, table });
        }
        if (opts.seed !== undefined) {
          const db = Db.create({ storage, app, tenant, config });
          await opts.seed(db);
        }
        const requestHandler = baerlyNode({ config, storage, verifier }).fetch;
        return {
          listener: getRequestListener(requestHandler),
          bearerForInjection,
          appName: config.app,
        };
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
        // Inject the bearer token server-side so the SPA never sees the secret.
        // Only for `config.auth === "shared-secret"` without a `verifier:`
        // override — otherwise the header reaches the listener unchanged.
        // Mutates both `req.headers` and `req.rawHeaders` (see
        // `injectAuthorizationHeader`'s JSDoc). When auth resolved eagerly
        // (explicit `config`), inject synchronously here — before the async
        // listener resolves — preserving the pre-lazy-load timing. When the
        // config is loaded lazily, the bearer isn't known yet, so injection
        // happens in the `ready.then` below (still before the listener runs).
        if (eagerAuth?.bearerForInjection !== undefined) {
          injectAuthorizationHeader(req, `Bearer ${eagerAuth.bearerForInjection}`);
        }
        ready.then(
          ({ listener, bearerForInjection }) => {
            if (eagerAuth === undefined && bearerForInjection !== undefined) {
              injectAuthorizationHeader(req, `Bearer ${bearerForInjection}`);
            }
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
          ready
            .then(({ appName }) => {
              printDevBanner({
                name: appName,
                primaryUrl: { label: "App", url },
                ...(opts.hints !== undefined && { hints: opts.hints }),
              });
            })
            // A rejected `ready` is already logged by the `ready.catch` above.
            // Each `.then()`/`.catch()` call creates its own derived promise,
            // so without this, a config-load failure here would be a SECOND,
            // unguarded rejection — the exact "unhandled rejection kills the
            // dev server" failure that catch was added to prevent.
            .catch(() => {});
        });
      }
    },
  };
}
