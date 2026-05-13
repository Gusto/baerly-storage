/**
 * Shared test {@link Verifier}. Maps the single bearer token
 * `test-token` to the tenant prefix `conformance-tenant`; anything
 * else returns `null`, which both adapter shapes (`createListener` for
 * Node, `baerlyWorker` for Cloudflare Workers) translate to a `401
 * Unauthorized` response with the `HttpErrorEnvelope` shape.
 *
 * Kept Node-import-free so the Workerd-side HTTP-conformance entry
 * point can consume it directly without dragging `node:*` modules
 * into the Cloudflare pool.
 *
 * The `Verifier` type itself is exported by `@baerly/protocol` as a
 * plain async function `(req: Request) => Promise<VerifierResult |
 * null>` — see `packages/protocol/src/verifier.ts`. The shape is a
 * function (not an object with a `verify` method), so the factory
 * here returns the function directly.
 */

import type { Verifier } from "@baerly/protocol";

/** Tenant prefix the shared test verifier maps every authorized request to. */
export const CONFORMANCE_TENANT = "conformance-tenant";

/** Bearer token the shared test verifier accepts. Anything else → `null` → 401. */
export const CONFORMANCE_BEARER = "test-token";

/**
 * Build a fresh {@link Verifier} suitable for handing to the HTTP
 * adapters (`createListener({ verifier })` / `baerlyWorker({
 * verifier })`). The verifier inspects the `Authorization` header and
 * returns `{ tenantPrefix, identity: {} }` on a match, `null`
 * otherwise. Identity is intentionally empty — the HTTP conformance
 * suite has no `identity`-shape assertions.
 */
export const testVerifier = (): Verifier => async (req: Request) => {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${CONFORMANCE_BEARER}`) return null;
  return { tenantPrefix: CONFORMANCE_TENANT, identity: {} };
};
