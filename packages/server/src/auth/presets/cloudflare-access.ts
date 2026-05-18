import { BaerlyError, type Verifier } from "@baerly/protocol";
import { bearerJwt } from "./bearer-jwt.ts";

/**
 * Options for {@link cloudflareAccess}.
 *
 * - `teamDomain` — your CF Access team domain, e.g. `acme`. The
 *   factory derives the JWKS URL from this:
 *   `https://<teamDomain>.cloudflareaccess.com/cdn-cgi/access/certs`
 *   and the issuer as
 *   `https://<teamDomain>.cloudflareaccess.com`.
 * - `audienceTag` — the "Application Audience (AUD) Tag" from
 *   the CF Access app config. 64-character hex string.
 * - `tenantClaim` — same as `BearerJwtOptions.tenantClaim`.
 *   Defaults to `"tenant"`. Set to a custom claim if you've wired
 *   CF Access to a SAML / OIDC provider that ships a tenant in a
 *   namespaced claim.
 * - `fetch` / `clockSkewMs` / `jwksCacheTtlMs` — forwarded to the
 *   inner `bearerJwt`.
 */
export interface CloudflareAccessOptions {
  readonly teamDomain: string;
  readonly audienceTag: string;
  readonly tenantClaim?: string;
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
 * @throws BaerlyError code="InvalidConfig" — `teamDomain` or
 *   `audienceTag` empty, or `audienceTag` not 64 lowercase-hex chars.
 *
 * @example
 * ```ts
 * import { cloudflareAccess } from "baerly-storage/auth";
 * const verifier = cloudflareAccess({
 *   teamDomain: "acme",
 *   audienceTag: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
 * });
 * ```
 */
export const cloudflareAccess = (opts: CloudflareAccessOptions): Verifier => {
  if (opts.teamDomain.length === 0) {
    throw new BaerlyError("InvalidConfig", "cloudflareAccess: teamDomain must be non-empty");
  }
  if (!/^[0-9a-f]{64}$/.test(opts.audienceTag)) {
    throw new BaerlyError(
      "InvalidConfig",
      `cloudflareAccess: audienceTag must be 64 lowercase-hex chars (got ${JSON.stringify(
        opts.audienceTag,
      )})`,
    );
  }
  const issuer = `https://${opts.teamDomain}.cloudflareaccess.com`;
  const inner = bearerJwt({
    jwks: `${issuer}/cdn-cgi/access/certs`,
    issuer,
    audience: opts.audienceTag,
    ...(opts.tenantClaim !== undefined && { tenantClaim: opts.tenantClaim }),
    ...(opts.fetch !== undefined && { fetch: opts.fetch }),
    ...(opts.clockSkewMs !== undefined && { clockSkewMs: opts.clockSkewMs }),
    ...(opts.jwksCacheTtlMs !== undefined && { jwksCacheTtlMs: opts.jwksCacheTtlMs }),
  });
  return async (req: Request) => {
    const cfHeader = req.headers.get("Cf-Access-Jwt-Assertion");
    if (cfHeader === null) return null;
    // Re-issue the request with the CF header masquerading as a
    // Bearer Authorization so the inner bearerJwt verifier sees the
    // shape it expects. Mutating headers on the original request is
    // unsafe (CF Workers freeze them); clone via Request constructor.
    const cloned = new Request(req.url, {
      method: req.method,
      headers: new Headers([...req.headers.entries(), ["Authorization", `Bearer ${cfHeader}`]]),
    });
    return inner(cloned);
  };
};
