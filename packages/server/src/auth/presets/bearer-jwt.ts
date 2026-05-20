import { BaerlyError, type Verifier, type VerifierResult } from "@baerly/protocol";
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  customFetch,
  errors as joseErrors,
  jwtVerify,
  type JWTPayload,
} from "jose";

/**
 * Options for {@link bearerJwt}.
 *
 * - `jwks` — JWKS URL (`https://<idp>/.well-known/jwks.json`) OR a
 *   pre-loaded JWKS object. URLs are fetched lazily and cached for
 *   {@link BearerJwtOptions.jwksCacheTtlMs} (default 10 minutes).
 * - `issuer` — required `iss` claim. JWTs with a different `iss` are
 *   rejected. Set to the issuer URL of your IdP (e.g.
 *   `https://login.example.com/`).
 * - `audience` — required `aud` claim. JWTs with a different `aud`
 *   are rejected. Set to the API's identifier (e.g.
 *   `https://api.example.com/`).
 * - `tenantClaim` — name of the claim that carries the tenant
 *   identifier. Defaults to `"tenant"`. Custom IdPs may use a
 *   namespaced claim (`"https://example.com/tenant"`); set to that
 *   string.
 * - `algorithms` — allowlist of `alg` header values. Defaults to
 *   `["RS256", "ES256", "EdDSA"]`. `none`, `HS256`, anything else
 *   is rejected without consulting the JWKS.
 * - `clockSkewMs` — tolerance for `exp` / `nbf` checks. Defaults to
 *   60 000 (60 s).
 * - `jwksCacheTtlMs` — JWKS HTTP cache TTL. Defaults to 600 000
 *   (10 min). The cache is per-factory-call; a fresh `bearerJwt()`
 *   call starts cold.
 * - `fetch` — `fetch` override. Defaults to `globalThis.fetch`.
 *   Tests inject a stub.
 */
export interface BearerJwtOptions {
  readonly jwks: string | JwksDocument;
  readonly issuer: string;
  readonly audience: string;
  readonly tenantClaim?: string;
  readonly algorithms?: readonly JwtAlgorithm[];
  readonly clockSkewMs?: number;
  readonly jwksCacheTtlMs?: number;
  readonly fetch?: typeof fetch;
}

/** Supported JWT signing algorithms. HS256 is intentionally absent — a
 * shared-secret JWT is just `sharedSecret` with a JSON envelope. */
export type JwtAlgorithm = "RS256" | "ES256" | "EdDSA";

/**
 * JWKS document — `{ keys: [...] }`. Each key is a JWK with `kty`,
 * `kid`, and algorithm-specific fields. Re-typed locally to keep
 * the factory's public surface library-agnostic.
 */
export interface JwksDocument {
  readonly keys: readonly Jwk[];
}

/**
 * Minimal JWK shape consumed by {@link bearerJwt}. Algorithm-specific
 * fields (`n`/`e` for RSA, `x`/`y`/`crv` for EC, `x`/`crv` for OKP)
 * are forwarded to `jose` directly so we don't have to enumerate them.
 */
export interface Jwk {
  readonly kty: string;
  readonly kid?: string;
  readonly alg?: string;
  readonly use?: string;
  readonly [extra: string]: unknown;
}

const DEFAULT_ALGORITHMS: readonly JwtAlgorithm[] = ["RS256", "ES256", "EdDSA"];
const DEFAULT_CLOCK_SKEW_MS = 60_000;
const DEFAULT_JWKS_CACHE_TTL_MS = 600_000;
const DEFAULT_TENANT_CLAIM = "tenant";
/** Minimum interval between JWKS refreshes triggered by unknown-`kid`
 * misses. Without this a flood of garbage tokens with random `kid`s
 * would hammer the IdP. Mapped to jose's `cooldownDuration`. */
const JWKS_KID_REFRESH_MIN_INTERVAL_MS = 60_000;

