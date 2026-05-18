/**
 * `runScheduledMaintenance` — single-pass compose of `compact()` and
 * `runGc()` over one collection. Designed to fit a single Cloudflare
 * Cron Trigger invocation's 50-subrequest free-tier budget when
 * called with the {@link CLOUDFLARE_FREE_TIER} profile (which the
 * caller pairs with even/odd-minute alternation between compact and
 * GC ticks); unbounded on Node.
 *
 * Single-attempt: returns the combined result. The caller (cron
 * handler) is responsible for scheduling the next invocation; this
 * function does not loop or retry. `compact()` and `runGc()` are
 * already CAS-protected single-attempts — a restart safely retries
 * next tick.
 *
 * Callers that want only one phase to fire this tick should invoke
 * the underlying primitive directly (`compact()` or `runGc()` from
 * this same module's re-exports). The even/odd-minute CF cron
 * pattern uses exactly that.
 */

import {
  type MetricsRecorder,
  noopMetricsRecorder,
  type Storage,
  teeMetricsRecorders,
} from "@baerly/protocol";
import {
  compact,
  type CompactOptions,
  type CompactResult,
  type InternalCompactOptions,
} from "./compactor.ts";
import { runGc, type InternalRunGcOptions, type RunGcOptions, type RunGcResult } from "./gc.ts";

export { compact } from "./compactor.ts";
export { runGc } from "./gc.ts";
import { getCurrentContext, withObservability } from "./observability/index.ts";

export interface MaintenanceArgs {
  readonly storage: Storage;
  /** Full bucket-relative key of the CAS pointer for the target collection. */
  readonly currentJsonKey: string;
}

export interface MaintenanceOptions {
  /** Forwarded to `compact()`. */
  readonly compact?: CompactOptions;
  /** Forwarded to `runGc()`. */
  readonly gc?: RunGcOptions;
  /** Forwarded to both primitives. */
  readonly signal?: AbortSignal;
  /**
   * Optional metrics sink. Forwarded to BOTH `compact()` and `runGc()`
   * (overriding any `metrics` field on `options.compact` /
   * `options.gc`). Defaults to the primitives' own defaults
   * (`noopMetricsRecorder`).
   */
  readonly metrics?: MetricsRecorder;
}

/**
 * Internal-only widening of {@link MaintenanceOptions}. Surfaced via
 * the `@baerly/server/_internal/testing` subpath (NOT in the
 * published `publishConfig.exports`); production callers should use
 * {@link MaintenanceOptions}.
 *
 * @internal
 */
export interface InternalMaintenanceOptions extends MaintenanceOptions {
  /** @internal Internal compact options (budget caps). */
  readonly compact?: InternalCompactOptions;
  /** @internal Internal GC options (budget caps + clock seam + grace). */
  readonly gc?: InternalRunGcOptions;
}

export interface MaintenanceResult {
  readonly compact: CompactResult;
  readonly gc: RunGcResult;
}

/**
 * Single maintenance pass for one collection. Runs `compact()` then
 * `runGc()` (in that order; the compactor's advance of
 * `log_seq_start` produces the stale-log candidates the GC then
 * marks). Callers wanting a single phase per tick invoke
 * `compact()` or `runGc()` directly instead.
 *
 * Errors propagate — the caller's cron handler is responsible for
 * logging them. The Cloudflare runtime ships uncaught Worker errors
 * to the dashboard; Node operators wrap their `node-cron` callbacks
 * themselves.
 *
 * @example
 * ```ts
 * import { runScheduledMaintenance, CLOUDFLARE_FREE_TIER } from "@baerly/server/maintenance";
 *
 * // Node (unbounded — defaults fold the entire live tail):
 * const res = await runScheduledMaintenance(
 *   { storage, currentJsonKey: "app/x/tenant/t/manifests/tickets/current.json" },
 * );
 * console.log("compacted:", res.compact.entriesFolded, "swept:", res.gc.swept);
 *
 * // Cloudflare free tier (50-subrequest cap, single phase per tick):
 * await runScheduledMaintenance({ storage, currentJsonKey }, CLOUDFLARE_FREE_TIER);
 * ```
 */
export const runScheduledMaintenance = (
  args: MaintenanceArgs,
  options: MaintenanceOptions = {},
): Promise<MaintenanceResult> =>
  withObservability("maintenance", async (_ctx, recorder) => {
    // Tee the per-run recorder onto the operator's `MetricsRecorder`
    // so every emission `compact()` / `runGc()` produces lands in
    // both the per-run canonical-line bag AND the operator's
    // long-term sink. The default tee is harmless when the operator
    // didn't pass a recorder — the noop side is a no-op.
    const teed = teeMetricsRecorders(options.metrics ?? noopMetricsRecorder, recorder);
    const compactRes = await compact(args, {
      ...options.compact,
      ...(options.signal !== undefined && { signal: options.signal }),
      metrics: teed,
    });
    const gcRes = await runGc(args, {
      ...options.gc,
      ...(options.signal !== undefined && { signal: options.signal }),
      metrics: teed,
    });

    // Enrich the canonical line with operator-facing summary fields.
    // The recorder-bag fields (`db.compact.entries_folded_p50`,
    // `db.gc.swept_total`, etc.) still land on the line via
    // the per-run recorder's `summarize()`; these explicit numbers
    // answer "did anything happen this tick?" without forcing the
    // operator to decode `_p50` / `_count` / `_total` suffixes.
    //
    // - `compact_written`: count of log entries folded into the new
    //   snapshot this pass (0 when the live tail was below
    //   `minEntriesToCompact`).
    // - `gc_swept`: count of keys deleted this pass (0 when no
    //   candidates had aged out).
    const fields = getCurrentContext()?.fields;
    if (fields !== undefined) {
      fields.set("compact_written", compactRes.entriesFolded);
      fields.set("gc_swept", gcRes.swept);
    }

    return { compact: compactRes, gc: gcRes };
  });

/**
 * Tuning profile for the 50-subrequest Cloudflare free-tier budget.
 *
 * Budget arithmetic (worst case):
 *   compact: 1 GET current + 1 GET snapshot (if any) + N GETs log
 *     + 1 PUT snapshot + 1 PUT current = 3 + N (N = maxEntriesPerRun).
 *   runGc:   1 GET current + 1 GET pending + 3 LISTs (one page each)
 *     + M GETs log (live tail for content hashes) + S DELETEs + 1 PUT
 *     pending = 6 + M + S.
 *
 * With N=20, M=20, S=10 the totals are: compact ≈ 23, gc ≈ 36 — over
 * the 50 cap combined. The Cloudflare scheduled handler therefore
 * alternates phases per tick (even minute → compact, odd minute →
 * GC) by calling `compact()` / `runGc()` directly instead of
 * `runScheduledMaintenance`; the `maintenance.budget.test.ts`
 * worst-case test proves each phase in isolation sits under 50 ops
 * with these bounds.
 */
const cfFreeTier: InternalMaintenanceOptions = {
  compact: { maxEntriesPerRun: 20, minEntriesToCompact: 50 },
  gc: { maxMarksPerRun: 20, maxSweepsPerRun: 10 },
};
export const CLOUDFLARE_FREE_TIER: MaintenanceOptions = cfFreeTier;
