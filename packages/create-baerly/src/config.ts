/**
 * `defineConfig` passthrough for the emitted `baerly.config.ts`.
 *
 * Exists so the scaffolded `baerly.config.ts` can `import { defineConfig }
 * from "create-baerly/config"` and get IDE / `tsgo` type inference on
 * `BaerlyAppConfig` without the user importing the type explicitly.
 * Pure identity function at runtime — the scaffolder never reads this
 * file at scaffold time.
 */

export interface BaerlyAppConfig {
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
   * Deploy target — `"cloudflare"` or `"node"`. Read by `baerly
   * deploy` to dispatch the correct deploy command.
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
}

export const defineConfig = (config: BaerlyAppConfig): BaerlyAppConfig => config;
