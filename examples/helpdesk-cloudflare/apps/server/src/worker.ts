/**
 * Worker entry for helpdesk-cloudflare. Routes /v1/* to baerlyWorker
 * (R2-backed) and falls through to env.ASSETS.fetch() for SPA navigation
 * (the built Vite bundle in ../web/dist).
 *
 * Verifier selection: cloudflareAccess() when both CF_ACCESS_TEAM_DOMAIN
 * and CF_ACCESS_AUDIENCE_TAG are set as vars, else sharedSecret() when
 * SHARED_SECRET is set, else throw on first request. Same chain as
 * minimal-cloudflare; the tenantPrefix sentinel rename gives the
 * scaffolded user their tenant.
 */
import { baerlyWorker, type Env as BaerlyEnv } from "@baerly/adapter-cloudflare";
import { cloudflareAccess, sharedSecret } from "@baerly/server/auth";
import type { FriendlyLogLevel } from "@baerly/server";
import type { Verifier } from "@baerly/protocol";

interface AppEnv extends BaerlyEnv {
  readonly ASSETS: Fetcher;
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
    return sharedSecret({ secret: env.SHARED_SECRET, tenantPrefix: "helpdesk-demo" });
  }
  throw new Error(
    "No Verifier configured. Set SHARED_SECRET (wrangler secret put SHARED_SECRET) or " +
      "wire CF Access (set CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUDIENCE_TAG).",
  );
};

const workerOptions = (env: AppEnv) => ({
  verifier: selectVerifier(env),
  observability: {
    level: env.LOG_LEVEL,
    sampleRate: env.LOG_SAMPLE !== undefined ? Number(env.LOG_SAMPLE) : 0.1,
  },
});

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith("/v1/")) {
      return baerlyWorker(workerOptions(env)).fetch!(req, env, ctx);
    }
    return env.ASSETS.fetch(req);
  },
  async scheduled(event, env, ctx): Promise<void> {
    return baerlyWorker(workerOptions(env)).scheduled!(event, env, ctx);
  },
} satisfies ExportedHandler<AppEnv>;
