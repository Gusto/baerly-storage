import { createServer, type Server } from "node:http";
import { serve } from "@hono/node-server";
import type { DevLandingOptions } from "@baerly/dev";
import type { BaerlyConfig, MetricsRecorder, Storage, Verifier } from "@baerly/protocol";
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
  readonly app: string;
  readonly storage: Storage;
  readonly verifier: Verifier;
  /** See {@link "@baerly/adapter-node".CreateAppOptions.config}. */
  readonly config?: BaerlyConfig;
  readonly metrics?: MetricsRecorder;
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
 * - `listen(port)` binds the server, installs SIGTERM/SIGINT
 *   handlers that call `close()` and exit `0`, and resolves once
 *   the server is actually listening (after Node's `'listening'`
 *   event fires). Throws on `'error'` from the server.
 * - `close()` closes the server, clears the maintenance interval,
 *   and removes the signal handlers. Resolves once `Server.close`
 *   callback fires. Safe to call multiple times.
 */
export interface BaerlyNodeHandle {
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
 * - {@link createApp} → `@hono/node-server.serve({ fetch, createServer })`.
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
 * import { baerlyNode, s3Storage } from "baerly-storage/node";
 * import { sharedSecret } from "baerly-storage/auth";
 *
 * const handle = baerlyNode({
 *   app: "tickets",
 *   storage: s3Storage({
 *     region: "us-east-1",
 *     bucket: process.env["BUCKET"]!,
 *     accessKeyId: process.env["AWS_ACCESS_KEY_ID"]!,
 *     secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"]!,
 *   }),
 *   verifier: sharedSecret({
 *     secret: process.env["SHARED_SECRET"]!,
 *     tenantPrefix: "acme",
 *   }),
 *   webRoot: "./dist/client",
 *   maintenance: { collections: ["tickets", "comments"], tenants: ["acme"] },
 * });
 * await handle.listen(Number(process.env["PORT"] ?? 8080));
 * ```
 */
export function baerlyNode(opts: BaerlyNodeOptions): BaerlyNodeHandle {
  const app = createApp({
    app: opts.app,
    storage: opts.storage,
    verifier: opts.verifier,
    ...(opts.config !== undefined && { config: opts.config }),
    ...(opts.metrics !== undefined && { metrics: opts.metrics }),
    ...(opts.observability !== undefined && { observability: opts.observability }),
    ...(opts.dev !== undefined && { dev: opts.dev }),
    ...(opts.webRoot !== undefined && { webRoot: opts.webRoot }),
    ...(opts.sinceTimeoutMs !== undefined && { sinceTimeoutMs: opts.sinceTimeoutMs }),
    ...(opts.sincePollIntervalMs !== undefined && {
      sincePollIntervalMs: opts.sincePollIntervalMs,
    }),
  });
  // `serve()` builds an `http.Server` via the supplied `createServer`
  // factory and wires the Hono `fetch` handler into it (handling
  // backpressure, client-abort → AbortController, and stream
  // cleanup natively). The `port` / `hostname` here are placeholders —
  // the actual bind happens via the explicit `server.listen(port)`
  // call below, which overrides them.
  const server: Server = serve({
    fetch: app.fetch,
    port: 0,
    hostname: "0.0.0.0",
    createServer,
  }) as Server;

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
              currentJsonKey: buildCurrentJsonKey(opts.app, tenant, collection),
              ...(opts.metrics !== undefined && { metrics: opts.metrics }),
            });
          } catch (error) {
            // Never re-throw from the scheduled callback. The
            // maintenance canonical line
            // (emitted by runScheduledMaintenance itself) already
            // carries the outcome; we log to stderr as a backstop.
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
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        server.off("listening", onListening);
        server.off("close", onClose);
        reject(err);
      };
      const onListening = (): void => {
        server.off("error", onError);
        server.off("close", onClose);
        resolve();
      };
      // close() called between `server.listen(port)` and the
      // `'listening'` event cancels the bind: `'listening'` never
      // fires; only `'close'` does. Resolve so we observe `closed`
      // below and skip handler install.
      const onClose = (): void => {
        server.off("error", onError);
        server.off("listening", onListening);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.once("close", onClose);
      server.listen(port);
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

  return { listen, close };
}
