/**
 * Worker entry for {{appName}}. Wires `@baerly/adapter-cloudflare`
 * to the bound R2 bucket and a `Verifier` selected at request time
 * from the bound vars.
 *
 * Verifier selection order:
 *   1. `cloudflareAccess()` — when both `CF_ACCESS_TEAM_DOMAIN`
 *      and `CF_ACCESS_AUDIENCE_TAG` are set as vars. Wire these in
 *      `wrangler.jsonc:vars` (or via `wrangler secret put` for the
 *      audience tag if you prefer to keep it out of source). Pair
 *      with Cloudflare Access in front of the Worker route.
 *   2. `sharedSecret()` — when `SHARED_SECRET` is set
 *      (`wrangler secret put SHARED_SECRET`). Used for parity with
 *      `wrangler dev` and for environments where CF Access isn't
 *      wired yet.
 *   3. Otherwise the Worker throws on first request. `baerly
 *      doctor --target=cloudflare` reports this case before deploy.
 */
import { baerlyWorker, type Env as BaerlyEnv } from "@baerly/adapter-cloudflare";
import { cloudflareAccess, sharedSecret } from "@baerly/server/auth";
import type { Verifier } from "@baerly/protocol";

interface AppEnv extends BaerlyEnv {
  readonly SHARED_SECRET?: string;
  readonly CF_ACCESS_TEAM_DOMAIN?: string;
  readonly CF_ACCESS_AUDIENCE_TAG?: string;
}

/**
 * Default verifier selection — CF Access when configured, else
 * shared secret. Production setups should always set
 * `cloudflareAccess` in `baerly.config.ts`. The shared-secret
 * branch is here so `wrangler dev` works without a CF Access
 * tunnel.
 */
const selectVerifier = (env: AppEnv): Verifier => {
  if (env.CF_ACCESS_TEAM_DOMAIN !== undefined && env.CF_ACCESS_AUDIENCE_TAG !== undefined) {
    return cloudflareAccess({
      teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
      audienceTag: env.CF_ACCESS_AUDIENCE_TAG,
    });
  }
  if (env.SHARED_SECRET !== undefined) {
    return sharedSecret({ secret: env.SHARED_SECRET, tenantPrefix: "{{tenant}}" });
  }
  throw new Error(
    "No Verifier configured. Set SHARED_SECRET (wrangler secret put SHARED_SECRET) or " +
      "wire CF Access (set CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUDIENCE_TAG).",
  );
};

export default {
  async fetch(req, env, ctx): Promise<Response> {
    return baerlyWorker({ verifier: selectVerifier(env) }).fetch!(req, env, ctx);
  },
  async scheduled(event, env, ctx): Promise<void> {
    return baerlyWorker({ verifier: selectVerifier(env) }).scheduled!(event, env, ctx);
  },
} satisfies ExportedHandler<AppEnv>;
