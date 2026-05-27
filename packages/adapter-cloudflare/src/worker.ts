import { type DevLandingOptions, renderDevLanding } from "@baerly/dev";
import {
  type BaerlyAppConfig,
  type MetricsRecorder,
  type Verifier,
  noopMetricsRecorder,
} from "@baerly/protocol";
import { Db, resolveVerifier } from "@baerly/server";
import { createRouter } from "@baerly/server/http";
import {
  CATEGORY,
  type ObservabilityConfig,
  alsAwareRecorder,
  configureObservability,
  createObservabilityContext,
  deriveOutcome,
  flushCanonicalLine,
  flushUnauthorizedAndRespond,
  getLogger,
  observableStorage,
  runWithContext,
  setKernelMetricsRecorder,
} from "@baerly/server/observability";
import { type CacheStatus, invalidateOnWrite, withReadCache } from "./cache.ts";
import { r2BindingStorage } from "./r2-binding-storage.ts";

/**
 * Cloudflare Workers have no TTY, so the default sink is always
 * the JSON console sink — log-aggregator-shaped out of the box.
 * Callers can pass `options.observability.sink` to override.
 */
const resolveCfSink = (config: ObservabilityConfig | undefined): ObservabilityConfig => {
  const merged = config ?? {};
  return merged.sink !== undefined ? merged : { ...merged, sink: "console-json" };
};

/**
 * Worker bindings consumed by `baerlyWorker` itself. The caller
 * wires these in `wrangler.jsonc`:
 *
 *   "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "<your-bucket>" }],
 *
 *   "vars": { "APP": "tickets" }
 *
 * Tenant resolution is owned by the configured `Verifier`; the
 * adapter never reads a tenant-shaped env var. App-specific vars
 * (`SHARED_SECRET`, `CF_ACCESS_*`, `LOG_*`, a `TENANT` literal for
 * single-tenant `sharedSecret` callers, etc.) belong on the
 * caller's own env type — extend this one:
 *
 * ```ts
 * import type { BaerlyEnv } from "baerly-storage/cloudflare";
 *
 * interface AppEnv extends BaerlyEnv {
 *   readonly TENANT: string;
 *   readonly SHARED_SECRET?: string;
 * }
 * ```
 */
export interface BaerlyEnv {
  BUCKET: R2Bucket;
  APP: string;
}

/**
 * Cron Trigger handler. Called once per tick when the user has
 * declared `triggers.crons` in `wrangler.jsonc` AND passed this
 * option. The body owns its own subrequest budget — wrap any
 * outlasting work in `ctx.waitUntil(...)`. Multi-tenant deployments
 * typically iterate a list of `current.json` keys and call
 * {@link runScheduledMaintenance} per tenant.
 */
export type WorkerScheduledHandler = (
  event: ScheduledController,
  env: BaerlyEnv,
  ctx: ExecutionContext,
) => Promise<void> | void;

