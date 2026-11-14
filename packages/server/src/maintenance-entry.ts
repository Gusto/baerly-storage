/**
 * Published `@gusto/baerly-storage/maintenance` entry: the opt-in
 * scheduled-maintenance SDK (`runScheduledMaintenance`), its two phases
 * (`compact`, `runGc`), and the host tuning profiles.
 *
 * The write-tick runner and its gates, fold-ceiling helpers, dispatch
 * wiring, and env parsing live in `./maintenance.ts` and reach the CLI,
 * adapters, and bench through the unpublished
 * `@baerly/server/_internal/maintenance` subpath.
 */

export { type CompactOptions, type CompactResult, compact } from "./compactor.ts";
export { type RunGcOptions, type RunGcResult, runGc } from "./gc.ts";
export type { MaintenanceOptions } from "./maintenance-options.ts";
export {
  type MaintenanceArgs,
  type MaintenanceProfile,
  type MaintenanceResult,
  CLOUDFLARE_FREE_TIER,
  CLOUDFLARE_PAID_TIER,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_CF_PAID,
  MAINTENANCE_PROFILE_NODE,
  runScheduledMaintenance,
} from "./maintenance.ts";
