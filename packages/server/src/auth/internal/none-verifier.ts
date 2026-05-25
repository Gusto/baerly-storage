import type { Verifier } from "@baerly/protocol";

/**
 * Internal helper backing `config.auth === "none"`. Returns a
 * `Verifier` that resolves every request to the supplied
 * `tenantPrefix` with `identity: { kind: "none" }`. The kernel
 * NEVER reads the `Authorization` header in this mode — the network
 * seam itself is the trust boundary.
 *
 * Discriminant note: `identity.kind === "none"` distinguishes the
 * "operator opted into auth=none in baerly.config.ts" branch from the
 * bearer-token paths (`kind: "shared-secret"`, `kind: "jwt"`, etc).
 *
 * Not part of the public surface. Consumed by `baerlyWorker` /
 * `baerlyNode` resolution; the operator-facing API is the typed
 * `auth: "none"` field on `BaerlyAppConfig`.
 *
 * @internal
 */
export const noAuthVerifier = (tenantPrefix: string): Verifier => {
  return async () => ({ tenantPrefix, identity: { kind: "none" } });
};
