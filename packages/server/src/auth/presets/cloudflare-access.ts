import { CLOUDFLARE_ACCESS_CONFIG_RESOLUTION, BaerlyError, type Verifier } from "@baerly/protocol";
import { bearerJwt } from "./bearer-jwt.ts";

/**
 * Options for {@link cloudflareAccess}.
 *
 * - `teamDomain` — your CF Access team name, e.g. `acme`: lowercase
 *   letters, digits and `-` only, not the full
 *   `acme.cloudflareaccess.com` host. The factory derives the JWKS URL
 *   from this:
 *   `https://<teamDomain>.cloudflareaccess.com/cdn-cgi/access/certs`
 *   and the issuer as
 *   `https://<teamDomain>.cloudflareaccess.com`.
 * - `audienceTag` — the "Application Audience (AUD) Tag" from
 *   the CF Access app config. 64-character hex string.
 * - `tenantClaim` — same as `BearerJwtOptions.tenantClaim`.
 *   Defaults to `"tenant"`. Set to a custom claim if you've wired
 *   CF Access to a SAML / OIDC provider that ships a tenant in a
 *   namespaced claim. The claim picks the tenant a request reads and
 *   writes, so it must be one only an IdP admin can set; a claim the
 *   user can edit lets them pick their own tenant. Mutually exclusive
 *   with `tenantPrefix`.
 * - `tenantPrefix` — pin every verified token to a fixed tenant
 *   string. Use for single-tenant CF Access deployments: vanilla
 *   CF Access JWTs ship `sub`/`email` but no `tenant` claim, so
 *   the default claim-based derivation 401s every request. Signature
 *   + audience + expiry checks are still enforced; only the
 *   tenant-derivation step is replaced. Must be non-empty and
 *   contain no `/`. Mutually exclusive with `tenantClaim`.
 * - `fetch` / `clockSkewMs` / `jwksCacheTtlMs` — forwarded to the
 *   inner `bearerJwt`.
 */
export interface CloudflareAccessOptions {
  readonly teamDomain: string;
  readonly audienceTag: string;
  readonly tenantClaim?: string;
  readonly tenantPrefix?: string;
  readonly fetch?: typeof fetch;
  readonly clockSkewMs?: number;
  readonly jwksCacheTtlMs?: number;
}

/**
 * Build a `Verifier` that consumes the `Cf-Access-Jwt-Assertion`
 * header CF Access injects in front of a protected Worker. The
 * Cloudflare-side scaffold (`examples/minimal-cloudflare/`) defaults
 * to this factory.
 *
 * Internally a thin shim over `bearerJwt` — pulls the JWT from the
 * CF-specific header, points at CF Access's JWKS, and pins
 * issuer/audience to the CF-Access shape.
 *
 * **Identity shape.** Same as {@link bearerJwt}: the returned
 * `identity` is the verified JWT payload CF Access mints (after IdP
 * sign-in). Useful claims are `identity.sub` (user id), `identity.email`,
 * `identity.identity_nonce` — see Cloudflare's "Application Token"
 * reference. The kernel types it as `unknown`; cast at the call site.
 *
 * @throws BaerlyError code="InvalidConfig" — `teamDomain` not a bare
 *   team name (`^[a-z0-9-]+$`), or `audienceTag` not 64 lowercase-hex
 *   chars.
 *
 * @example
 * ```ts
 * import { cloudflareAccess } from "@gusto/baerly-storage/auth";
 * const verifier = cloudflareAccess({
 *   teamDomain: "acme",
 *   audienceTag: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
 * });
 * ```
 *
 * @example Single-tenant CF Access (no `tenant` claim in the JWT)
 * ```ts
 * import { cloudflareAccess } from "@gusto/baerly-storage/auth";
 * const verifier = cloudflareAccess({
 *   teamDomain: "acme",
 *   audienceTag: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
 *   tenantPrefix: "main",
 * });
 * ```
 */
export const cloudflareAccess = (opts: CloudflareAccessOptions): Verifier => {
  // The team name is interpolated into the JWKS host, so anything past
  // `[a-z0-9-]` (a `/`, `@`, `.` or `:`) could point it at another host.
  if (!/^[a-z0-9-]+$/.test(opts.teamDomain)) {
    throw new BaerlyError(
      "InvalidConfig",
      `cloudflareAccess: teamDomain must be a bare team name of lowercase letters, digits and "-" (got ${JSON.stringify(
        opts.teamDomain,
      )})`,
      { resolution: CLOUDFLARE_ACCESS_CONFIG_RESOLUTION },
    );
  }
  if (!/^[0-9a-f]{64}$/.test(opts.audienceTag)) {
    throw new BaerlyError(
      "InvalidConfig",
      `cloudflareAccess: audienceTag must be 64 lowercase-hex chars (got ${JSON.stringify(
        opts.audienceTag,
      )})`,
      { resolution: CLOUDFLARE_ACCESS_CONFIG_RESOLUTION },
    );
  }
  const issuer = `https://${opts.teamDomain}.cloudflareaccess.com`;
  const inner = bearerJwt({
    jwks: `${issuer}/cdn-cgi/access/certs`,
    issuer,
    audience: opts.audienceTag,
    ...(opts.tenantClaim !== undefined && { tenantClaim: opts.tenantClaim }),
    ...(opts.tenantPrefix !== undefined && { tenantPrefix: opts.tenantPrefix }),
    ...(opts.fetch !== undefined && { fetch: opts.fetch }),
    ...(opts.clockSkewMs !== undefined && { clockSkewMs: opts.clockSkewMs }),
    ...(opts.jwksCacheTtlMs !== undefined && { jwksCacheTtlMs: opts.jwksCacheTtlMs }),
  });
  return async (req: Request) => {
    const cfHeader = req.headers.get("Cf-Access-Jwt-Assertion");
    if (cfHeader === null) {
      return null;
    }
    // Re-issue the request with the CF header masquerading as a
    // Bearer Authorization so the inner bearerJwt verifier sees the
    // shape it expects. Mutating headers on the original request is
    // unsafe (CF Workers freeze them); clone via Request constructor.
    // `set` replaces an Authorization header the app sent itself;
    // appending would join both values and fail verification.
    const headers = new Headers(req.headers);
    headers.set("Authorization", `Bearer ${cfHeader}`);
    const cloned = new Request(req.url, { method: req.method, headers });
    return inner(cloned);
  };
};
