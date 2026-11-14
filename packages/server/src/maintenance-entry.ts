/**
 * Published `@gusto/baerly-storage/maintenance` entry: the opt-in
 * scheduled-maintenance SDK, one function addressed by collection.
 *
 * The phases it composes (`compact`, `runGc`), the host tiers behind its
 * `tier` option, the write-tick runner and env parsing live in
 * `./maintenance.ts` and reach the CLI, adapters, and bench through the
 * unpublished `@baerly/server/_internal/maintenance` subpath.
 */

export type {
  MaintenanceOptions,
  MaintenanceResult,
  MaintenanceTarget,
} from "./maintenance-options.ts";
export { runScheduledMaintenance } from "./maintenance.ts";
