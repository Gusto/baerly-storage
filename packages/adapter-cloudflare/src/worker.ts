import type { Verifier } from "@baerly/protocol";
import {
  CLOUDFLARE_FREE_TIER,
  CLOUDFLARE_PAID_TIER,
  Db,
  createRouter,
  runScheduledMaintenance,
} from "@baerly/server";
import { invalidateOnWrite, withReadCache } from "./cache";
import { r2BindingStorage } from "./r2-binding-storage";

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
 * Custom handler hook. Phase 6 ships the full CRUD surface via
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
   * default handler reads `env.CURRENT_JSON_KEY` (no-op if unset),
   * picks {@link CLOUDFLARE_FREE_TIER} or {@link CLOUDFLARE_PAID_TIER}
   * from `env.CF_TIER`, and calls `runScheduledMaintenance()` via
   * `ctx.waitUntil()`. Multi-tenant deployments override here.
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
 * The `scheduled` handler wires Cron Triggers to the Phase-5
 * compactor + GC. To enable it, add to `wrangler.toml`:
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
 * import { baerlyWorker } from "@baerly/adapter-cloudflare/worker";
 * import type { Verifier } from "@baerly/protocol";
 *
 * // Production: parse a bearer token and pin the tenant from a JWT
 * // claim. Phase 8 preset factories handle JWKS / Cloudflare-Access.
 * const verifier: Verifier = async (req) => {
 *   const auth = req.headers.get("authorization");
 *   if (auth !== "Bearer dev-token") return null;
 *   return { tenantPrefix: "acme", identity: { sub: "dev" } };
 * };
 * export default baerlyWorker({ verifier });
 * ```
 */
export function baerlyWorker(options: BaerlyWorkerOptions): ExportedHandler<Env> {
  return {
    async fetch(req, env, ctx): Promise<Response> {
      // Healthz is always anonymous — Cloudflare's load balancer
      // probes it. Keep it ahead of the verifier check.
      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/v1/healthz") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // Tenant resolution: the Verifier owns it unconditionally.
      // Single-tenant dev wires `singleTenantDevVerifier(env.TENANT)`
      // explicitly — `env.TENANT` is no longer a silent fallback.
      const result = await options.verifier(req);
      if (result === null) {
        return new Response(
          JSON.stringify({
            error: { code: "Unauthorized", message: "Verifier returned null" },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        );
      }
      const tenantPrefix = result.tenantPrefix;

      const storage = r2BindingStorage(env.BUCKET);
      const db = Db.create({ storage, app: env.APP, tenant: tenantPrefix });

      // Caller hook can short-circuit the router. Returns undefined → fall through.
      if (options.handler !== undefined) {
        const out = await options.handler(req, ctx, db);
        if (out !== undefined) return out;
      }

      // `healthCheck: false` — already served above; keeps the probe
      // hot path off Db.create.
      const app = createRouter({ db, healthCheck: false });
      // Hono's `fetch` returns `Response | Promise<Response>`;
      // `withReadCache` wants a `Promise<Response>`. Normalize via
      // `Promise.resolve` so the sync-return branch is wrapped.
      const response = await withReadCache(req, tenantPrefix, () =>
        Promise.resolve(app.fetch(req, env, ctx)),
      );
      // Best-effort invalidate after writes. `ctx.waitUntil` keeps the
      // Worker alive for the cache.delete without blocking the response.
      ctx.waitUntil(invalidateOnWrite(req, tenantPrefix, response.status));
      return response;
    },

    async scheduled(event, env, ctx): Promise<void> {
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
      const profile = isPaid ? CLOUDFLARE_PAID_TIER : CLOUDFLARE_FREE_TIER;
      const storage = r2BindingStorage(env.BUCKET);
      // Even-minute → compact, odd-minute → GC. Halves the per-tick
      // subrequest budget on free tier (each phase fits well under
      // 50 ops; combined can exceed when the live tail is long).
      // Paid tier (10k cap) runs both phases every tick.
      const minute = new Date(event.scheduledTime).getUTCMinutes();
      const skipCompact = !isPaid && minute % 2 !== 0;
      const skipGc = !isPaid && minute % 2 === 0;
      ctx.waitUntil(
        runScheduledMaintenance(
          { storage, currentJsonKey: env.CURRENT_JSON_KEY },
          { ...profile, skipCompact, skipGc },
        ).then(() => undefined),
      );
    },
  };
}
