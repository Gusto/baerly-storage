import { BaerlyError, type Verifier } from "@baerly/protocol";
import { timingSafeEqual } from "../internal/timing-safe-equal";

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
 * @throws BaerlyError code="InvalidConfig" — `secret` empty or
 *   `tenantPrefix` empty / contains "/".
 *
 * @example
 * ```ts
 * import { sharedSecret } from "@baerly/server/auth";
 * const verifier = sharedSecret({
 *   secret: env.SHARED_SECRET,
 *   tenantPrefix: "acme",
 * });
 * ```
 */
export const sharedSecret = (opts: SharedSecretOptions): Verifier => {
  if (opts.secret.length === 0) {
    throw new BaerlyError("InvalidConfig", "sharedSecret: secret must be non-empty");
  }
  if (opts.tenantPrefix.length === 0 || opts.tenantPrefix.includes("/")) {
    throw new BaerlyError(
      "InvalidConfig",
      `sharedSecret: tenantPrefix must be non-empty and "/"-free (got ${JSON.stringify(opts.tenantPrefix)})`,
    );
  }
  const expected = new TextEncoder().encode(`Bearer ${opts.secret}`);
  return async (req: Request) => {
    const header = req.headers.get("Authorization") ?? "";
    const actual = new TextEncoder().encode(header);
    if (!timingSafeEqual(expected, actual)) return null;
    return { tenantPrefix: opts.tenantPrefix, identity: { kind: "shared-secret" } };
  };
};
