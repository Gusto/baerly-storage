import { type BaerlyConfig, type Storage, type Verifier } from "@baerly/protocol";
import { Db } from "@baerly/server";
import { createRouter, mapError } from "@baerly/server/http";
import { runScheduledMaintenance } from "@baerly/server/maintenance";
import { prettyConsoleSink } from "./logger-pretty.ts";
import {
  type ObservabilityConfig,
  configureObservability,
  createObservabilityContext,
  deriveOutcome,
  flushCanonicalLine,
  flushUnauthorizedAndRespond,
  observableStorage,
  runWithContext,
} from "@baerly/server/observability";

/**
 * Options for {@link createFetchHandler}.
 *
 * Host-agnostic Fetch-shaped cascade entry point. The Node-host-specific
 * options (`webRoot`, `dev`) live on {@link CreateAppOptions} so they
 * only reach the middleware stack that consumes them.
 *
 * @internal — public consumers see {@link CreateAppOptions} from
 * `./app.ts` instead. Exported for intra-package re-use.
 */
export interface CreateFetchHandlerOptions {
  readonly app: string;
  readonly storage: Storage;
  readonly verifier: Verifier;
  /**
   * Your `baerly.config.ts`. When set, the adapter forwards it to
   * {@link Db.create} on every request — so server-side schema
   * validation fires on commits and the auto-planner sees declared
   * indexes. Without this option, declared collections have no
   * effect on the `/v1/c/*` surface.
   *
   * Only `collections` is read — deploy-time fields (`target`,
   * `domain`, `requiredSecrets`, …) are ignored here.
   */
  readonly config?: BaerlyConfig;
  /**
   * LogTape config (level/sink) with `LOG_LEVEL` envvar fallback.
   * When the field is unset, the default sink is auto-selected: the
   * local `prettyConsoleSink()` when `process.stdout.isTTY === true`
   * (developer terminals), `"console-json"` otherwise (production
   * hosts where stdout is piped to a log aggregator). The typed
   * `sink` field always wins. Pass `{}` to opt into TTY
   * auto-detection at default level. Pass `undefined` (the field's
   * absence) to skip `configureObservability` entirely.
   */
  readonly observability?: ObservabilityConfig;
  /** Override the long-poll budget. Forwarded to `createRouter`. */
  readonly sinceTimeoutMs?: number;
  /** Override the long-poll inner-poll cadence. Forwarded to `createRouter`. */
  readonly sincePollIntervalMs?: number;
}

/**
 * Build a `(req: Request) => Promise<Response>` handler that runs the
 * baerly `/v1/*` cascade: healthz short-circuit → observability context
 * → verifier → `Db.create` → `createRouter({db}).fetch(req)` →
 * canonical-line flush. The handler is host-agnostic; mount it under
 * `/v1/*` in your Fetch framework.
 *
 * Non-`/v1/*` paths fall through to the Hono router, which renders the
 * kernel's 404 envelope. To compose static-asset or dev-landing
 * handlers, dispatch those upstream of this factory — see
 * {@link "./app.ts".createApp} for the production composition.
 *
 * @internal — public consumers reach this via `createApp` from
 * `./app.ts`. Exported for intra-package re-use and direct unit
 * coverage in `server.test.ts`.
 */
