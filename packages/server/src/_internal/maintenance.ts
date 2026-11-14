/**
 * @internal — the write-tick maintenance runner and the helpers the
 * adapters, CLI, and bench share with it: dispatch wiring, env parsing,
 * the cadence/ratio gates, and the fold-ceiling predicates.
 *
 * Mirrors `_internal/testing`: intentionally NOT in `publishConfig.exports`,
 * so the published package does not surface it. The published maintenance
 * surface is `../maintenance-entry.ts`.
 */
export {
  type BoundedMaintenanceOptions,
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
