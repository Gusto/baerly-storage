/**
 * @internal — the maintenance phases (`compact`, `runGc`) and the
 * whole-pass composition (`runMaintenancePass`) addressed by
 * `current.json` key, the host tiers and profiles, the write-tick runner,
 * and the helpers the adapters, CLI, and bench share with it: dispatch
 * wiring, env parsing, the cadence/ratio gates, and the fold-ceiling
 * predicates.
 *
 * Mirrors `_internal/testing`: intentionally NOT in `publishConfig.exports`,
 * so the published package does not surface it. The published maintenance
 * surface is `../maintenance-entry.ts`.
 */
export { type CompactOptions, type CompactResult, compact } from "../compactor.ts";
export { type RunGcOptions, type RunGcResult, runGc } from "../gc.ts";
export type { InternalMaintenanceOptions } from "../maintenance-options.ts";
export {
  type BoundedMaintenanceOptions,
  type MaintenanceArgs,
  type MaintenancePassResult,
  type MaintenanceProfile,
  CLOUDFLARE_FREE_TIER,
  CLOUDFLARE_PAID_TIER,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_CF_PAID,
  MAINTENANCE_PROFILE_NODE,
  runMaintenancePass,
  type FoldCeilings,
  type MaintenanceDispatch,
  crossesGcBoundary,
  dispatchInlineAwaited,
  dispatchWriteTick,
  estimateTailBytes,
  isFoldViable,
  parseMaintenanceEnv,
  resolveFoldCeilings,
  runBoundedMaintenance,
  shouldFireMaintenance,
} from "../maintenance.ts";
