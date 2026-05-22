/**
 * Worker entry for minimal-cloudflare. Handles every request via
 * `baerlyWorker`; the platform routes static assets to the
 * `wrangler.jsonc:assets` handler first and falls through to this
 * `fetch` only for paths Workers Assets couldn't satisfy.
 *
 * Verifier selection order — see `AGENTS.md` for the full deploy
 * recipe and the trade-offs between CF Access and shared secret.
 */
import { baerlyWorker, type BaerlyEnv } from "baerly-storage/cloudflare";
import { cloudflareAccess, sharedSecret } from "baerly-storage/auth";
import type { FriendlyLogLevel } from "baerly-storage/observability";
import type { Verifier } from "baerly-storage";
import config from "../../baerly.config.ts";

interface AppEnv extends BaerlyEnv {
  readonly TENANT: string;
  readonly SHARED_SECRET?: string;
  readonly CF_ACCESS_TEAM_DOMAIN?: string;
  readonly CF_ACCESS_AUDIENCE_TAG?: string;
  readonly LOG_LEVEL?: FriendlyLogLevel;
  readonly LOG_SAMPLE?: string;
}

const selectVerifier = (env: AppEnv): Verifier => {
  if (env.CF_ACCESS_TEAM_DOMAIN !== undefined && env.CF_ACCESS_AUDIENCE_TAG !== undefined) {
    return cloudflareAccess({
      teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
      audienceTag: env.CF_ACCESS_AUDIENCE_TAG,
    });
  }
  if (env.SHARED_SECRET !== undefined) {
    return sharedSecret({ secret: env.SHARED_SECRET, tenantPrefix: env.TENANT });
  }
  throw new Error(
    "No Verifier configured. Set SHARED_SECRET (wrangler secret put SHARED_SECRET) or " +
      "wire CF Access (set CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUDIENCE_TAG).",
  );
};

export default baerlyWorker<AppEnv>((env) => ({
  verifier: selectVerifier(env),
  config,
  observability: {
    level: env.LOG_LEVEL,
    sampleRate: env.LOG_SAMPLE !== undefined ? Number(env.LOG_SAMPLE) : 0.1,
  },
}));
