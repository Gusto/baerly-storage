import {
  CLOUDFLARE_FREE_TIER,
  CLOUDFLARE_PAID_TIER,
  Db,
  runScheduledMaintenance,
} from "@baerly/server";
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
 * `TENANT` is a single-tenant deployment shortcut. Multi-tenant
 * Workers will derive `tenant` from the Phase 6 `Verifier` instead.
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
 * Custom handler hook. Phase 3 ships only `GET /v1/healthz`; callers
 * who want to ship before Phase 6 wire their own routes here.
 * Returns `undefined` to fall through to the default handler.
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
}

/**
 * Build a Workers module-default export.
 *
 * Phase 6 will ship a router that fills `options.handler`. Phase 3
 * callers who want their own routes pass `handler` directly; their
 * return value precedes the default `/v1/healthz` route so they can
 * override it. Returning `undefined` falls through.
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
 * export default baerlyWorker();
 * ```
 */
export function baerlyWorker(options: BaerlyWorkerOptions = {}): ExportedHandler<Env> {
  return {
    async fetch(req, env, ctx): Promise<Response> {
      // Per-request Db construction. The protocol kernel does no I/O
      // at boot; pooling matters only if a flamegraph says so.
      const storage = r2BindingStorage(env.BUCKET);
      const db = Db.create({ storage, app: env.APP, tenant: env.TENANT });

      if (options.handler !== undefined) {
        const out = await options.handler(req, ctx, db);
        if (out !== undefined) return out;
      }

      const url = new URL(req.url);
      if (req.method === "GET" && url.pathname === "/v1/healthz") {
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
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
