import { type DevLandingOptions, renderDevLanding } from "@baerly/dev";
import { type MetricsRecorder, type Verifier, noopMetricsRecorder } from "@baerly/protocol";
import { Db, createRouter } from "@baerly/server";
import {
  CLOUDFLARE_FREE_TIER,
  compact,
  runGc,
  runScheduledMaintenance,
} from "@baerly/server/maintenance";
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
 * Required Worker bindings. The caller wires these in
 * `wrangler.toml`:
 *
 *   [[r2_buckets]]
 *   binding = "BUCKET"
 *   bucket_name = "<your-bucket>"
 *
 *   [vars]
 *   APP    = "tickets"
 *   TENANT = "acme-co"
 *
 * `TENANT` is **not** special-cased by `baerlyWorker` — the
 * configured `Verifier` resolves the tenant from the request.
 * Single-tenant deployments that want the old "every request pins
 * to `env.TENANT`" behavior pass {@link singleTenantDevVerifier}
 * explicitly: `verifier: singleTenantDevVerifier(env.TENANT)`. The
 * binding is kept on `Env` so callers' existing `wrangler.toml`
 * files stay valid and so app code that wants `env.TENANT` for
 * its own composition (e.g. naming a `CURRENT_JSON_KEY`) can read it.
 *
 * Optional `CURRENT_JSON_KEY` + `CF_TIER` enable the default Cron
 * Trigger handler — see `scheduled` on {@link baerlyWorker}.
 */
export interface Env {
  BUCKET: R2Bucket;
  APP: string;
  TENANT: string;
  /**
   * Optional. Bucket-relative path of the `current.json` to maintain
   * on every Cron Trigger. Single-tenant Workers pin one table here;
   * multi-tenant Workers leave it unset and override
   * `options.scheduled` to enumerate their own tables.
   *
   * When unset (or empty), the default scheduled handler is a no-op.
   */
  CURRENT_JSON_KEY?: string;
  /**
   * Optional. `"free"` (default — 50-subrequest cap, alternates
   * compact / GC per minute) or `"paid"` (10k cap, runs both phases
   * every tick). Anything else is treated as `"free"`.
   */
  CF_TIER?: "free" | "paid";
}

/**
 * Custom handler hook. The router ships the full CRUD surface via
 * {@link createRouter}; callers who want to insert a route ahead of
 * the router (e.g. `/v1/admin/*`) wire it here. Returns `undefined`
 * to fall through to the default router.
 */
export type WorkerHandler = (
  req: Request,
  ctx: ExecutionContext,
  db: Db,
) => Promise<Response | undefined> | Response | undefined;

/**
 * Custom `scheduled` hook. Replaces the default Cron Trigger handler
 * entirely — useful for multi-tenant deployments that iterate a list
 * of `current.json` keys, or for operators that want bespoke
 * scheduling logic. Returns `void`; lifetime is managed via
 * `ctx.waitUntil()` inside the hook if it needs to outlast the
 * outer handler call.
 */
export type WorkerScheduledHandler = (
  event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
) => Promise<void> | void;

