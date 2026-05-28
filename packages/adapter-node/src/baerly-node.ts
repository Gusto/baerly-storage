import { createServer, type Server } from "node:http";
import { serve } from "@hono/node-server";
import type { DevLandingOptions } from "@baerly/dev";
import type { BaerlyAppConfig, Storage, Verifier } from "@baerly/protocol";
import { resolveVerifier } from "@baerly/server";
import type { ObservabilityConfig } from "@baerly/server/observability";
import { createApp } from "./app.ts";
import { runMaintenanceTick } from "./server.ts";

/**
 * Multi-collection maintenance schedule. Each tick spawns one
 * {@link runMaintenanceTick} call per `(tenant, collection)` pair. The
 * cross-product is computed once at startup; deletions / additions
 * at runtime require restarting the process.
 *
 * `intervalMs` defaults to one hour, matching the per-template
 * `setInterval` cadence the helper replaces.
 */
export interface BaerlyNodeMaintenance {
  readonly collections: readonly string[];
  readonly tenants: readonly string[];
  readonly intervalMs?: number;
}

/**
 * Options for {@link baerlyNode}. Composes the {@link createApp}
 * surface (same `app` / `storage` / `verifier` / `webRoot` / etc.)
 * with optional maintenance scheduling and a `node:http` server
 * lifecycle (`listen` / `close` + SIGTERM/SIGINT handling).
 *
 * Mirrors `baerlyWorker` in `@baerly/adapter-cloudflare`.
 */
export interface BaerlyNodeOptions {
  /**
   * Your `baerly.config.ts`. **Required.** Carries `auth`, `tenant`,
   * `app`, and the declared `collections` (their schemas/indexes flow
   * through to per-request `Db.create` automatically).
   *
   * The adapter resolves the per-request `Verifier` from
   * `config.auth` when no `verifier:` override is supplied — see
   * resolution order on {@link verifier} below. Only
   * `app` / `tenant` / `auth` / `collections` are read for runtime
   * kernel wiring; deploy-time fields (`target`, `domain`,
   * `requiredSecrets`) are ignored here.
   */
  readonly config: BaerlyAppConfig;
  readonly storage: Storage;
  /**
   * Per-request `Verifier`. **Optional.** When set, overrides
   * `config.auth` (the "dev default in config, prod override via env"
   * recipe). When unset, the adapter synthesizes one from
   * `config.auth`:
   *
   *   - `"shared-secret"` → `sharedSecret({ secret:
   *     process.env.SHARED_SECRET, tenantPrefix: config.tenant })`.
   *     Throws `BaerlyError("InvalidConfig", ...)` at factory time
   *     when `SHARED_SECRET` is missing/empty (Node can throw at
   *     startup unlike CF Workers).
   *   - `"none"` → pins every request to `config.tenant` with no
   *     header check.
   *
   * `GET /v1/healthz` always bypasses the verifier.
   */
  readonly verifier?: Verifier;
  readonly observability?: ObservabilityConfig;
  readonly dev?: DevLandingOptions;
  readonly webRoot?: string;
  readonly sinceTimeoutMs?: number;
  readonly sincePollIntervalMs?: number;
  /**
   * Multi-collection maintenance schedule. Each tick fires one
   * {@link runMaintenanceTick} per `(tenant, collection)` pair. Omit
   * to skip the in-process maintenance loop (operator wires their own
   * scheduler — k8s CronJob, systemd timer, etc).
   */
  readonly maintenance?: BaerlyNodeMaintenance;
}

/**
 * Handle returned by {@link baerlyNode}. Composes a running
 * `node:http` server lifecycle.
 *
 * - `fetch(request)` is the web-standard request handler. Use
 *   directly for in-process embedding (Vite middleware via
 *   `@hono/node-server.getRequestListener`, custom servers, tests).
 *   Calling `fetch` does not start the `node:http` server; the
 *   server lifecycle is owned by `listen(port)` / `close()`.
 *   Hono's optional `env`/`executionCtx` parameters are intentionally
 *   omitted from the signature — this is a Node-host handle, and
 *   those parameters are Workers-only.
 * - `listen(port)` binds the server, installs SIGTERM/SIGINT
 *   handlers that call `close()` and exit `0`, and resolves once
 *   the server is actually listening (after Node's `'listening'`
 *   event fires). Throws on `'error'` from the server.
 * - `close()` closes the server, clears the maintenance interval,
 *   and removes the signal handlers. Resolves once `Server.close`
 *   callback fires. Safe to call multiple times.
 */
