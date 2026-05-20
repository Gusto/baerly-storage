import { type DevLandingOptions, renderDevLanding } from "@baerly/dev";
import { type MetricsRecorder, type Verifier, noopMetricsRecorder } from "@baerly/protocol";
import { type BaerlyConfig, Db, collectionsToMaps } from "@baerly/server";
import { createRouter } from "@baerly/server/http";
import {
  type ObservabilityConfig,
  alsAwareRecorder,
  configureObservability,
  createObservabilityContext,
  decideSample,
  deriveOutcome,
  flushCanonicalLine,
  flushUnauthorizedAndRespond,
  getEffectiveSampleRate,
  observableStorage,
  runWithContext,
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
 * import type { Env as BaerlyEnv } from "baerly-storage/cloudflare";
 *
 * interface AppEnv extends BaerlyEnv {
 *   readonly TENANT: string;
 *   readonly SHARED_SECRET?: string;
 * }
 * ```
 */
export interface Env {
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
  env: Env,
  ctx: ExecutionContext,
) => Promise<void> | void;

export interface BaerlyWorkerOptions {
  /**
   * Cron Trigger handler. When unset, `scheduled()` is a no-op even
   * if `triggers.crons` is declared. See {@link WorkerScheduledHandler}.
   */
  readonly scheduled?: WorkerScheduledHandler;
  /**
   * Per-request `Verifier`. **Required.** Every non-healthz request
   * runs the verifier first; the resolved `tenantPrefix` pins the
   * per-request `Db`. On `null`, the request short-circuits with 401.
   *
   * `GET /v1/healthz` bypasses the verifier so deploy readiness
   * probes don't need an auth token.
   *
   * For local single-tenant dev, use {@link singleTenantDevVerifier}.
   * Multi-tenant deployments compose their own verifier on top of a
   * real IdP — JWT, SigV4, Cloudflare Access, etc.
   */
  readonly verifier: Verifier;
  /**
   * Operator's long-term {@link MetricsRecorder}. Receives every
   * kernel emission (ServerWriter histograms, CAS-conflict counters,
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
   * Observability config (LogTape sink + level + head sample
   * rate). When supplied, the Worker calls
   * {@link configureObservability} lazily on first `fetch` /
   * `scheduled` invocation (CF Worker modules can't `await` at the
   * top level). `configureObservability` is idempotent — passing
   * `{ reset: true }` to LogTape — so re-invocation is harmless.
   *
   * Each field falls through to an env-var:
   * - `level` → `env.LOG_LEVEL` (when typed option is undefined).
   * - `sampleRate` → `env.LOG_SAMPLE`.
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
  /**
   * Your `baerly.config.ts` (or any object that satisfies
   * {@link BaerlyConfig}). When set, the adapter flattens
   * `collections[*].schema` and `collections[*].indexes` into the
   * per-collection maps that {@link Db.create} consumes — so
   * server-side schema validation fires on commits and the auto-
   * planner sees declared indexes.
   *
   * Without this option, declared collections have no effect on the
   * server's `/v1/t/*` surface: writes accept any shape and reads
   * fall back to the snapshot+log fold. Pass the value imported
   * from your `baerly.config.ts`:
   *
   * ```ts
   * import config from "../../baerly.config.ts";
   * export default baerlyWorker({ verifier, config });
   * ```
   *
   * Only `collections` is read — fields like `target`, `domain`,
   * `cloudflareAccess` are deploy-time concerns that the adapter
   * ignores.
   */
  readonly config?: BaerlyConfig;
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
 * @example
 * ```ts
 * import { baerlyWorker } from "baerly-storage/cloudflare";
 * import type { Verifier } from "baerly-storage";
 *
 * // Production: parse a bearer token and pin the tenant from a JWT
 * // claim. Preset factories handle JWKS / Cloudflare-Access.
 * const verifier: Verifier = async (req) => {
 *   const auth = req.headers.get("authorization");
 *   if (auth !== "Bearer dev-token") return null;
 *   return { tenantPrefix: "acme", identity: { sub: "dev" } };
 * };
 * export default baerlyWorker({ verifier });
 * ```
 */
export function baerlyWorker(options: BaerlyWorkerOptions): ExportedHandler<Env> {
  // Lazy-init flag for `configureObservability`. CF Worker modules
  // cannot `await` at the module top level, so the first fetch /
  // scheduled invocation runs the configure. LogTape's `configure`
  // is idempotent (we always pass `reset: true`); a thundering-herd
  // race on the cold-start tick just re-runs the same config.
  let observabilityConfigured = false;
  const ensureObservability = async (): Promise<void> => {
    if (observabilityConfigured) {
      return;
    }
    await configureObservability(resolveCfSink(options.observability));
    observabilityConfigured = true;
  };

  // Operator's long-term sink wrapped once with the ALS-aware tee.
  // The ALS lookup is per-call, so a single shared instance is safe
  // across all requests — each call resolves the bag from whichever
  // `runWithContext` scope is active.
  const operatorRecorder = options.metrics ?? noopMetricsRecorder;
  const teeRecorder = alsAwareRecorder(operatorRecorder);
  // Flatten declared collections once at factory time. Maps are
  // frozen-empty sentinels when `config` is unset so per-request
  // `Db.create` is allocation-free either way.
  const { schemas, indexes } = collectionsToMaps(options.config?.collections);

  return {
    async fetch(req, env, ctx): Promise<Response> {
      await ensureObservability();

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
      const sampleRate = getEffectiveSampleRate();
      const obsCtx = createObservabilityContext({
        request_id: requestId,
        sampled_by_head: decideSample(requestId, sampleRate),
      });

      // Tenant resolution: the Verifier owns it unconditionally.
      const result = await options.verifier(req);
      if (result === null) {
        return runWithContext(obsCtx, async () => flushUnauthorizedAndRespond(obsCtx, req));
      }
      const tenantPrefix = result.tenantPrefix;

      return runWithContext(obsCtx, async (): Promise<Response> => {
        // Storage is wrapped with `observableStorage(...)` so the
        // per-call class A/B counts and per-op duration histograms
        // land in BOTH the operator's long-term sink and (via the
        // ALS-aware tee) the per-request bag we just created. The
        // Db's `metrics: teeRecorder` carries the same tee through to
        // ServerWriter / compactor / GC emissions.
        const storage = observableStorage(r2BindingStorage(env.BUCKET), teeRecorder);
        const db = Db.create({
          storage,
          app: env.APP,
          tenant: tenantPrefix,
          metrics: teeRecorder,
          schemas,
          indexes,
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
      await ensureObservability();
      if (options.scheduled !== undefined) {
        await options.scheduled(event, env, ctx);
      }
    },
  };
}
