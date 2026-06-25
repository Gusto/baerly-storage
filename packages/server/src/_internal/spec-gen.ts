/**
 * @internal — build/test-only access to the machine-contract IR generator.
 * Exposed to the repo's `scripts/gen-spec.ts` + `scripts/check-spec-drift.ts`
 * so they don't reach into raw `src/spec/ir.ts`. `buildSpecIR` drags the HTTP
 * router into its closure, so it is intentionally NOT on the runtime
 * `@baerly/server/spec` barrel.
 *
 * Mirrors `_internal/testing`: intentionally NOT in `publishConfig.exports`,
 * so the published `@baerly/server` package does not surface it.
 */
export { type SpecIR, buildSpecIR } from "../spec/ir.ts";
