// Imported from the leaf module, NOT the `@baerly/dev` barrel. The barrel
// re-exports `LocalFsStorage`, and pulling this through it chunks the whole
// Node-only local-fs closure — `node:crypto`, `node:fs/promises`, `node:os`,
// `node:path` — into the Worker bundle for the sake of one HTML string.
// `dev-landing.ts` has no imports at all.
import { type DevLandingOptions, renderDevLanding } from "@baerly/dev/dev-landing";
import {
  type BaerlyAppConfig,
  CF_FREE_MAX_SAFE_FOLD_BYTES,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_CF_PAID,
  type Storage,
  type Verifier,
} from "@baerly/protocol";
import { Db, resolveVerifier } from "@baerly/server";
import { createRouter } from "@baerly/server/http";
import { handleSpecRequest } from "@baerly/server/spec";
import { type MaintenanceDispatch, parseMaintenanceEnv } from "@baerly/server/maintenance";
import {
  CATEGORY,
  type ObservabilityConfig,
  configureObservability,
  createObservabilityContext,
  deriveOutcome,
  flushCanonicalLine,
  flushUnauthorizedAndRespond,
  getLogger,
  observableStorage,
  runWithContext,
} from "@baerly/server/observability";
import { type CacheStatus, invalidateOnWrite, withReadCache } from "./cache.ts";
import { resolveWorkerStorage } from "./resolve-storage.ts";

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
 * import type { BaerlyEnv } from "@gusto/baerly-storage/cloudflare";
 *
 * interface AppEnv extends BaerlyEnv {
 *   readonly TENANT: string;
 *   readonly SHARED_SECRET?: string;
 * }
 * ```
 *
 * ## In-band maintenance ops-plane vars
 *
 * Three OPTIONAL `vars` tune the write-tick maintenance the adapter
 * dispatches via `ctx.waitUntil` (CF `vars` are always strings):
 *
 *   - `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` — override the snapshot-rebuild
 *     ceiling `C` that the resolved profile carries. The `cf-free` value
 *     (512 KiB) is sized to rebuild in ~5.5 ms under the CF-free ~10 ms
 *     CPU budget; `cf-paid` carries 8 MiB. This var wins over either. On
 *     the free profile a value above {@link CF_FREE_MAX_SAFE_FOLD_BYTES}
 *     warns LOUDLY once at init — on a free isolate that fold risks a
 *     mid-rebuild CPU kill.
 *   - `BAERLY_MAINTENANCE_DISABLE` — kill switch. Any non-empty value
 *     other than `"0"` / `"false"` disables write-tick maintenance.
 *   - `BAERLY_MAINTENANCE_PROFILE` — opt-in profile selector. Set to
 *     `"cf-paid"` on a paid Worker to select
 *     {@link MAINTENANCE_PROFILE_CF_PAID}, which raises BOTH the per-pass
 *     throughput caps (GC marks/sweeps, fold entries per pass) to the
 *     Node-tier values, exploiting the paid 10,000-subrequest budget, AND
 *     the snapshot ceilings to `C` = 8 MiB / `E` = 32,768. Default /
 *     unknown values resolve to `cf-free` (unchanged zero-config
 *     behaviour). `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` still overrides `C`
 *     on top of whichever profile resolves; `E` has no var, so the
 *     profile switch is the ONLY way to raise the row arm on Cloudflare.
 *     Must be set consistently on BOTH the write-tick path and the cron
 *     path (use {@link resolveCfMaintenanceProfile} in your
 *     {@link WorkerScheduledHandler}).
 */
export interface BaerlyEnv {
  BUCKET?: R2Bucket;
  APP: string;
  /**
   * Override the snapshot-rebuild ceiling `C` the resolved profile
   * carries (512 KiB on `cf-free`, 8 MiB on `cf-paid`). Parsed as a
   * number; ignored when unset / non-numeric. On the free profile a
   * value above {@link CF_FREE_MAX_SAFE_FOLD_BYTES} warns once at init.
   */
  BAERLY_MAINTENANCE_MAX_FOLD_BYTES?: string;
  /**
   * Write-tick maintenance kill switch. Truthy (non-empty, not
   * `"0"` / `"false"`) disables the in-band fold + GC dispatch.
   */
  BAERLY_MAINTENANCE_DISABLE?: string;
  /**
   * Opt-in maintenance profile. `"cf-paid"` raises per-pass throughput
   * caps to Node-tier values on a paid Worker isolate AND takes the paid
   * snapshot ceilings (`C` = 8 MiB, `E` = 32,768). Default / unknown
   * values resolve to `cf-free`.
   */
  BAERLY_MAINTENANCE_PROFILE?: string;
}

/**
 * Resolve the maintenance profile from the opt-in operator env var.
 * Default (unset / unknown) is the CPU-killable CF-free profile, so
 * zero-config behavior is unchanged. `cf-paid` raises the per-pass caps
 * to exploit the paid 10,000-subrequest budget AND the snapshot ceilings
 * to `C` = 8 MiB / `E` = 32,768, measured against the paid isolate's own
 * memory wall rather than free's CPU wall. Used by BOTH the write-tick
 * dispatch and the cron path so the two maintenance triggers stay
 * coherent when the operator wires the recipe below into their
 * scheduled handler.
 */
export const resolveCfMaintenanceProfile = (readEnv: (key: string) => string | undefined) =>
  readEnv("BAERLY_MAINTENANCE_PROFILE") === "cf-paid"
    ? MAINTENANCE_PROFILE_CF_PAID
    : MAINTENANCE_PROFILE_CF_FREE;

/**
 * Assemble the per-request {@link MaintenanceDispatch} for a Cloudflare
 * Worker.
 *
 * baerly maintains IN-BAND: the writer reads
 * `getCurrentContext()?.maintenance` at its post-commit dispatch point and
 * runs one bounded compact + GC slice on the (rare) write that crosses a
 * maintenance trigger. Reads stay pure — they never tick. There is no
 * cron, no `triggers`, no operator-installed scheduler.
 *
 * On Cloudflare the fold runs in a `ctx.waitUntil` continuation — FIRE
 * AND FORGET off the response ack, so the commit never blocks on it. The
 * isolate stays alive long enough to drain the continuation; the
 * per-pass caps default to the TESTED CF-free `WRITE_TICK_*` values
 * (`phasesPerTick: "single"` — a CPU-killable free isolate does ONE of
 * fold/GC per request, never both), sized so a single pass stays well
 * under the free-tier 50-subrequest budget. Free stays at 50 external /
 * 1,000 internal-service subrequests. An operator on CF **paid** opts
 * into the whole paid tier — per-pass caps AND snapshot ceilings — with
 * `BAERLY_MAINTENANCE_PROFILE=cf-paid`, which is what exploits the
 * 10,000-subrequest paid budget (the default since 2026-02-11, up from
 * 1,000, and configurable to 10M).
 *
 * The three ops-plane vars are read off the `env` BINDING (a string map),
 * NOT `process.env` — Workers have no process env:
 *
 *   - `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` → `maxFoldBytes` (`C`), which
 *     overrides the resolved profile's ceiling. Parsed as a number;
 *     ignored when unset / NaN.
 *   - `BAERLY_MAINTENANCE_DISABLE` → `disabled` (kill switch). Truthy
 *     when set to a non-empty value other than `"0"` / `"false"`.
 *   - `BAERLY_MAINTENANCE_PROFILE` → `options.profile`, via
 *     {@link resolveCfMaintenanceProfile}.
 *
 * `readEnv` defaults to reading off the bound `env`; the parameter
 * exists for direct unit coverage.
 */
export const cfMaintenanceDispatch = (
  ctx: ExecutionContext,
  readEnv: (key: string) => string | undefined,
): MaintenanceDispatch => {
  const { maxFoldBytes, disabled } = parseMaintenanceEnv(readEnv);

  return {
    // CF dispatches the fold off the ack via `ctx.waitUntil` — the
    // isolate stays alive to drain it without blocking the response.
    dispatch: (task: () => Promise<void>): void => ctx.waitUntil(task()),
    ...(disabled && { disabled: true }),
    ...(maxFoldBytes !== undefined && { maxFoldBytes }),
    options: {
      // A CPU-killable free isolate does ONE phase per request.
      phasesPerTick: "single",
      // Write-tick profile. The cron path (user-supplied `scheduled` callback)
      // resolves the profile via the SAME `resolveCfMaintenanceProfile` export
      // so the two maintenance triggers stay coherent when the operator wires
      // the recipe below into their `scheduled` handler.
      profile: resolveCfMaintenanceProfile(readEnv),
    },
  };
};

/**
 * Cron Trigger handler. Called once per tick when the user has
 * declared `triggers.crons` in `wrangler.jsonc` AND passed this
 * option. The body owns its own subrequest budget — wrap any
 * outlasting work in `ctx.waitUntil(...)`. On Cloudflare Free, one
 * invocation must process only one `current.json` key and one direct
 * `compact()` or `runGc()` phase; alternate phases and shard cron
 * triggers or persist a collection cursor instead of looping tenants /
 * collections. Cloudflare Paid may use {@link runScheduledMaintenance}
 * within its larger invocation budget.
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
   * Request-time `Storage`. **Optional.** When unset, the Worker uses
   * the same-account R2 binding `env.BUCKET` (the dominant path). Inject
   * this to talk to S3 / cross-account R2 over the S3 REST API
   * from a Worker — e.g. `new S3HttpStorage(...)` +
   * `sigV4Signer(...)` from `@gusto/baerly-storage/s3`. Resolved once
   * per isolate inside the factory (where `env` is in scope), same as
   * the R2 binding.
   */
  readonly storage?: Storage;
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
   * Observability config (LogTape sink + level). When supplied, the
   * Worker calls {@link configureObservability} lazily on first
   * `fetch` / `scheduled` invocation (CF Worker modules can't
   * `await` at the top level). `configureObservability` is
   * idempotent over baerly's own config — it re-runs with
   * `{ reset: true }`, last call wins — and skips over a host config
   * it detects, so re-invocation is harmless.
   *
   * - `level` falls through to `env.LOG_LEVEL` (when typed option
   *   is undefined).
   * - `sink` defaults to `"console-json"` (Cloudflare's stdout is
   *   ingested by Workers Logs as JSON-shaped records).
   *
   * When the field is unset (or `{}`), baerly auto-configures on first
   * `fetch`. Pass `false` to skip configuration entirely — the escape
   * hatch for Workers that embed baerly and own the isolate-wide
   * LogTape configuration themselves. (baerly also never clobbers a
   * host config it detects; `false` additionally suppresses the
   * configure attempt and its meta-logger notice.)
   */
  readonly observability?: ObservabilityConfig | false;
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
 * import { baerlyWorker } from "@gusto/baerly-storage/cloudflare";
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
    // Base Storage resolved once per isolate (injected `options.storage`
    // or the `env.BUCKET` R2 binding), same lifetime as `verifier`. The
    // per-request `observableStorage(...)` wrap still happens on every
    // request — it binds to the request's observability bag — but the
    // underlying handle is no longer reconstructed each time.
    readonly storage: Storage;
  }
  let resolved: ResolvedState | undefined;
  // Cached so every subsequent fetch re-throws the same error rather
  // than re-running `resolveVerifier` on every request after a
  // misconfig. Mirrors the "first fetch errors, every fetch errors"
  // contract documented on `auth: "shared-secret"` + missing env.
  let resolutionError: unknown;
  let observabilityConfigured = false;
  // Fired at most once per isolate: an operator who raised the snapshot
  // ceiling above what a free CF isolate can rebuild in one shot gets a
  // loud warning. Init-scoped (not per-request) so a busy Worker doesn't
  // spam the log stream.
  let maintenanceCeilingWarned = false;

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
        resolved = { options, verifier, storage: resolveWorkerStorage(options, env) };
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
    if (!observabilityConfigured && resolved.options.observability !== false) {
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
    // Ops-plane guardrail, init-scoped: if the operator raised the
    // snapshot-rebuild ceiling above what a CF FREE isolate can rebuild
    // under its ~10 ms CPU budget, warn LOUDLY exactly once. A fold over
    // this size on a free isolate gets CPU-killed mid-rebuild — the CAS
    // never lands, so the fold silently never advances `log_seq_start`
    // and the tail grows unbounded. `console.warn` (not LogTape) so the
    // signal survives even when observability is unconfigured.
    //
    // Scoped to the FREE profile. `CF_FREE_MAX_SAFE_FOLD_BYTES` is free's
    // CPU wall, and the warning's own first remedy is "run on CF PAID" —
    // an operator who set `BAERLY_MAINTENANCE_PROFILE=cf-paid` has taken
    // it, and the paid profile's own ceiling (8 MiB) is already 8x this
    // bound. Warning them would contradict the advice. There is no paid
    // equivalent of this guardrail because paid's ceiling is memory-bound,
    // not CPU-bound, and no safe-override threshold has been measured
    // above it.
    if (!maintenanceCeilingWarned) {
      maintenanceCeilingWarned = true;
      const rawFoldBytes = (env as unknown as Record<string, unknown>)[
        "BAERLY_MAINTENANCE_MAX_FOLD_BYTES"
      ];
      const { maxFoldBytes } = parseMaintenanceEnv((k) =>
        typeof rawFoldBytes === "string" && k === "BAERLY_MAINTENANCE_MAX_FOLD_BYTES"
          ? rawFoldBytes
          : undefined,
      );
      const onFreeProfile =
        resolveCfMaintenanceProfile((k) => {
          const v = (env as unknown as Record<string, unknown>)[k];
          return typeof v === "string" ? v : undefined;
        }) === MAINTENANCE_PROFILE_CF_FREE;
      if (
        onFreeProfile &&
        maxFoldBytes !== undefined &&
        maxFoldBytes > CF_FREE_MAX_SAFE_FOLD_BYTES
      ) {
        console.warn(
          `[baerly] BAERLY_MAINTENANCE_MAX_FOLD_BYTES=${rawFoldBytes} exceeds the ` +
            `CF free-tier safe ceiling (${CF_FREE_MAX_SAFE_FOLD_BYTES} bytes). On a free ` +
            `Worker a fold this large risks a mid-rebuild CPU kill (the ~10 ms limit): the ` +
            `current.json CAS never lands, so the fold silently does NOT advance and the tail ` +
            `grows unbounded. Safe remedies: run on CF PAID (raised CPU limits), self-host on ` +
            `NODE, or wait for §11 chunked snapshots. Leave this var unset on free CF.`,
        );
      }
    }
    return resolved;
  };

  return {
    async fetch(req, env, ctx): Promise<Response> {
      const url = new URL(req.url);

      // /v1/spec — anonymous static contract IR. Keep this before
      // `ensureResolved`: even a verifier/config-resolution failure
      // should not hide the public machine contract. Tenant collections
      // are appended only when resolution succeeds AND the verifier
      // accepts.
      if (req.method === "GET" && url.pathname === "/v1/spec") {
        return handleSpecRequest(req, async () => {
          const { options, verifier } = await ensureResolved(env);
          return { verifier, config: options.config };
        });
      }

      const { options, verifier, storage: baseStorage } = await ensureResolved(env);

      // Opt-in dev landing page. Off in production (options.dev
      // unset); when set, GET / serves HTML and GET /favicon.ico
      // returns 204 so browsers don't pin a second JSON 404 next
      // to the landing page.
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
      // In-band write-tick maintenance: the writer reads
      // `getCurrentContext()?.maintenance` at its post-commit dispatch
      // point. On CF the fold is dispatched via `ctx.waitUntil` (off the
      // ack) with the CF-free caps + `phasesPerTick: "single"`; the
      // ops-plane vars are read off the `env` binding (strings). Built
      // per request so a hot-swapped `env` is observed at call time.
      const obsCtx = createObservabilityContext({
        request_id: requestId,
        maintenance: cfMaintenanceDispatch(ctx, (k) => {
          const value = (env as unknown as Record<string, unknown>)[k];
          return typeof value === "string" ? value : undefined;
        }),
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
        // land in the active per-request bag. Writer / compactor / GC
        // emissions reach the same bag via `getCurrentContext()?.recorder`
        // — the canonical-line flusher reads it at end-of-request. The
        // base handle is resolved once per isolate (see `ResolvedState`);
        // only the observability wrap is per-request.
        const storage = observableStorage(baseStorage);
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
        // To honour BAERLY_MAINTENANCE_PROFILE on the cron path, reserve
        // `runScheduledMaintenance(args, CLOUDFLARE_PAID_TIER)` for
        // "cf-paid". On the Free default, alternate direct
        // `compact(args, CLOUDFLARE_FREE_TIER.compact)` and
        // `runGc(args, CLOUDFLARE_FREE_TIER.gc)` calls, with exactly one
        // collection/phase per invocation; shard or persist a collection
        // cursor instead of looping. Import those entry points from
        // `@gusto/baerly-storage/maintenance`, and use
        // `resolveCfMaintenanceProfile((k) => env[k])` here to select the
        // paid recipe when configured.
        await options.scheduled(event, env, ctx);
      }
    },
  };
}
