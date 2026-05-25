import {
  type BaerlyAppConfig,
  BaerlyError,
  NO_AUTH_CONFIGURED_MESSAGE,
  SHARED_SECRET_MISSING_MESSAGE,
  type Verifier,
} from "@baerly/protocol";
import { sharedSecret } from "../presets/shared-secret.ts";
import { noAuthVerifier } from "./none-verifier.ts";

/**
 * Read env var lazily via a host-supplied accessor so the same
 * resolver works in CF Workers (env binding) and Node
 * (`process.env`). Returns `undefined` for an unset OR empty string —
 * both branches mean "operator forgot to set it".
 */
export type EnvAccessor = (name: string) => string | undefined;

/**
 * Inputs to {@link resolveVerifier}. `factoryVerifier` is the
 * adapter-factory `verifier:` option (may be undefined). `config`
 * carries the typed `auth` posture + the `tenant` pin. `readEnv`
 * is the per-host env accessor.
 */
export interface ResolveVerifierInput {
  readonly factoryVerifier: Verifier | undefined;
  readonly config: BaerlyAppConfig;
  readonly readEnv: EnvAccessor;
}

/**
 * Resolve the per-request `Verifier` for an adapter factory using the
 * fixed order:
 *
 *   1. `factoryVerifier` set → use as-is (highest precedence; enables
 *      env-aware construction via `cloudflareAccess(env)` etc).
 *   2. else `config.auth === "shared-secret"` → read `SHARED_SECRET`
 *      via `readEnv`; throw `BaerlyError("InvalidConfig",
 *      SHARED_SECRET_MISSING_MESSAGE)` when unset/empty; else build
 *      `sharedSecret({ secret, tenantPrefix: config.tenant })`.
 *   3. else `config.auth === "none"` → `noAuthVerifier(config.tenant)`.
 *   4. else → throw `BaerlyError("InvalidConfig",
 *      NO_AUTH_CONFIGURED_MESSAGE)`.
 *
 * Pure function — no I/O, no side effects beyond `sharedSecret`'s
 * own validation. Caller invokes once at adapter init time (or on
 * first fetch, depending on platform `await`-at-top-level
 * constraints).
 *
 * @throws BaerlyError code="InvalidConfig" — branches 2 and 4 above.
 *
 * @internal
 */
export const resolveVerifier = (input: ResolveVerifierInput): Verifier => {
  if (input.factoryVerifier !== undefined) {
    return input.factoryVerifier;
  }
  if (input.config.auth === "shared-secret") {
    const secret = input.readEnv("SHARED_SECRET");
    if (secret === undefined || secret.length === 0) {
      throw new BaerlyError("InvalidConfig", SHARED_SECRET_MISSING_MESSAGE);
    }
    return sharedSecret({ secret, tenantPrefix: input.config.tenant });
  }
  if (input.config.auth === "none") {
    return noAuthVerifier(input.config.tenant);
  }
  // Exhaustiveness backstop. The AuthConfig union is locked to
  // ["none", "shared-secret"]; reaching this branch means the caller
  // passed a config that has neither the typed field nor a factory
  // override. Same operator remediation as the type-level error.
  throw new BaerlyError("InvalidConfig", NO_AUTH_CONFIGURED_MESSAGE);
};
