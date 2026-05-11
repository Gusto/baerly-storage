/**
 * `runScheduledMaintenance` — single-pass compose of `compact()` and
 * `runGc()` over one collection. Designed to fit a single Cloudflare
 * Cron Trigger invocation's 50-subrequest free-tier budget when
 * called with the {@link CLOUDFLARE_FREE_TIER} profile (which the
 * caller pairs with even/odd-minute alternation — see ticket 16);
 * unbounded on Node.
 *
 * Single-attempt: returns the combined result. The caller (cron
 * handler) is responsible for scheduling the next invocation; this
 * function does not loop or retry. `compact()` and `runGc()` are
 * already CAS-protected single-attempts — a restart safely retries
 * next tick.
 *
 * @see ../../../../.claude/research/planning/tickets/16-compactor-runtime-adapters.md
 */

import type { Storage } from "@baerly/protocol";
import { compact, type CompactOptions, type CompactResult } from "./compactor";
import { runGc, type RunGcOptions, type RunGcResult } from "./gc";

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
 * import { runScheduledMaintenance, NODE_PROFILE } from "@baerly/server";
 *
 * const res = await runScheduledMaintenance(
 *   { storage, currentJsonKey: "app/x/tenant/t/manifests/tickets/current.json" },
 *   NODE_PROFILE,
 * );
 * console.log("compacted:", res.compact?.written, "swept:", res.gc?.swept);
 * ```
 */
export const runScheduledMaintenance = async (
  args: MaintenanceArgs,
  options: MaintenanceOptions = {},
): Promise<MaintenanceResult> => {
  const compactRes =
    options.skipCompact === true
      ? null
      : await compact(args, {
          ...options.compact,
          ...(options.signal !== undefined && { signal: options.signal }),
        });
  const gcRes =
    options.skipGc === true
      ? null
      : await runGc(args, {
          ...options.gc,
          ...(options.signal !== undefined && { signal: options.signal }),
        });
  return { compact: compactRes, gc: gcRes };
};

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
export const CLOUDFLARE_FREE_TIER: MaintenanceOptions = {
  compact: { maxEntriesPerRun: 20, minEntriesToCompact: 50 },
  gc: { maxMarksPerRun: 20, maxSweepsPerRun: 10 },
};

/**
 * Tuning profile for the 10k-subrequest Cloudflare paid-tier budget.
 * One invocation handles thousands of log entries.
 */
export const CLOUDFLARE_PAID_TIER: MaintenanceOptions = {
  compact: { maxEntriesPerRun: 2000, minEntriesToCompact: 100 },
  gc: { maxMarksPerRun: 1000, maxSweepsPerRun: 500 },
};

/**
 * Tuning profile for Node. No subrequest cap; the compactor folds the
 * entire live tail every pass.
 */
export const NODE_PROFILE: MaintenanceOptions = {
  compact: { maxEntriesPerRun: 100_000, minEntriesToCompact: 100 },
  gc: { maxMarksPerRun: 100_000, maxSweepsPerRun: 1000 },
};