export interface BaerlyWorkerOptions {
  /**
   * Your `baerly.config.ts`. **Required.** Carries `auth`,
   * `tenant`, and the declared `collections` (their schemas/indexes
   * flow through to per-request `Db.create` automatically).
   *
   * The adapter resolves the per-request `Verifier` from
   * `config.auth` when no `verifier:` override is supplied — see
   * resolution order on {@link verifier} below.
   *
   * Only `collections` is read for runtime kernel wiring — fields
   * like `target`, `domain`, `cloudflareAccess` are deploy-time
   * concerns that the adapter ignores.
   */
  readonly config: BaerlyAppConfig;
  /**
   * Cron Trigger handler. When unset, `scheduled()` is a no-op even
   * if `triggers.crons` is declared. See {@link WorkerScheduledHandler}.
   */
  readonly scheduled?: WorkerScheduledHandler;
  /**
   * Per-request `Verifier`. **Optional.** When set, overrides
   * `config.auth` (the "dev default in config, prod override via env"
   * recipe). When unset, the adapter synthesizes one from
   * `config.auth`:
   *
   *   - `"shared-secret"` → `sharedSecret({ secret: env.SHARED_SECRET,
   *     tenantPrefix: config.tenant })`. Throws `InvalidConfig` on
   *     first fetch when `SHARED_SECRET` is missing/empty.
   *   - `"none"` → pins every request to `config.tenant` with no
   *     header check.
   *
   * `GET /v1/healthz` always bypasses the verifier.
   *
   * Multi-tenant deployments compose their own verifier on top of a
   * real IdP — JWT, SigV4, Cloudflare Access, etc.
   */
  readonly verifier?: Verifier;
  /**
   * Operator's long-term {@link MetricsRecorder}. Receives every
   * kernel emission (Writer histograms, CAS-conflict counters,
   * storage per-call counts) verbatim. Defaults to
   * {@link noopMetricsRecorder} so non-instrumented deployments see
   * zero behavior change.
   *
   * Wire your aggregation backend here — Workers Analytics Engine,
   * OpenTelemetry, statsd, in-memory rollup, etc. The
   * canonical-line bag is wired separately and reads through
   * {@link alsAwareRecorder} alongside this sink.
   */
  readonly metrics?: MetricsRecorder;
  /**
   * Observability config (LogTape sink + level). When supplied, the
   * Worker calls {@link configureObservability} lazily on first
   * `fetch` / `scheduled` invocation (CF Worker modules can't
   * `await` at the top level). `configureObservability` is
   * idempotent — passing `{ reset: true }` to LogTape — so
   * re-invocation is harmless.
   *
   * - `level` falls through to `env.LOG_LEVEL` (when typed option
   *   is undefined).
   * - `sink` defaults to `"console-json"` (Cloudflare's stdout is
   *   ingested by Workers Logs as JSON-shaped records).
   *
   * Leave the field unset to skip configuration entirely — the
   * default LogTape configuration is a no-op sink. Adapters that
   * skip configuration still emit through the bag/operator pipe; only
   * the LogTape `console.log` side becomes silent.
   */
  readonly observability?: ObservabilityConfig;
  /**
   * Opt-in dev affordance. When set, `GET /` returns a small
   * human-readable HTML page that links to {@link DevLandingOptions.uiUrl},
   * and `GET /favicon.ico` returns 204 No Content. Leave unset on
   * production Workers — `/` falls through to the existing 404
   * envelope when this option is absent.
   */
  readonly dev?: DevLandingOptions;
  /** Override the long-poll budget. Forwarded to `longPollSince`. */
  readonly sinceTimeoutMs?: number;
  /** Override the long-poll inner-poll cadence. Forwarded to `longPollSince`. */
  readonly sincePollIntervalMs?: number;
}

/**
 * Build a Workers module-default export.
 *
 * Order on `fetch`: **healthz → verifier → router**. Health probes
 * don't pay for a Db construction; an auth challenge stops a bad
 * request before any Storage I/O; the router catches everything else.
 *
 * Observability: every HTTP request that flows past the verifier
 * runs inside a single `runWithContext` scope created up front in
 * this adapter — including the read-cache wrapper. The canonical
 * line emitted at end-of-request carries a top-level
 * `cache_status: "hit" | "miss" | "bypass"` field so operators can
 * split hit/miss/bypass directly from the log stream without
 * consulting a CDN dashboard. The router's observability middleware
 * detects the ambient context and passes through — the adapter owns
 * the flush.
 *
 * Cron Triggers are opt-in. Pass `options.scheduled` to wire one;
 * `wrangler.jsonc:triggers.crons` controls the firing cadence.
 * When `options.scheduled` is unset the cron tick is a no-op.
 *
 * The factory receives `env` on the first `fetch` or `scheduled`
 * invocation, resolves `BaerlyWorkerOptions` once, and caches the
 * result for the lifetime of the isolate. Cloudflare Workers cannot
 * `await` at the module top level — the factory pattern is the
 * supported way to read env bindings at startup.
 *
 * @example
 * ```ts
 * import { baerlyWorker } from "baerly-storage/cloudflare";
 * import config from "../../baerly.config.ts";
 *
 * // Dev default: `auth: "none"` in baerly.config.ts pins every
 * // request to `config.tenant`. Switch to `auth: "shared-secret"`
 * // for staging/prod and `wrangler secret put SHARED_SECRET`.
 * export default baerlyWorker(() => ({ config }));
 * ```
 */
