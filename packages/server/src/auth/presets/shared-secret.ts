import { BaerlyError, SHARED_SECRET_CONFIG_RESOLUTION, type Verifier } from "@baerly/protocol";
import { timingSafeEqual } from "../internal/timing-safe-equal.ts";

/**
 * Options for {@link sharedSecret}.
 *
 * - `secret` — the bearer token clients must present. Compared with
 *   constant-time `timingSafeEqual` — see {@link sharedSecret} for
 *   why naive `===` is not enough.
 * - `tenantPrefix` — the value returned in `VerifierResult.tenantPrefix`.
 *   Single-tenant deployments pass a constant (`"acme"`). Multi-tenant
 *   deployments don't use `sharedSecret`; they reach for `bearerJwt`
 *   or `cloudflareAccess` instead.
 */
export interface SharedSecretOptions {
  readonly secret: string;
  readonly tenantPrefix: string;
}

/**
 * Build a `Verifier` that accepts `Authorization: Bearer <secret>`
 * and pins every request to a single tenant. The simplest preset —
 * use for single-tenant deployments before you've stood up an IdP.
 *
 * **Why constant-time compare:** a naive `===` against the bearer
 * token leaks timing information about which character first
 * differed. Real-world relevance over HTTPS is debated, but
 * `timingSafeEqual` is one line of code and erases the question.
 *
 * **Identity shape.** On success the returned `VerifierResult` has:
 * ```ts
 * { tenantPrefix: "<configured>", identity: { kind: "shared-secret" } }
 * ```
 * `sharedSecret` has no notion of a per-user subject — every caller
 * presenting the bearer is the same principal. Downstream code that
 * wants a stable per-request `sender_sub` should fall back to a
 * synthetic value (`"shared-secret:" + tenantPrefix`) when
 * `identity.kind === "shared-secret"`. The `kind` field is the
 * discriminant across all preset identities; switch on it instead of
 * sniffing properties.
 *
 * @throws BaerlyError code="InvalidConfig" — `secret` empty or
 *   `tenantPrefix` empty / contains "/".
 *
 * @example
 * ```ts
 * import { sharedSecret } from "@gusto/baerly-storage/auth";
 * const verifier = sharedSecret({
 *   secret: env.SHARED_SECRET,
 *   tenantPrefix: "acme",
 * });
 * ```
 */
export const sharedSecret = (opts: SharedSecretOptions): Verifier => {
  if (opts.secret.length === 0) {
    throw new BaerlyError(
      "InvalidConfig",
      "sharedSecret: secret must be non-empty",
      undefined,
      undefined,
      undefined,
      SHARED_SECRET_CONFIG_RESOLUTION,
    );
  }
  if (opts.tenantPrefix.length === 0 || opts.tenantPrefix.includes("/")) {
    throw new BaerlyError(
      "InvalidConfig",
      `sharedSecret: tenantPrefix must be non-empty and "/"-free (got ${JSON.stringify(opts.tenantPrefix)})`,
      undefined,
      undefined,
      undefined,
      SHARED_SECRET_CONFIG_RESOLUTION,
    );
  }
  const expected = new TextEncoder().encode(`Bearer ${opts.secret}`);
  return async (req: Request) => {
    const header = req.headers.get("Authorization") ?? "";
    const actual = new TextEncoder().encode(header);
    if (!timingSafeEqual(expected, actual)) {
      return null;
    }
    return { tenantPrefix: opts.tenantPrefix, identity: { kind: "shared-secret" } };
  };
};
