/**
 * @internal — test-only widening of `@baerly/server`'s public option
 * types. Production callers see the narrow `CompactOptions` /
 * `RunGcOptions` / `MaintenanceOptions` from `@baerly/server`; the
 * budget caps and clock seam live here.
 *
 * This subpath is intentionally NOT in `publishConfig.exports`, so the
 * published `@baerly/server` package does not surface it.
 */
export type { InternalCompactOptions } from "../compactor.ts";
export type { InternalRunGcOptions } from "../gc.ts";
export type { InternalMaintenanceOptions } from "../maintenance.ts";
