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
}

export const defineConfig = (config: BaerlyAppConfig): BaerlyAppConfig => config;