export function createFetchHandler(
  opts: CreateFetchHandlerOptions,
): (req: Request) => Promise<Response> {
  // Factory-time, idempotent.
  void configureObservability(resolveDefaultSink(opts.observability ?? {}));
  const wrappedStorage = observableStorage(opts.storage);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const path = url.pathname;

    // /v1/healthz is anonymous; the deploy-probe contract bypasses
    // verifier AND observability so probes don't flood logs. Matches
    // adapter-cloudflare/src/worker.ts.
    if (request.method === "GET" && path === "/v1/healthz") {
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    const requestId = request.headers.get("x-request-id") ?? crypto.randomUUID();
    const obsCtx = createObservabilityContext({
      request_id: requestId,
    });

    const result = await opts.verifier(request);
    if (result === null) {
      return await runWithContext(obsCtx, async () => flushUnauthorizedAndRespond(obsCtx, request));
    }

    return await runWithContext(obsCtx, async () => {
      let outboundStatus = 500;
      let caughtError: unknown;
      let response: Response;
      try {
        const db = Db.create({
          storage: wrappedStorage,
          app: opts.app,
          tenant: result.tenantPrefix,
          config: opts.config,
        });
        const router = createRouter({
          db,
          ...(opts.sinceTimeoutMs !== undefined && { sinceTimeoutMs: opts.sinceTimeoutMs }),
          ...(opts.sincePollIntervalMs !== undefined && {
            sincePollIntervalMs: opts.sincePollIntervalMs,
          }),
        });
        response = await router.fetch(request);
        outboundStatus = response.status;
      } catch (error) {
        caughtError = error;
        const { status, envelope } = mapError(error);
        outboundStatus = status;
        response = new Response(JSON.stringify(envelope), {
          status,
          headers: { "content-type": "application/json" },
        });
      } finally {
        flushCanonicalLine(obsCtx, obsCtx.recorder, {
          unit: "http",
          status: outboundStatus,
          outcome: deriveOutcome(request.method, outboundStatus, caughtError),
          ...(caughtError !== undefined && { error: caughtError }),
          extra: { method: request.method, path },
        });
      }
      return response;
    });
  };
}

/**
 * Options for {@link runMaintenanceTick}.
 */
export interface NodeMaintenanceOptions {
  /** Any {@link Storage} impl — `S3HttpStorage`, `LocalFsStorage`, etc. */
  readonly storage: Storage;
  /** Full bucket-relative key of the CAS pointer for the target collection. */
  readonly currentJsonKey: string;
  /** Forwarded to both `compact()` and `runGc()` underneath. */
  readonly signal?: AbortSignal;
}

/**
 * Run one pass of compaction + GC for one collection. Node hosts have
 * no subrequest cap, so this uses the engine defaults (unbounded) —
 * a single pass folds the entire live tail and sweeps every aged-out
 * candidate.
 *
 * Pair with `node-cron`, systemd timers, or k8s CronJobs — this
 * function is a single-shot callable that does not loop. Errors
 * propagate; the caller decides retry semantics.
 *
 * `compact()` and `runGc()` are each CAS-protected single-attempts:
 * a crash or restart between phases is safe because the next tick
 * picks up where the previous one left off.
 *
 * @example
 * ```ts
 * import cron from "node-cron";
 * import { runMaintenanceTick } from "@gusto/baerly-storage/node";
 *
 * cron.schedule("0 * * * *", async () => {  // hourly
 *   await runMaintenanceTick({ storage, currentJsonKey: "..." });
 * });
 * ```
 */
export const runMaintenanceTick = async (opts: NodeMaintenanceOptions): Promise<void> => {
  // Maintenance ticks run outside any HTTP scope, so kernel
  // emissions inside compact / GC reach the no-op recorder by
  // design (no human reads cron-tick canonical lines; errors throw
  // to the process log).
  await runScheduledMaintenance(
    {
      storage: observableStorage(opts.storage),
      currentJsonKey: opts.currentJsonKey,
    },
    {
      ...(opts.signal !== undefined && { signal: opts.signal }),
    },
  );
};

/**
 * Auto-pick the default sink when the caller passed an
 * {@link ObservabilityConfig} without a `sink` field. On a TTY
 * (developer terminals) we prefer pretty output; otherwise JSON
 * (production hosts pipe stdout to a log aggregator).
 *
 * Returns a new config with `sink` defaulted; if the caller already
 * supplied a `sink` (function or shorthand string) we pass the
 * config through verbatim. Either way the caller's `level` (when
 * set) reaches LogTape unchanged.
 *
 * Exported for the test suite — the TTY check is otherwise a pure
 * read of `process.stdout.isTTY` and a default lookup, neither
 * worth a black-box round-trip.
 */
export const resolveDefaultSink = (config: ObservabilityConfig): ObservabilityConfig => {
  if (config.sink !== undefined) {
    return config;
  }
  // `process.stdout.isTTY` is `true` only on real terminals. CI
  // pipelines, docker logs, systemd, and pm2 cluster mode all
  // pipe stdout — `isTTY` is `undefined` (falsy) there. The kernel
  // only ships `"console-json"`; we construct the pretty sink
  // locally and pass it as a function so picocolors stays off the
  // kernel closure.
  const isTty = Boolean(process.stdout.isTTY);
  return { ...config, sink: isTty ? prettyConsoleSink() : "console-json" };
};