/**
 * Build a `Verifier` that accepts `Authorization: Bearer <jwt>`
 * and verifies the signature against a JWKS. Multi-tenant IdPs
 * (Auth0, Okta, Azure AD, Keycloak) ship a `/.well-known/jwks.json`
 * endpoint suitable for the `jwks` option.
 *
 * @throws BaerlyError code="InvalidConfig" — required option
 *   missing, `issuer`/`audience` empty, `algorithms` empty.
 * @throws BaerlyError code="NetworkError" — JWKS fetch failed AND
 *   the cache is cold. A stale cache hit on a network failure is
 *   preferred over throwing (jose serves the stale JWKS until the
 *   `cacheMaxAge` window elapses).
 *
 * @example
 * ```ts
 * import { bearerJwt } from "baerly-storage/auth";
 * const verifier = bearerJwt({
 *   jwks: "https://example.auth0.com/.well-known/jwks.json",
 *   issuer: "https://example.auth0.com/",
 *   audience: "https://api.example.com/",
 *   tenantClaim: "https://example.com/tenant",
 * });
 * ```
 */
export const bearerJwt = (opts: BearerJwtOptions): Verifier => {
  if (opts.issuer.length === 0) {
    throw new BaerlyError("InvalidConfig", "bearerJwt: issuer must be non-empty");
  }
  if (opts.audience.length === 0) {
    throw new BaerlyError("InvalidConfig", "bearerJwt: audience must be non-empty");
  }
  const algorithms: readonly JwtAlgorithm[] = opts.algorithms ?? DEFAULT_ALGORITHMS;
  if (algorithms.length === 0) {
    throw new BaerlyError("InvalidConfig", "bearerJwt: algorithms must be non-empty");
  }

  const tenantClaim = opts.tenantClaim ?? DEFAULT_TENANT_CLAIM;
  const clockToleranceSec = (opts.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS) / 1000;
  const cacheMaxAge = opts.jwksCacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS;

  const resolveKey =
    typeof opts.jwks === "string"
      ? createRemoteJWKSet(new URL(opts.jwks), {
          cacheMaxAge,
          cooldownDuration: JWKS_KID_REFRESH_MIN_INTERVAL_MS,
          // jose's FetchImplementation type narrows `headers`/`method`/
          // `redirect`/`signal` more aggressively than the platform
          // `fetch`; the runtime contract is identical.
          [customFetch]: opts.fetch as never,
        })
      : createLocalJWKSet({ keys: opts.jwks.keys as Jwk[] });

  return async (req: Request): Promise<VerifierResult | null> => {
    const header = req.headers.get("Authorization") ?? "";
    if (!header.startsWith("Bearer ")) {
      return null;
    }
    const token = header.slice("Bearer ".length);

    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, resolveKey, {
        issuer: opts.issuer,
        audience: opts.audience,
        algorithms: [...algorithms],
        clockTolerance: clockToleranceSec,
      }));
    } catch (error) {
      if (isJwksFetchFailure(error)) {
        throw new BaerlyError("NetworkError", "bearerJwt: JWKS fetch failed", error);
      }
      return null;
    }

    const tenantValue = payload[tenantClaim];
    if (
      typeof tenantValue !== "string" ||
      tenantValue.length === 0 ||
      tenantValue.includes("/")
    ) {
      return null;
    }

    return { tenantPrefix: tenantValue, identity: payload };
  };
};

/**
 * Distinguish cold-cache JWKS network failures (must surface as
 * `BaerlyError{NetworkError}`) from token-level failures (return
 * null). jose passes raw `fetch` errors through unwrapped, so any
 * non-`JOSEError` thrown from `jwtVerify` came from the JWKS fetch
 * path. `JWKSInvalid` (bad payload / non-200) and `JWKSTimeout`
 * (request abort) are the JOSE subclasses that mean "couldn't get
 * a usable key set", as opposed to token-validation failures.
 */
const isJwksFetchFailure = (error: unknown): boolean => {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error instanceof joseErrors.JWKSInvalid || error instanceof joseErrors.JWKSTimeout) {
    return true;
  }
  return !(error instanceof joseErrors.JOSEError);
};
