/**
 * Worker entry for minimal-cloudflare. Wires `@baerly/adapter-cloudflare`
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
 *
 * File path: `src/server/index.ts` (single-package layout; the
 * `@cloudflare/vite-plugin` reads `wrangler.jsonc:main` to find this
 * entry).
 */
import { baerlyWorker, type Env as BaerlyEnv } from "@baerly/adapter-cloudflare";
import { cloudflareAccess, sharedSecret } from "@baerly/server/auth";
import type { FriendlyLogLevel } from "@baerly/server/observability";
import type { Verifier } from "@baerly/protocol";

interface AppEnv extends BaerlyEnv {
  readonly SHARED_SECRET?: string;
  readonly CF_ACCESS_TEAM_DOMAIN?: string;
  readonly CF_ACCESS_AUDIENCE_TAG?: string;
  /**
   * Observability log level — `debug | info | warn | error`.
   * `info` (default) emits one canonical JSON line per request /
   * maintenance run on stdout (ingested by Workers Logs). `debug`
   * additionally emits per-storage-op events; high volume, leave
   * off in production.
   */
  readonly LOG_LEVEL?: FriendlyLogLevel;
  /**
   * Observability sample rate in `[0, 1]` for successful requests.
   * Errors are always kept; maintenance always emits. Default `0.1`.
   */
  readonly LOG_SAMPLE?: string;
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
    return sharedSecret({ secret: env.SHARED_SECRET, tenantPrefix: "minimal-demo" });
  }
  throw new Error(
    "No Verifier configured. Set SHARED_SECRET (wrangler secret put SHARED_SECRET) or " +
      "wire CF Access (set CF_ACCESS_TEAM_DOMAIN + CF_ACCESS_AUDIENCE_TAG).",
  );
};

/**
 * Build the `baerlyWorker` options bag. The observability config
 * pulls level + sample rate from the bound vars (`LOG_LEVEL`,
 * `LOG_SAMPLE`); leaving either unset falls through to the kernel
 * defaults (`info` level, `0.1` sample rate). See `wrangler.jsonc`
 * for the var declarations and the `AGENTS.md` "Maintenance loop"
 * section for the canonical-line field reference (or the
 * `observability` JSDoc on `@baerly/server` via your editor's TS
 * hover). Known gap: a CF cache-hit short-circuit emits no
 * canonical line by design.
 */
// For a local `wrangler dev` landing page, add:
//   dev: { app: env.APP, uiUrl: "http://localhost:5173" }
// — surfaces a small HTML page on `GET /` instead of the JSON
// 404 envelope. Gate on an env flag (e.g. `env.WORKER_ENV === "dev"`)
// so production Workers don't expose a landing page on the root.
const workerOptions = (env: AppEnv) => ({
  verifier: selectVerifier(env),
  observability: {
    level: env.LOG_LEVEL,
    sampleRate: env.LOG_SAMPLE !== undefined ? Number(env.LOG_SAMPLE) : 0.1,
  },
});

export default {
  async fetch(req, env, ctx): Promise<Response> {
    return baerlyWorker(workerOptions(env)).fetch!(req, env, ctx);
  },
  async scheduled(event, env, ctx): Promise<void> {
    return baerlyWorker(workerOptions(env)).scheduled!(event, env, ctx);
  },
} satisfies ExportedHandler<AppEnv>;
