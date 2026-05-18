/**
 * Result of a successful {@link Verifier} call. Returned when the
 * request carries valid credentials; replaced with `null` on
 * failure.
 *
 * `tenantPrefix` is the value passed to `Db.create({ tenant })`.
 * The HTTP dispatcher uses it for **two** distinct
 * responsibilities:
 *
 * 1. **Scope check (403).** The dispatcher compares the request's
 *    URL-derived target (e.g. `/v1/t/<table>/<id>`) against the
 *    physical prefix `app/<app>/tenant/<tenantPrefix>/...`. Anything
 *    that would escape the prefix is rejected with
 *    `BaerlyError{code:"AccessDenied"}` and HTTP 403.
 * 2. **`Db` construction.** After the scope check passes, the
 *    dispatcher invokes
 *    `Db.create({ storage, app, tenant: tenantPrefix })`. `Db.create`
 *    enforces that `tenantPrefix` is non-empty and contains no `/`
 *    (the key-segment separator). A `Verifier` that violates either
 *    constraint surfaces as `BaerlyError{code:"InvalidConfig"}` from
 *    `Db.create`; the dispatcher maps that to 500 +
 *    `code:"Internal"` because it indicates a Verifier bug, not a
 *    client error.
 *
 * `identity` is opaque to the protocol kernel and to the
 * dispatcher. Preset Verifier factories decide the shape:
 * a JWT verifier returns the decoded claim set, a SigV4 verifier
 * returns the IAM principal ARN, a shared-secret verifier returns
 * a constant token. Application code that needs to read `identity`
 * does so off the dispatcher's request context — the dispatcher
 * does not inspect it.
 */
export interface VerifierResult {
  /**
   * Non-empty, `/`-free tenant identifier. Spent as `tenant` in
   * `Db.create({ tenant })`. See {@link VerifierResult} for the
   * scope-check / `Db.create` split.
   *
   * Named `tenantPrefix` (not `tenant`) to surface responsibility 1
   * — this is a load-bearing path-scope token that the dispatcher
   * compares against the request URL, not just a free-form tenant
   * id.
   */
  readonly tenantPrefix: string;

  /**
   * Per-Verifier identity payload. `unknown` because preset
   * factories choose their own shape; the dispatcher
   * never reads this field. Application code that wants the
   * identity reads it off the request context the dispatcher
   * attaches.
   */
  readonly identity: unknown;
}

/**
 * Auth seam. Given an inbound {@link Request}, return either a
 * {@link VerifierResult} (authenticated) or `null` (rejected).
 *
 * One function, one responsibility — auth in baerly is not a
 * middleware chain. The HTTP dispatcher invokes the
 * configured `Verifier` exactly once per request, before any
 * `Storage` I/O, and either constructs a tenant-scoped `Db` or
 * returns 401 `BaerlyError{code:"Unauthorized"}`.
 *
 * `Request` is the standard `globalThis.Request` — the same shape
 * used by Cloudflare Workers, Node 24+, Bun, Deno, and browsers.
 * The kernel does **not** depend on `node:http`, `R2Bucket`, or
 * any platform binding. Preset factories that need platform
 * primitives (e.g. CF Access reads the `Cf-Access-Jwt-Assertion`
 * header; SigV4 verifies against a SHA-256 of the body) compose on
 * top.
 *
 * **Errors.** A `Verifier` SHOULD return `null` for any
 * unauthenticated outcome — missing header, bad signature, expired
 * token, IP outside allowlist. It MAY throw an `BaerlyError` for
 * configuration problems (the IdP's JWKS endpoint is unreachable,
 * the shared-secret env var is missing). Throws propagate to the
 * dispatcher, which maps them to 500 + `code:"Internal"`. The
 * dispatcher distinguishes "auth said no" (null → 401) from "auth
 * is broken" (throw → 500) on purpose: the first is a client
 * problem, the second is an operator problem.
 *
 * **Idempotence.** A `Verifier` MUST be safe to call multiple times
 * for the same `Request`. Preset factories that decode JWTs cache
 * the result on the request via a `WeakMap` if the cost is
 * material.
 *
 * Preset factories — `cloudflareAccess`, `bearerJwt`,
 * `awsIamSigV4`, `sharedSecret`, `allowlistIp` — live in
 * `baerly-storage/auth` (`packages/server/src/auth/presets/`). The
 * kernel owns the type; the server owns the factories.
 *
 * @example
 * ```ts
 * import type { Verifier } from "baerly-storage";
 *
 * // A trivial Verifier that pins every request to one tenant.
 * // Useful for tests and single-tenant deployments instead of the
 * // preset factories.
 * const single: Verifier = async (_req) => ({
 *   tenantPrefix: "acme-co",
 *   identity: { kind: "static" },
 * });
 *
 * // A Verifier that reads an `X-Tenant` header and rejects when
 * // it's missing. The preset factories produce something like
 * // this on top of a real IdP — never trust an `X-Tenant` header
 * // in production.
 * const headerOnly: Verifier = async (req) => {
 *   const tenant = req.headers.get("x-tenant");
 *   if (!tenant) return null;
 *   return { tenantPrefix: tenant, identity: null };
 * };
 * ```
 */
export type Verifier = (req: Request) => Promise<VerifierResult | null>;