export interface BaerlyNodeHandle {
  readonly fetch: (request: Request) => Response | Promise<Response>;
  listen(port: number): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

const buildCurrentJsonKey = (app: string, tenant: string, collection: string): string =>
  `app/${app}/tenant/${tenant}/manifests/${collection}/current.json`;

/**
 * Mount baerly on `node:http` with one call. Mirrors `baerlyWorker`
 * from `@baerly/adapter-cloudflare`.
 *
 * Composes:
 * - {@link createApp} → exposed as `handle.fetch` for in-process
 *   embedding; wrapped in `@hono/node-server.serve({ fetch, createServer })`
 *   lazily when `listen()` is called.
 * - Optional maintenance loop: each `intervalMs` tick fires one
 *   {@link runMaintenanceTick} per `(tenant, collection)` pair
 *   (cross-product of `opts.maintenance.tenants` × `.collections`).
 *   The `currentJsonKey` is composed as
 *   `app/<app>/tenant/<tenant>/manifests/<collection>/current.json` —
 *   the canonical layout from the sync protocol.
 * - SIGTERM + SIGINT handlers installed on `listen()` that call
 *   `close()` and `process.exit(0)`. On any error during close,
 *   `process.exit(1)`.
 *
 * Failures in a single `(tenant, collection)` maintenance tick log to
 * stderr but do not block sibling pairs and do not crash the process —
 * a transient storage hiccup must not take the whole server down.
 *
 * @example
 * ```ts
 * import { baerlyNode, s3Storage } from "@gusto/baerly-storage/node";
 * import config from "./baerly.config.ts";
 *
 * const handle = baerlyNode({
 *   config,
 *   storage: s3Storage({
 *     region: "us-east-1",
 *     bucket: process.env["BUCKET"]!,
 *     credentials: {
 *       accessKeyId: process.env["AWS_ACCESS_KEY_ID"]!,
 *       secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"]!,
 *     },
 *   }),
 *   // No verifier needed when config.auth is "none" or "shared-secret".
 *   webRoot: "./dist/client",
 *   maintenance: { collections: ["tickets", "comments"], tenants: ["acme"] },
 * });
 * await handle.listen(Number(process.env["PORT"] ?? 8080));
 * ```
 */
export function baerlyNode(opts: BaerlyNodeOptions): BaerlyNodeHandle {
  // Node can `await` / throw at top level (unlike CF Workers), so
  // verifier resolution lives here at factory time. An unset
  // `SHARED_SECRET` for `auth: "shared-secret"` fails the process
  // startup with a locked `InvalidConfig` message rather than
  // surprising the first inbound request.
  const verifier = resolveVerifier({
    factoryVerifier: opts.verifier,
    config: opts.config,
    readEnv: (k) => process.env[k],
  });
  // auth=none startup banner: emit one info line when the operator
  // opted into no-auth via config (not when they passed a real
  // verifier override). Suppressed for shared-secret — operator
  // already knows.
  if (opts.verifier === undefined && opts.config.auth === "none") {
    console.log(
      `[baerly] auth=none — all requests resolve to tenant=${JSON.stringify(opts.config.tenant)}`,
    );
  }
  const app = createApp({
    app: opts.config.app,
    storage: opts.storage,
    verifier,
    config: opts.config,
    ...(opts.observability !== undefined && { observability: opts.observability }),
    ...(opts.dev !== undefined && { dev: opts.dev }),
    ...(opts.webRoot !== undefined && { webRoot: opts.webRoot }),
    ...(opts.sinceTimeoutMs !== undefined && { sinceTimeoutMs: opts.sinceTimeoutMs }),
    ...(opts.sincePollIntervalMs !== undefined && {
      sincePollIntervalMs: opts.sincePollIntervalMs,
    }),
  });
  // `serve()` is deferred to `listen()` so calling `baerlyNode(opts)`
  // without `.listen()` does NOT create an `http.Server`, install
  // signal handlers, or arm the maintenance loop. The `fetch` handler
  // is exposed on the returned handle for in-process embedding (Vite
  // middleware, tests). `server` stays `undefined` until `listen()`
  // runs; `close()` guards against the "constructed but never listened"
  // branch.
  let server: Server | undefined;

  let maintenanceTimer: NodeJS.Timeout | undefined;
  let signalHandler: ((sig: NodeJS.Signals) => void) | undefined;
  let closed = false;

  const tick = async (): Promise<void> => {
    const m = opts.maintenance;
    if (m === undefined) {
      return;
    }
    await Promise.all(
      m.tenants.flatMap((tenant) =>
        m.collections.map(async (collection) => {
          try {
            await runMaintenanceTick({
              storage: opts.storage,
              currentJsonKey: buildCurrentJsonKey(opts.config.app, tenant, collection),
            });
          } catch (error) {
            // Never re-throw from the scheduled callback — a transient
            // storage hiccup must not crash the process or block
            // sibling pairs. Errors throw to stderr; the platform's
            // log aggregator picks them up.
            console.error(
              `baerlyNode maintenance tick failed for tenant=${tenant} collection=${collection}`,
              error,
            );
          }
        }),
      ),
    );
  };

  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    if (maintenanceTimer !== undefined) {
      clearInterval(maintenanceTimer);
      maintenanceTimer = undefined;
    }
    if (signalHandler !== undefined) {
      process.off("SIGTERM", signalHandler);
      process.off("SIGINT", signalHandler);
      signalHandler = undefined;
    }
    await new Promise<void>((resolve, reject) => {
      // Factory was called but `listen()` never ran — there's no
      // `http.Server` to close. Resolve immediately.
      if (server === undefined) {
        resolve();
        return;
      }
      // Node throws ERR_SERVER_NOT_RUNNING on close() of a non-listening server.
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  };

  const listen = async (port: number): Promise<void> => {
    // `serve()` builds an `http.Server` via the supplied `createServer`
    // factory and wires the Hono `fetch` handler into it (handling
    // backpressure, client-abort → AbortController, and stream
    // cleanup natively). The `port` / `hostname` here are placeholders —
    // the actual bind happens via the explicit `server.listen(port)`
    // call below, which overrides them.
    server = serve({
      fetch: app.fetch,
      port: 0,
      hostname: "0.0.0.0",
      createServer,
    }) as Server;
    const httpServer = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        httpServer.off("listening", onListening);
        httpServer.off("close", onClose);
        reject(err);
      };
      const onListening = (): void => {
        httpServer.off("error", onError);
        httpServer.off("close", onClose);
        resolve();
      };
      // close() called between `server.listen(port)` and the
      // `'listening'` event cancels the bind: `'listening'` never
      // fires; only `'close'` does. Resolve so we observe `closed`
      // below and skip handler install.
      const onClose = (): void => {
        httpServer.off("error", onError);
        httpServer.off("listening", onListening);
        resolve();
      };
      httpServer.once("error", onError);
      httpServer.once("listening", onListening);
      httpServer.once("close", onClose);
      httpServer.listen(port);
    });

    // close() may have run while we were awaiting `'listening'`. Skip
    // handler install so we don't leak a SIGTERM/SIGINT listener or a
    // maintenance interval onto a closed handle.
    if (closed) {
      return;
    }

    if (opts.maintenance !== undefined) {
      const intervalMs = opts.maintenance.intervalMs ?? DEFAULT_MAINTENANCE_INTERVAL_MS;
      maintenanceTimer = setInterval(() => {
        void tick();
      }, intervalMs);
      // `unref()` so the timer doesn't keep the event loop alive on
      // its own — server close + signal handlers own the lifecycle.
      maintenanceTimer.unref();
    }

    // Shared handler so a double-signal (SIGINT then SIGTERM) keeps
    // the listener count predictable for the close() cleanup path.
    signalHandler = (sig): void => {
      console.log(`Received ${sig}; closing baerlyNode server`);
      close()
        .then(() => process.exit(0))
        .catch((error: unknown) => {
          console.error("baerlyNode close failed", error);
          process.exit(1);
        });
    };
    process.on("SIGTERM", signalHandler);
    process.on("SIGINT", signalHandler);
  };

  return { fetch: app.fetch, listen, close };
}
