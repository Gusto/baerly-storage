import { BaerlyError, type Verifier, type VerifierResult } from "@baerly/protocol";

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
 * the factory zero-dep.
 */
export interface JwksDocument {
  readonly keys: readonly Jwk[];
}

/**
 * Minimal JWK shape consumed by {@link bearerJwt}. Algorithm-specific
 * fields (`n`/`e` for RSA, `x`/`y`/`crv` for EC, `x`/`crv` for OKP)
 * are read via `crypto.subtle.importKey` directly so we don't have to
 * enumerate them here.
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
 * would hammer the IdP. */
const JWKS_REFRESH_RATE_LIMIT_MS = 60_000;

type CachedKey = {
  readonly key: CryptoKey;
  readonly algorithm: JwtAlgorithm;
};

interface JwtHeader {
  readonly alg: string;
  readonly kid?: string;
  readonly typ?: string;
}

interface JwtPayload {
  readonly iss?: string;
  readonly aud?: string | readonly string[];
  readonly exp?: number;
  readonly nbf?: number;
  readonly [claim: string]: unknown;
}

/**
 * Build a `Verifier` that accepts `Authorization: Bearer <jwt>`
 * and verifies the signature against a JWKS. Multi-tenant IdPs
 * (Auth0, Okta, Azure AD, Keycloak) ship a `/.well-known/jwks.json`
 * endpoint suitable for the `jwks` option.
 *
 * Verification steps, in order:
 * 1. Pull token from `Authorization: Bearer <jwt>`. Missing → null.
 * 2. Decode header. `alg` not in `algorithms` → null.
 * 3. Look up the signing key by `kid`. Missing → JWKS refresh
 *    (once per request, rate-limited to one refresh per minute
 *    even on a 100 % miss rate). Still missing → null.
 * 4. Verify signature with `crypto.subtle.verify`. Bad → null.
 * 5. Check `iss`, `aud`, `exp`, `nbf` (within `clockSkewMs`).
 *    Any mismatch → null.
 * 6. Pull `tenantClaim` (default `tenant`) from the payload. Empty
 *    or contains `/` → null (treat as auth failure, not config —
 *    the IdP issued a JWT we can't honor).
 * 7. Return `{ tenantPrefix, identity: <full decoded payload> }`.
 *
 * **Idempotence.** The decoded payload is cached on the `Request`
 * via `WeakMap`. Two calls with the same `Request` decode + verify
 * exactly once.
 *
 * @throws BaerlyError code="InvalidConfig" — required option
 *   missing, `issuer`/`audience` empty, `algorithms` empty.
 * @throws BaerlyError code="NetworkError" — JWKS fetch failed AND
 *   the cache is cold. A stale cache hit on a network failure is
 *   preferred over throwing.
 *
 * @example
 * ```ts
 * import { bearerJwt } from "@baerly/server/auth";
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
  const clockSkewMs = opts.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;
  const jwksCacheTtlMs = opts.jwksCacheTtlMs ?? DEFAULT_JWKS_CACHE_TTL_MS;
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  // JWKS cache state. `keys` maps `kid` → imported CryptoKey; `expiresAt`
  // is the wall-clock time at which the cache is stale;
  // `lastKidMissRefreshAt` gates per-minute kid-miss refreshes
  // independently of the TTL-driven refresh so the first kid miss
  // after a fresh TTL warm still triggers exactly one refresh.
  let keys = new Map<string, CachedKey>();
  let expiresAt = 0;
  let lastKidMissRefreshAt = 0;
  let inflight: Promise<void> | null = null;

  const loadJwks = async (): Promise<void> => {
    if (inflight !== null) {
      await inflight;
      return;
    }
    inflight = (async () => {
      try {
        let doc: JwksDocument;
        if (typeof opts.jwks === "string") {
          let res: Response;
          try {
            res = await fetchImpl(opts.jwks);
          } catch (err) {
            throw new BaerlyError(
              "NetworkError",
              `bearerJwt: JWKS fetch failed (${opts.jwks})`,
              err,
            );
          }
          if (!res.ok) {
            throw new BaerlyError(
              "NetworkError",
              `bearerJwt: JWKS fetch returned ${res.status} (${opts.jwks})`,
            );
          }
          doc = (await res.json()) as JwksDocument;
        } else {
          doc = opts.jwks;
        }
        const next = new Map<string, CachedKey>();
        for (const jwk of doc.keys) {
          const alg = resolveJwkAlgorithm(jwk);
          if (alg === null) continue;
          if (!algorithms.includes(alg)) continue;
          const importParams = importParamsFor(alg);
          if (importParams === null) continue;
          let cryptoKey: CryptoKey;
          try {
            cryptoKey = await crypto.subtle.importKey(
              "jwk",
              jwk as JsonWebKey,
              importParams,
              false,
              ["verify"],
            );
          } catch {
            continue;
          }
          const kid = jwk.kid ?? "";
          next.set(kid, { key: cryptoKey, algorithm: alg });
        }
        keys = next;
        expiresAt = Date.now() + jwksCacheTtlMs;
      } finally {
        inflight = null;
      }
    })();
    await inflight;
  };

  const ensureFresh = async (): Promise<void> => {
    if (keys.size > 0 && Date.now() < expiresAt) return;
    try {
      await loadJwks();
    } catch (err) {
      if (keys.size > 0) {
        // Stale cache hit on a network failure: prefer serving stale
        // keys over throwing. Cold-cache failures still throw.
        return;
      }
      throw err;
    }
  };

  const tryRefreshOnKidMiss = async (): Promise<void> => {
    if (Date.now() - lastKidMissRefreshAt < JWKS_REFRESH_RATE_LIMIT_MS) return;
    lastKidMissRefreshAt = Date.now();
    try {
      await loadJwks();
    } catch {
      // Swallow — the verifier returns null below if the key still
      // isn't found. Cold-cache failures already surfaced via
      // ensureFresh() earlier in the verify path.
    }
  };

  const cache = new WeakMap<Request, Promise<VerifierResult | null>>();

  return (req: Request) => {
    const hit = cache.get(req);
    if (hit !== undefined) return hit;
    const promise = verify(req);
    cache.set(req, promise);
    return promise;
  };

  async function verify(req: Request): Promise<VerifierResult | null> {
    const header = req.headers.get("Authorization") ?? "";
    if (!header.startsWith("Bearer ")) return null;
    const token = header.slice("Bearer ".length);
    const segments = token.split(".");
    if (segments.length !== 3) return null;
    const [headerB64, payloadB64, signatureB64] = segments as [string, string, string];

    let jwtHeader: JwtHeader;
    let jwtPayload: JwtPayload;
    let signature: Uint8Array;
    try {
      jwtHeader = JSON.parse(textDecode(base64UrlDecode(headerB64))) as JwtHeader;
      jwtPayload = JSON.parse(textDecode(base64UrlDecode(payloadB64))) as JwtPayload;
      signature = base64UrlDecode(signatureB64);
    } catch {
      return null;
    }

    if (!isJwtAlgorithm(jwtHeader.alg) || !algorithms.includes(jwtHeader.alg)) {
      return null;
    }

    // Cold-cache fetch failure propagates as BaerlyError{NetworkError}
    // (per the docstring contract); a stale cache hit on a network
    // failure is preferred and handled inside ensureFresh.
    await ensureFresh();

    const kid = jwtHeader.kid ?? "";
    let cached = keys.get(kid);
    if (cached === undefined) {
      await tryRefreshOnKidMiss();
      cached = keys.get(kid);
      if (cached === undefined) return null;
    }
    if (cached.algorithm !== jwtHeader.alg) return null;

    if (jwtHeader.alg === "ES256" && signature.length !== 64) {
      // ES256 JWTs carry a raw r||s pair; crypto.subtle.verify expects
      // the same 64-byte format with `name: "ECDSA"`. Reject other
      // sizes (e.g. DER-wrapped signatures) without invoking verify.
      return null;
    }
    let ok: boolean;
    try {
      ok = await crypto.subtle.verify(
        verifyParamsFor(jwtHeader.alg),
        cached.key,
        toArrayBufferCopy(signature),
        toArrayBufferCopy(new TextEncoder().encode(`${headerB64}.${payloadB64}`)),
      );
    } catch {
      return null;
    }
    if (!ok) return null;

    if (jwtPayload.iss !== opts.issuer) return null;
    if (!matchesAudience(jwtPayload.aud, opts.audience)) return null;

    const nowSec = Date.now() / 1000;
    const skewSec = clockSkewMs / 1000;
    if (typeof jwtPayload.exp === "number" && nowSec - skewSec > jwtPayload.exp) return null;
    if (typeof jwtPayload.nbf === "number" && nowSec + skewSec < jwtPayload.nbf) return null;

    const tenantValue = jwtPayload[tenantClaim];
    if (typeof tenantValue !== "string" || tenantValue.length === 0 || tenantValue.includes("/")) {
      return null;
    }

    return { tenantPrefix: tenantValue, identity: jwtPayload };
  }
};

const isJwtAlgorithm = (alg: unknown): alg is JwtAlgorithm =>
  alg === "RS256" || alg === "ES256" || alg === "EdDSA";

const resolveJwkAlgorithm = (jwk: Jwk): JwtAlgorithm | null => {
  if (jwk.alg !== undefined && isJwtAlgorithm(jwk.alg)) return jwk.alg;
  // Derive from `kty` + curve when `alg` isn't present (some IdPs
  // omit it). RSA → RS256; EC P-256 → ES256; OKP Ed25519 → EdDSA.
  if (jwk.kty === "RSA") return "RS256";
  if (jwk.kty === "EC" && (jwk as Record<string, unknown>).crv === "P-256") return "ES256";
  if (jwk.kty === "OKP" && (jwk as Record<string, unknown>).crv === "Ed25519") return "EdDSA";
  return null;
};

const importParamsFor = (
  alg: JwtAlgorithm,
): RsaHashedImportParams | EcKeyImportParams | { name: "Ed25519" } | null => {
  if (alg === "RS256") return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  if (alg === "ES256") return { name: "ECDSA", namedCurve: "P-256" };
  if (alg === "EdDSA") return { name: "Ed25519" };
  return null;
};

const verifyParamsFor = (alg: JwtAlgorithm): AlgorithmIdentifier | EcdsaParams => {
  if (alg === "RS256") return { name: "RSASSA-PKCS1-v1_5" };
  if (alg === "ES256") return { name: "ECDSA", hash: "SHA-256" };
  return { name: "Ed25519" };
};

const matchesAudience = (
  aud: string | readonly string[] | undefined,
  expected: string,
): boolean => {
  if (typeof aud === "string") return aud === expected;
  if (Array.isArray(aud)) return aud.includes(expected);
  return false;
};

/**
 * Decode a base64url string into bytes. Hand-rolled because
 * `Uint8Array.fromBase64` isn't yet ubiquitous across the Node 24 /
 * Workers cross-runtime floor we target.
 */
const base64UrlDecode = (input: string): Uint8Array => {
  let s = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad === 2) s += "==";
  else if (pad === 3) s += "=";
  else if (pad !== 0) throw new Error("invalid base64url length");
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const textDecode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * Copy a `Uint8Array<ArrayBufferLike>` into a freshly-allocated
 * `ArrayBuffer` to satisfy `crypto.subtle.verify`'s strict
 * `BufferSource = ArrayBuffer | ArrayBufferView<ArrayBuffer>` type
 * under TS 5.7+. WebCrypto reads the bytes synchronously so the
 * extra copy is one allocation per verify; negligible vs. the
 * signature math itself.
 */
const toArrayBufferCopy = (bytes: Uint8Array): ArrayBuffer => {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
};
