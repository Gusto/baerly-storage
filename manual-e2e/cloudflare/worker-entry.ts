// Cloudflare Worker entry for the manual end-to-end check. This is a
// skeleton — not a production template. It exists so a maintainer can
// deploy `baerlyWorker()` against real R2 and run the check at
// `manual-e2e/cloudflare/e2e.test.ts`. Production users scaffold via
// `create-baerly` instead.
//
// Uses the productized `sharedSecret` preset factory from
// `@baerly/server` (see
// `packages/server/src/auth/presets/shared-secret.ts`). The deploy
// template emitted by `create-baerly` defaults to `cloudflareAccess()`
// instead; this entry stays on `sharedSecret`
// because the manual check runs without a CF Access tunnel.

import { baerlyWorker, type Env as BaerlyEnv } from "@baerly/adapter-cloudflare";
import { sharedSecret } from "@baerly/server";

/**
 * Worker env. Adds `SHARED_SECRET` (set via `wrangler secret put
 * SHARED_SECRET`) on top of `baerlyWorker`'s baseline `BUCKET` / `APP`
 * / `TENANT` / `CURRENT_JSON_KEY` / `CF_TIER` shape.
 */
interface E2eEnv extends BaerlyEnv {
  readonly SHARED_SECRET: string;
}

// Per-request handler construction is cheap — `Db.create` does no
// I/O at boot — but we cache the verifier closure to avoid rebuilding
// it on every fetch. `baerlyWorker(...)` itself is rebuilt per-request
// only because the verifier reads `env.SHARED_SECRET` lazily; the cost
// is one object alloc.
export default {
  async fetch(req, env, ctx): Promise<Response> {
    const handler = baerlyWorker({
      verifier: sharedSecret({ secret: env.SHARED_SECRET, tenantPrefix: "default" }),
    });
    // `baerlyWorker` returns `ExportedHandler<Env>`; the `.fetch`
    // signature is required by Workers and is always defined on
    // module-default handlers built this way.
    return handler.fetch!(req, env, ctx);
  },
  async scheduled(event, env, ctx): Promise<void> {
    const handler = baerlyWorker({
      verifier: sharedSecret({ secret: env.SHARED_SECRET, tenantPrefix: "default" }),
    });
    return handler.scheduled!(event, env, ctx);
  },
} satisfies ExportedHandler<E2eEnv>;
