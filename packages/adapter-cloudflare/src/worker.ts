import { Db } from "@baerly/server";
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
 */
export interface Env {
  BUCKET: R2Bucket;
  APP: string;
  TENANT: string;
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

export interface BaerlyWorkerOptions {
  readonly handler?: WorkerHandler;
}

/**
 * Build a Workers module-default export.
 *
 * Phase 6 will ship a router that fills `options.handler`. Phase 3
 * callers who want their own routes pass `handler` directly; their
 * return value precedes the default `/v1/healthz` route so they can
 * override it. Returning `undefined` falls through.
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
  };
}
