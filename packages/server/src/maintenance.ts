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
  /** Forwarded to `compact()` when the compaction phase runs. */
  readonly compact?: CompactOptions;
  /** Forwarded to `runGc()` when the GC phase runs. */
  readonly gc?: RunGcOptions;
  /**
   * Skip the compaction phase entirely (run GC only). Useful for a
   * "GC tick" that runs more often than the compaction tick, or to
   * spread the Cloudflare free-tier 50-subrequest budget across
   * alternating minutes. Default `false`.
   */
  readonly skipCompact?: boolean;
  /** Skip the GC phase entirely. Default `false`. */
  readonly skipGc?: boolean;
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
  /** `null` iff `options.skipCompact === true`. */
  readonly compact: CompactResult | null;
  /** `null` iff `options.skipGc === true`. */
  readonly gc: RunGcResult | null;
}

/**
 * Single maintenance pass for one collection. Runs `compact()` then
 * `runGc()` (in that order; the compactor's advance of
 * `log_seq_start` produces the stale-log candidates the GC then
 * marks). Either phase can be skipped via the options.
 *
 * Errors propagate — the caller's cron handler is responsible for
 * logging them. The Cloudflare runtime ships uncaught Worker errors
 * to the dashboard; Node operators wrap their `node-cron` callbacks
 * themselves.
 *
 * @example
 * ```ts
 * import { runScheduledMaintenance, NODE_PROFILE } from "@baerly/server/maintenance";
 *
 * const res = await runScheduledMaintenance(
 *   { storage, currentJsonKey: "app/x/tenant/t/manifests/tickets/current.json" },
 *   NODE_PROFILE,
 * );
 * console.log("compacted:", res.compact?.written, "swept:", res.gc?.swept);
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
    const compactRes =
      options.skipCompact === true
        ? null
        : await compact(args, {
            ...options.compact,
            ...(options.signal !== undefined && { signal: options.signal }),
            metrics: teed,
          });
    const gcRes =
      options.skipGc === true
        ? null
        : await runGc(args, {
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
    //   snapshot this pass (0 when compaction was skipped or the
    //   live tail was below `minEntriesToCompact`).
    // - `gc_swept`: count of keys deleted this pass (0 when GC was
    //   skipped or no candidates had aged out).
    // - `compact_skipped` / `gc_skipped`: `true` when the caller
    //   alternated this phase away (CF free-tier even/odd-minute
    //   cron pattern).
    const fields = getCurrentContext()?.fields;
    if (fields !== undefined) {
      fields.set("compact_written", compactRes?.entriesFolded ?? 0);
      fields.set("gc_swept", gcRes?.swept ?? 0);
      fields.set("compact_skipped", options.skipCompact === true);
      fields.set("gc_skipped", options.skipGc === true);
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
 * GC); the `maintenance.budget.test.ts` worst-case test still proves
 * the combined run sits under 50 ops with these bounds because the
 * Memory-storage list calls are cheap (single-page) and the GET-log
 * paths overlap.
 */
const cfFreeTier: InternalMaintenanceOptions = {
  compact: { maxEntriesPerRun: 20, minEntriesToCompact: 50 },
  gc: { maxMarksPerRun: 20, maxSweepsPerRun: 10 },
};
export const CLOUDFLARE_FREE_TIER: MaintenanceOptions = cfFreeTier;

/**
 * Tuning profile for the 10k-subrequest Cloudflare paid-tier budget.
 * One invocation handles thousands of log entries.
 */
const cfPaidTier: InternalMaintenanceOptions = {
  compact: { maxEntriesPerRun: 2000, minEntriesToCompact: 100 },
  gc: { maxMarksPerRun: 1000, maxSweepsPerRun: 500 },
};
export const CLOUDFLARE_PAID_TIER: MaintenanceOptions = cfPaidTier;

/**
 * Tuning profile for Node. No subrequest cap; the compactor folds the
 * entire live tail every pass.
 */
const nodeProfile: InternalMaintenanceOptions = {
  compact: { maxEntriesPerRun: 100_000, minEntriesToCompact: 100 },
  gc: { maxMarksPerRun: 100_000, maxSweepsPerRun: 1000 },
};
export const NODE_PROFILE: MaintenanceOptions = nodeProfile;