export function baerlyWorker<E extends BaerlyEnv = BaerlyEnv>(
  factory: (env: E) => BaerlyWorkerOptions,
): ExportedHandler<E> {
  // Cached resolution: populated on first fetch/scheduled, reused on
  // every subsequent invocation. Cloudflare Workers can't `await` at
  // the module top level, so we lazy-init on first call to whichever
  // handler fires first.
  interface ResolvedState {
    readonly options: BaerlyWorkerOptions;
    readonly verifier: Verifier;
    readonly teeRecorder: ReturnType<typeof alsAwareRecorder>;
  }
  let resolved: ResolvedState | undefined;
  // Cached so every subsequent fetch re-throws the same error rather
  // than re-running `resolveVerifier` on every request after a
  // misconfig. Mirrors the "first fetch errors, every fetch errors"
  // contract documented on `auth: "shared-secret"` + missing env.
  let resolutionError: unknown;
  let observabilityConfigured = false;

  const ensureResolved = async (env: E): Promise<ResolvedState> => {
    if (resolutionError !== undefined) {
      throw resolutionError;
    }
    if (resolved === undefined) {
      try {
        const options = factory(env);
        const verifier = resolveVerifier({
          factoryVerifier: options.verifier,
          config: options.config,
          readEnv: (k) => {
            const value = (env as unknown as Record<string, unknown>)[k];
            return typeof value === "string" ? value : undefined;
          },
        });
        // Operator's long-term sink wrapped once with the ALS-aware tee.
        // The ALS lookup is per-call, so a single shared instance is safe
        // across all requests — each call resolves the bag from whichever
        // `runWithContext` scope is active.
        const operatorRecorder = options.metrics ?? noopMetricsRecorder;
        const teeRecorder = alsAwareRecorder(operatorRecorder);
        // Per-isolate kernel-recorder singleton. The module singleton is
        // safe in Workers because every isolate has its own module state.
        // Placed inside `ensureResolved` (not at top-level) because the
        // operator-supplied recorder is unknown until the first fetch.
        setKernelMetricsRecorder(teeRecorder);
        resolved = { options, verifier, teeRecorder };
      } catch (error) {
        resolutionError = error;
        throw error;
      }
    }
    // Lazy-init flag for `configureObservability`. CF Worker modules
    // cannot `await` at the module top level, so the first fetch /
    // scheduled invocation runs the configure. LogTape's `configure`
    // is idempotent (we always pass `reset: true`); a thundering-herd
    // race on the cold-start tick just re-runs the same config.
    if (!observabilityConfigured) {
      await configureObservability(resolveCfSink(resolved.options.observability));
      observabilityConfigured = true;
      // Emit the auth=none startup banner exactly once per isolate.
      // Suppress when an explicit `verifier:` override is in play —
      // the override wins, the log would be misleading. Suppress
      // when `auth === "shared-secret"` — the operator already knows.
      if (resolved.options.verifier === undefined && resolved.options.config.auth === "none") {
        getLogger(CATEGORY.http).info(
          `[baerly] auth=none — all requests resolve to tenant=${JSON.stringify(resolved.options.config.tenant)}`,
        );
      }
    }
    return resolved;
  };

  return {
    async fetch(req, env, ctx): Promise<Response> {
      const { options, verifier, teeRecorder } = await ensureResolved(env);

      // Opt-in dev landing page. Off in production (options.dev
      // unset); when set, GET / serves HTML and GET /favicon.ico
      // returns 204 so browsers don't pin a second JSON 404 next
      // to the landing page.
      const url = new URL(req.url);
      if (options.dev !== undefined && req.method === "GET") {
        if (url.pathname === "/") {
          return new Response(renderDevLanding(options.dev), {
            status: 200,
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        }
        if (url.pathname === "/favicon.ico") {
          return new Response(null, { status: 204 });
        }
      }

      // Healthz is always anonymous — Cloudflare's load balancer
      // probes it. Keep it ahead of the verifier check; serving it
      // here avoids a `Db.create` (and the canonical-line emission)
      // on every probe. The router no longer mounts healthz — only
      // the adapter does.
      if (req.method === "GET" && url.pathname === "/v1/healthz") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // Construct the per-request observability context up front so
      // EVERYTHING downstream — verifier rejection, `Db.create`, and
      // the read-cache wrapper — runs inside the same
      // `runWithContext` scope. Without this lift, a verifier
      // rejection (or a cache-hit short-circuit) would bypass
      // canonical-line emission entirely.
      //
      // The router's observability middleware (see `router.ts`
      // "Mode A") detects the ambient context and passes through —
      // it never creates a competing context, and it never flushes
      // its own line. The adapter owns the flush from here on.
      const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
      const obsCtx = createObservabilityContext({
        request_id: requestId,
      });

      // Tenant resolution: the Verifier owns it unconditionally.
      const result = await verifier(req);
      if (result === null) {
        return runWithContext(obsCtx, async () => flushUnauthorizedAndRespond(obsCtx, req));
      }
      const tenantPrefix = result.tenantPrefix;

      return runWithContext(obsCtx, async (): Promise<Response> => {
        // Storage is wrapped with `observableStorage(...)` so the
        // per-call class A/B counts and per-op duration histograms
        // land in BOTH the operator's long-term sink and (via the
        // ALS-aware tee) the per-request bag we just created. The
        // kernel-recorder singleton (set in `ensureResolved`) carries
        // the same tee through to Writer / compactor / GC emissions.
        const storage = observableStorage(r2BindingStorage(env.BUCKET), teeRecorder);
        const db = Db.create({
          storage,
          app: env.APP,
          tenant: tenantPrefix,
          config: options.config,
        });

        const app = createRouter({
          db,
          sinceTimeoutMs: options.sinceTimeoutMs,
          sincePollIntervalMs: options.sincePollIntervalMs,
        });

        let cacheStatus: CacheStatus = "bypass";
        let response: Response | undefined;
        let caughtError: unknown;
        try {
          // Hono's `fetch` returns `Response | Promise<Response>`;
          // `withReadCache` wants a `Promise<Response>`. Normalize
          // via `Promise.resolve` so the sync-return branch is wrapped.
          const cacheResult = await withReadCache(req, tenantPrefix, () =>
            Promise.resolve(app.fetch(req, env, ctx)),
          );
          cacheStatus = cacheResult.cache_status;
          response = cacheResult.response;
        } catch (error) {
          caughtError = error;
          throw error;
        } finally {
          const status = caughtError !== undefined ? 500 : (response?.status ?? 500);
          flushCanonicalLine(obsCtx, obsCtx.recorder, {
            unit: "http",
            status,
            outcome: deriveOutcome(req.method, status, caughtError),
            ...(caughtError !== undefined && { error: caughtError }),
            extra: {
              method: req.method,
              path: new URL(req.url).pathname,
              cache_status: cacheStatus,
            },
          });
        }
        // `response` is defined here — the `catch` arm above rethrew,
        // so reaching this line implies the try block completed.
        // Best-effort invalidate after writes. `ctx.waitUntil` keeps
        // the Worker alive for the cache.delete without blocking
        // the response.
        ctx.waitUntil(invalidateOnWrite(req, tenantPrefix, response!.status));
        return response!;
      });
    },

    async scheduled(event, env, ctx): Promise<void> {
      const { options } = await ensureResolved(env);
      if (options.scheduled !== undefined) {
        await options.scheduled(event, env, ctx);
      }
    },
  };
}
