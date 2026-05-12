import type { Verifier } from "@baerly/protocol";

/**
 * Dev-only convenience: returns a {@link Verifier} that resolves
 * every request to a fixed `tenantPrefix`. Use for local single-
 * tenant Workers where you don't yet need real auth.
 *
 * **Never** use in multi-tenant production — it short-circuits the
 * verifier contract and pins every request to one tenant. There is
 * no header check, no signature check, no rate limit; every caller
 * looks the same to the rest of the stack.
 *
 * The returned verifier always resolves (never returns `null`), so
 * the 401 short-circuit in `baerlyWorker` is effectively disabled.
 *
 * @example
 * ```ts
 * import { baerlyWorker, singleTenantDevVerifier } from "@baerly/adapter-cloudflare";
 *
 * // Hardcode the dev tenant. Reading `env.TENANT` requires wrapping
 * // `baerlyWorker` in your own `fetch(req, env, ctx)` so `env` is in
 * // scope — see the {@link baerlyWorker} JSDoc for that pattern.
 * export default baerlyWorker({
 *   verifier: singleTenantDevVerifier("acme"),
 * });
 * ```
 */
export function singleTenantDevVerifier(tenantPrefix: string): Verifier {
  return async () => ({
    tenantPrefix,
    identity: { kind: "single-tenant-dev" },
  });
}
