/**
 * `BaerlyAppConfig` + scaffold-flavoured `defineConfig`. Exposed at
 * `baerly-storage/config`. Imported by the `baerly.config.ts` that
 * `npm create baerly` emits, and by anyone who wants IDE/`tsgo` type
 * inference on the full scaffold-aware config shape (`target`,
 * `domain`, `cloudflareAccess`, etc.) on top of the runtime
 * `BaerlyConfig.collections` map.
 *
 * `BaerlyAppConfig extends BaerlyConfig` so one `baerly.config.ts`
 * carries both scaffold metadata (consumed by `baerly deploy` /
 * `baerly doctor`) and the runtime schema (consumed by `Db.create`).
 * The literal-pinned return type makes `collections` flow through to
 * `Db.create<TConfig>` and `createBaerlyClient<TConfig>`.
 *
 * The narrower `defineConfig<C extends BaerlyConfig>` on the root
 * barrel (`baerly-storage`) stays available for users who don't
 * scaffold via `npm create baerly` — both helpers are valid; the
 * subpath import is the scaffold flavour.
 */

import type { BaerlyConfig } from "./config.ts";

export interface BaerlyAppConfig extends BaerlyConfig {
  /** Bucket-prefix for this baerly app. One bucket per app. */
  readonly app: string;
  /**
   * Default tenant pin for `Verifier`s that don't derive a tenant
   * from a claim. Production `Verifier`s (`bearerJwt`,
   * `cloudflareAccess`) ignore this and derive `tenantPrefix` from
   * the request.
   */
  readonly tenant: string;
  /**
   * Deploy target — `"cloudflare"` or `"node"`.
   * Read by `baerly deploy` to dispatch the correct deploy command.
   */
  readonly target: "cloudflare" | "node";
  /**
   * Optional. Custom domain for the deployed service. Cloudflare:
   * wired to the Worker as a route. Node: rendered into the
   * Dockerfile's `EXPOSE` and the emitted readme.
   */
  readonly domain?: string | undefined;
  /**
   * Names of secrets the deployed runtime needs. `baerly deploy`
   * and `baerly doctor` check each against the platform's secret
   * store and warn (deploy) / report (doctor) when missing.
   * Default treatment (when unset) is `["SHARED_SECRET"]` — matches
   * the scaffolder's emitted Verifier wiring.
   */
  readonly requiredSecrets?: readonly string[];
  /**
   * Optional Cloudflare Access app config. When set, the production
   * CF template prefers `cloudflareAccess()` as the `Verifier` and
   * `baerly doctor --target=cloudflare` walks the CF Access app
   * config to confirm the audience tag matches.
   *
   * - `teamDomain` — CF Access team domain, e.g. `"acme"`.
   * - `audienceTag` — Application Audience (AUD) tag from the CF
   *   Access app, 64 lowercase-hex characters.
   */
  readonly cloudflareAccess?: {
    readonly teamDomain: string;
    readonly audienceTag: string;
  };
  /**
   * Optional observability overrides. The templates already
   * read `LOG_LEVEL` and `LOG_SAMPLE` from the runtime env; this
   * field is a typed-config alternative for deployments that prefer
   * to pin defaults in source. See `docs/guide/observability.md` for the
   * canonical-line shape and `docs/contributing/conventions/observability.md` for
   * the one-canonical-line-per-unit-of-work rule.
   *
   * - `level` — lowest record level reaching the sink. Falls back
   *   to the `LOG_LEVEL` env var, then to `"info"`.
   * - `sampleRate` — head-based sample rate for successful HTTP
   *   requests in `[0, 1]`. Falls back to the `LOG_SAMPLE` env var,
   *   then to `0.1`. Errors are always kept; maintenance always
   *   emits.
   */
  readonly observability?: {
    readonly level?: "debug" | "info" | "warn" | "error";
    readonly sampleRate?: number;
  };
}

export const defineConfig = <const C extends BaerlyAppConfig>(config: C): C => config;
