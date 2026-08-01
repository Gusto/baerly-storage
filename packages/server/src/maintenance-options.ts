/**
 * Option types for `runScheduledMaintenance`, split out of
 * `./maintenance.ts` because that module is a published entry point.
 *
 * `compactor.ts` and `gc.ts` declare their `Internal*` widening right
 * next to the public sibling, which is safe because neither module is
 * published and `maintenance.ts` re-exports only the narrow names.
 * `maintenance.ts` has no such luxury — an `export interface` there
 * lands in `dist/maintenance.d.ts` directly. Holding BOTH types here
 * restores the same shape: a non-published module declares the pair,
 * the published entry re-exports only the public one.
 */
import type { CompactOptions, InternalCompactOptions } from "./compactor.ts";
import type { InternalRunGcOptions, RunGcOptions } from "./gc.ts";

export interface MaintenanceOptions {
  /** Forwarded to `compact()`. */
  readonly compact?: CompactOptions;
  /** Forwarded to `runGc()`. */
  readonly gc?: RunGcOptions;
  /** Forwarded to both primitives. */
  readonly signal?: AbortSignal;
}

/**
 * Internal-only widening of {@link MaintenanceOptions}. Surfaced via
 * the `@baerly/server/_internal/testing` subpath (NOT in the published
 * `publishConfig.exports`); production callers should use
 * {@link MaintenanceOptions}.
 *
 * Publishing it would leak more than the name. The `compact` / `gc`
 * fields are typed as the `Internal*` widenings, and field types are
 * reachable structurally even when they are not themselves
 * name-exported — so an external caller reaches every knob with no
 * cast and no `any`:
 *
 * ```ts
 * const o: InternalMaintenanceOptions = { gc: { graceMillis: 0 } };
 * await runScheduledMaintenance(args, o); // forwarded straight to runGc
 * ```
 *
 * `graceMillis` is the one that matters: `GC_GRACE_PERIOD_MILLIS`
 * documents that production MUST NOT go below the default outside a
 * maintenance window, since that risks deleting an anchor a writer is
 * about to find on retry. `0` is a perfectly valid number, so no input
 * validation can catch it — keeping the type unpublished is the only
 * control that works. Pinned by
 * `tests/integration/internal-types-unpublished.test.ts`.
 *
 * @internal
 */
export interface InternalMaintenanceOptions extends MaintenanceOptions {
  /** @internal Internal compact options (budget caps). */
  readonly compact?: InternalCompactOptions;
  /** @internal Internal GC options (budget caps + clock seam + grace). */
  readonly gc?: InternalRunGcOptions;
}
