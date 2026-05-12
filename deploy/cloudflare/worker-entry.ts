// Hand-rolled Worker entry for the real-deploy gate.
//
// NOT a production template — the sharedSecret Verifier
// here is inline and untested in isolation. A future deploy template ships preset
// Verifier factories (`sharedSecret`, `bearerJwt`, `cloudflareAccess`,
// ...) with a proper module surface.

import { baerlyWorker, type Env as BaerlyEnv } from "@baerly/adapter-cloudflare";
import type { Verifier } from "@baerly/protocol";

/**
 * Worker env. Adds `SHARED_SECRET` (set via `wrangler secret put
 * SHARED_SECRET`) on top of `baerlyWorker`'s baseline `BUCKET` / `APP`
 * / `TENANT` / `CURRENT_JSON_KEY` / `CF_TIER` shape.
 */
interface GateEnv extends BaerlyEnv {
  readonly SHARED_SECRET: string;
}

/**
 * Inline gate-only Verifier. Accepts `Authorization: Bearer
 * <SHARED_SECRET>`; rejects everything else with `null` so
 * `baerlyWorker` translates the result to a 401 + `BaerlyError{code:
 * "Unauthorized"}` envelope. A future version productizes via `@baerly/adapter-
 * cloudflare/presets/sharedSecret`.
 */
const sharedSecretVerifier = (secret: string): Verifier => {
  return async (req: Request) => {
    const auth = req.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${secret}`) return null;
    return { tenantPrefix: "default", identity: { kind: "shared-secret" } };
  };
};

// Per-request handler construction is cheap — `Db.create` does no
// I/O at boot — but we cache the verifier closure to avoid rebuilding
// it on every fetch. `baerlyWorker(...)` itself is rebuilt per-request
// only because the verifier reads `env.SHARED_SECRET` lazily; the cost
// is one object alloc.
export default {
  async fetch(req, env, ctx): Promise<Response> {
    const handler = baerlyWorker({
      verifier: sharedSecretVerifier(env.SHARED_SECRET),
    });
    // `baerlyWorker` returns `ExportedHandler<Env>`; the `.fetch`
    // signature is required by Workers and is always defined on
    // module-default handlers built this way.
    return handler.fetch!(req, env, ctx);
  },
  async scheduled(event, env, ctx): Promise<void> {
    const handler = baerlyWorker({
      verifier: sharedSecretVerifier(env.SHARED_SECRET),
    });
    return handler.scheduled!(event, env, ctx);
  },
} satisfies ExportedHandler<GateEnv>;