export interface BaerlyWorkerOptions {
  readonly handler?: WorkerHandler;
  /**
   * Optional override for the scheduled (Cron Trigger) tick. The
   * default handler reads `env.CURRENT_JSON_KEY` (no-op if unset)
   * and dispatches via `ctx.waitUntil()` based on `env.CF_TIER`:
   *
   *   - `"paid"` → one `runScheduledMaintenance()` per tick with
   *     engine defaults (unbounded). The 10k-subrequest budget
   *     comfortably folds the whole live tail and runs GC.
   *   - anything else (free tier) → alternate phases by minute:
   *     even-minute ticks call `compact()` with the
   *     {@link CLOUDFLARE_FREE_TIER} compact caps; odd-minute ticks
   *     call `runGc()` with the {@link CLOUDFLARE_FREE_TIER} gc
   *     caps. Either phase alone fits well under the 50-subrequest
   *     free-tier budget; running both per tick can overflow.
   *
   * Multi-tenant deployments override here to iterate `current.json`
   * keys or implement bespoke scheduling.
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
}

/**
 * Build a Workers module-default export.
 *
 * Order on `fetch`: **healthz → verifier → handler hook → router**.
 * Health probes don't pay for a Db construction; an auth challenge
 * stops a bad request before any Storage I/O; the custom handler
 * hook still gets first crack at the request after auth; the router
 * catches everything else.
 *
 * Observability: every HTTP request that flows past the verifier
 * runs inside a single `runWithContext` scope created up front in
 * this adapter — including the optional `handler` hook and the
 * read-cache wrapper. The canonical line emitted at end-of-request
 * carries a top-level `cache_status: "hit" | "miss" | "bypass"`
 * field so operators can split hit/miss/bypass directly from the
 * log stream without consulting a CDN dashboard. The router's
 * observability middleware detects the ambient context and passes
 * through — the adapter owns the flush.
 *
 * The `scheduled` handler wires Cron Triggers to the compactor +
 * GC. To enable it, add to `wrangler.toml`:
 *
 * ```toml
 * [triggers]
 * crons = ["* * * * *"]   # every minute
 *
 * [vars]
 * CURRENT_JSON_KEY = "app/tickets/tenant/acme/manifests/tickets/current.json"
 * CF_TIER          = "free"     # or "paid"
 * ```
 *
 * The free-tier handler alternates compaction (even minutes) with GC
 * (odd minutes) to stay under the 50-subrequest free-tier subrequest
 * cap; the paid-tier handler runs both phases every tick.
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
    if (observabilityConfigured) return;
    await configureObservability(resolveCfSink(options.observability));
    observabilityConfigured = true;
  };

  // Operator's long-term sink wrapped once with the ALS-aware tee.
  // The ALS lookup is per-call, so a single shared instance is safe
  // across all requests — each call resolves the bag from whichever
  // `runWithContext` scope is active.
  const operatorRecorder = options.metrics ?? noopMetricsRecorder;
  const teeRecorder = alsAwareRecorder(operatorRecorder);

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
      // EVERYTHING downstream — verifier rejection, `Db.create`, the
      // optional caller handler hook, and the read-cache wrapper —
      // runs inside the same `runWithContext` scope. Without this
      // lift, a verifier rejection (or a cache-hit short-circuit)
      // would bypass canonical-line emission entirely.
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
      // Single-tenant dev wires `singleTenantDevVerifier(env.TENANT)`
      // explicitly — `env.TENANT` is no longer a silent fallback.
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
        });

        // Caller hook can short-circuit the router. Returns undefined → fall through.
        // Runs inside `runWithContext` so any emissions it makes
        // (e.g. via `getCurrentContext()?.fields.set(...)`) land on
        // the same canonical line we flush below.
        if (options.handler !== undefined) {
          const out = await options.handler(req, ctx, db);
          if (out !== undefined) {
            flushCanonicalLine(obsCtx, obsCtx.recorder, {
              unit: "http",
              status: out.status,
              outcome: deriveOutcome(req.method, out.status),
              extra: { method: req.method, path: new URL(req.url).pathname },
            });
            return out;
          }
        }

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
        } catch (err) {
          caughtError = err;
          throw err;
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
        return;
      }
      if (env.CURRENT_JSON_KEY === undefined || env.CURRENT_JSON_KEY === "") {
        // Single-tenant default needs a target; multi-tenant
        // deployments override `options.scheduled` explicitly.
        return;
      }
      const isPaid = env.CF_TIER === "paid";
      // Storage wrapping mirrors the fetch path so the maintenance
      // canonical line (emitted by `withObservability("maintenance")`
      // inside `runScheduledMaintenance` / `compact` / `runGc`)
      // carries per-call storage counts too.
      const storage = observableStorage(r2BindingStorage(env.BUCKET), teeRecorder);
      const minute = new Date(event.scheduledTime).getUTCMinutes();
      const args = { storage, currentJsonKey: env.CURRENT_JSON_KEY };
      // `metrics:` is the bare `operatorRecorder` here — the cron
      // path opens its own `withObservability` scope inside
      // `runScheduledMaintenance` / `compact` / `runGc`, and
      // `compactInner`/`runGcInner` already tee operator with the
      // scope's per-run recorder for canonical-line fill. Passing
      // the ALS-aware `teeRecorder` would double-write the bag (the
      // ALS lookup resolves to the same recorder the inner tee writes
      // to). `teeRecorder` stays on `observableStorage` because the
      // storage observer has no scope-managed bag of its own.
      if (isPaid) {
        // Paid tier has 10k subrequest budget — let engine defaults
        // (unbounded) fold the whole live tail in one tick.
        ctx.waitUntil(
          runScheduledMaintenance(args, { metrics: operatorRecorder }).then(() => undefined),
        );
      } else if (minute % 2 === 0) {
        // Free tier: even-minute compact-only. CLOUDFLARE_FREE_TIER's
        // compact bounds (maxEntriesPerRun: 20, minEntriesToCompact: 50)
        // ride along on the spread at runtime.
        ctx.waitUntil(
          compact(args, { ...CLOUDFLARE_FREE_TIER.compact, metrics: operatorRecorder }).then(
            () => undefined,
          ),
        );
      } else {
        // Free tier: odd-minute gc-only. CLOUDFLARE_FREE_TIER's gc bounds
        // (maxMarksPerRun: 20, maxSweepsPerRun: 10) ride along.
        ctx.waitUntil(
          runGc(args, { ...CLOUDFLARE_FREE_TIER.gc, metrics: operatorRecorder }).then(
            () => undefined,
          ),
        );
      }
    },
  };
}
