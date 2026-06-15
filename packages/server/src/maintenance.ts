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
  type CurrentJson,
  type MetricsRecorder,
  type Storage,
  BaerlyError,
  casUpdateCurrentJson,
  GC_STARVATION_GUARD,
  MAINTENANCE_MIN_LIVE_BYTES,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_TARGET_RATIO,
  MAINTENANCE_WARN_INTERVAL_WRITES,
  noopMetricsRecorder,
  readCurrentJson,
  WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
} from "@baerly/protocol";
import {
  compact,
  type CompactOptions,
  type CompactResult,
  type InternalCompactOptions,
} from "./compactor.ts";
import { runGc, type InternalRunGcOptions, type RunGcOptions, type RunGcResult } from "./gc.ts";
import { getCurrentContext } from "./observability/context.ts";

const ctxMetrics = (): MetricsRecorder => getCurrentContext()?.recorder ?? noopMetricsRecorder;

export { type CompactOptions, type CompactResult, compact } from "./compactor.ts";
export { type RunGcOptions, type RunGcResult, runGc } from "./gc.ts";
export {
  type RebuildIndexOptions,
  type RebuildIndexResult,
  rebuildIndex,
} from "./rebuild-index.ts";

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
 * import { runScheduledMaintenance, CLOUDFLARE_FREE_TIER } from "@gusto/baerly-storage/maintenance";
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
export const runScheduledMaintenance = async (
  args: MaintenanceArgs,
  options: MaintenanceOptions = {},
): Promise<MaintenanceResult> => {
  const compactRes = await compact(args, {
    ...options.compact,
    ...(options.signal !== undefined && { signal: options.signal }),
  });
  const gcRes = await runGc(args, {
    ...options.gc,
    ...(options.signal !== undefined && { signal: options.signal }),
  });
  return { compact: compactRes, gc: gcRes };
};

/** The six host-agnostic write-tick budgets (`maxFoldBytes`=`C`, `maxFoldRows`=`E`). Canonical shape; mirrors the protocol constants (typed there to avoid a cycle). */
export interface MaintenanceProfile {
  readonly gcInterval: number;
  readonly gcMaxMarks: number;
  readonly gcMaxSweeps: number;
  readonly maxFoldEntriesPerPass: number;
  readonly maxFoldBytes: number;
  readonly maxFoldRows: number;
}

export { MAINTENANCE_PROFILE_CF_FREE, MAINTENANCE_PROFILE_NODE } from "@baerly/protocol";

// Snapshot ceilings aren't part of the scheduled cap surface; omitted.
const profileToScheduledOptions = (profile: MaintenanceProfile): InternalMaintenanceOptions => ({
  compact: {
    maxEntriesPerRun: profile.maxFoldEntriesPerPass,
    minEntriesToCompact: WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
  },
  gc: { maxMarksPerRun: profile.gcMaxMarks, maxSweepsPerRun: profile.gcMaxSweeps },
});

/**
 * Tuning profile for the 50-subrequest Cloudflare free-tier budget,
 * derived from {@link MAINTENANCE_PROFILE_CF_FREE} (one source of truth).
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
export const CLOUDFLARE_FREE_TIER: MaintenanceOptions = profileToScheduledOptions(
  MAINTENANCE_PROFILE_CF_FREE,
);

// =====================================================================
// Write-tick (in-band) maintenance — `runBoundedMaintenance`.
//
// This is the runner the writer hook dispatches after a successful
// commit. It is intentionally a thin, bounded composition over the
// EXISTING `compact()` / `runGc()` primitives. The fold-viability
// decision is made HERE (a pre-fold projection over `current.json`'s
// `snapshot_bytes` / `snapshot_rows`) rather than inside `compact()`:
// on a CPU-killable Cloudflare isolate the kill would land mid-rebuild,
// before any post-rebuild size check could fire, so the only safe gate
// is one that never starts an over-ceiling fold.
//
// §8.3 of docs/superpowers/plans/2026-05-29-just-a-bucket-maintenance.md.
// =====================================================================

/**
 * Floor-based GC-cadence boundary crossing. Every commit now advances
 * `next_seq` by exactly 1, so a single step can only ever cross one
 * `next_seq % interval === 0` boundary — but the floor test is kept
 * (rather than a `next_seq % interval === 0` modulo test) because it
 * trips on any interval boundary inside `(prevSeq, nextSeq]` and so
 * stays correct and cheap regardless of step size.
 */
export const crossesGcBoundary = (prevSeq: number, nextSeq: number, interval: number): boolean =>
  Math.floor(prevSeq / interval) !== Math.floor(nextSeq / interval);

/**
 * The cheap DISPATCH gate the writer calls after a commit — zero
 * storage ops; it reads the post-CAS {@link CurrentJson} already in
 * scope. Ratio-OR-boundary, WITHOUT the entry floor (the floor is part
 * of the fold-trigger Gate 1 checked inside {@link runBoundedMaintenance}).
 * Returning `false` lets the writer skip the dispatch entirely.
 */
export const shouldFireMaintenance = (
  current: CurrentJson,
  prevSeq: number,
  gcInterval: number,
): boolean =>
  crossesGcBoundary(prevSeq, current.next_seq, gcInterval) ||
  current.tail_bytes / Math.max(current.snapshot_bytes, MAINTENANCE_MIN_LIVE_BYTES) >=
    MAINTENANCE_TARGET_RATIO;

/** Per-tier caps for {@link runBoundedMaintenance}, threaded by the adapter. */
export interface BoundedMaintenanceOptions {
  /** Host budgets, threaded by the adapter. Absent ⇒ {@link MAINTENANCE_PROFILE_CF_FREE} (CF-free-safe default; keeps a bare `Db.create()` maintaining). */
  readonly profile?: MaintenanceProfile;
  /** Gate-1 minimum live-tail length. Default {@link WRITE_TICK_MIN_ENTRIES_TO_COMPACT}. */
  readonly minEntriesToCompact?: number;
  /**
   * How many phases this tick may run. `"single"` (CF-free-safe
   * default) runs at most one of fold / GC per tick; `"both"` lets a
   * capable host run a fold AND a GC in one tick.
   */
  readonly phasesPerTick?: "single" | "both";
  /**
   * @internal — test seam. Forwarded into the runner's `runGc` call as
   * `graceMillis`. Default `undefined` ⇒ `runGc`'s 7-day
   * {@link GC_GRACE_PERIOD_MILLIS}. The drain-rate test sets `0` so a
   * single pass marks AND sweeps, making the steady-state object-count
   * trajectory observable without an 8-day clock advance. Production
   * never sets this.
   */
  readonly gcGraceMillis?: number;
  /**
   * @internal — test seam. Forwarded into the runner's `runGc` call as
   * the clock `now`. Default `undefined` ⇒ `runGc`'s `() => new Date()`.
   * Production never sets this.
   */
  readonly now?: () => Date;
  readonly signal?: AbortSignal;
}

/**
 * The write-tick maintenance runner: a bounded, single-attempt
 * composition of {@link compact} and {@link runGc} for one collection,
 * sized to fit a CPU-killable Cloudflare free-tier isolate by default.
 *
 * INVARIANT: a {@link MaintenanceProfile} changes only maintenance rate +
 * defer threshold — never data/API/query/wire/correctness; reads stay pure.
 * See `maintenance-profile-equivalence.test.ts`.
 *
 * Never throws — the write-tick caller must never see a maintenance
 * failure. Expected signals (CAS contention, an over-ceiling deferral)
 * are swallowed quietly; unexpected throws bump
 * `db.maintenance.unexpected_error_total`, log a stack, and are
 * swallowed.
 *
 * Control flow (fold-priority with a stateless GC-starvation guard):
 *   0. `disabled` → return with zero storage ops.
 *   1. Read `current.json` once.
 *   2. Hard-GC starvation boundary (`"single"` only) → GC slice, skip fold.
 *   3. Gate 1 (ratio AND entry floor) trips → fold if viable, else
 *      defer (and metric); on `"single"` a successful fold attempt is
 *      this tick's one phase.
 *   4. Otherwise (or on `"both"`) → GC iff the cadence boundary crossed.
 */
export const runBoundedMaintenance = async (
  args: {
    storage: Storage;
    currentJsonKey: string;
    /** The writer's PRE-CAS `current.next_seq` — the GC cadence baseline. */
    prevSeq: number;
    /** `C` override (from `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`). */
    maxFoldBytes?: number;
    /** From `BAERLY_MAINTENANCE_DISABLE`. */
    disabled?: boolean;
  },
  options?: BoundedMaintenanceOptions,
): Promise<void> => {
  // ── Step 0. Hard disable — zero storage ops. ───────────────────────
  if (args.disabled === true) {
    return;
  }

  const { storage, currentJsonKey, prevSeq } = args;
  // Resolve the profile ONCE (the runner's single CF-free-safe default,
  // preserving the bare-`Db.create()` promise); all six budgets read off it.
  const profile = options?.profile ?? MAINTENANCE_PROFILE_CF_FREE;
  const { maxFoldEntriesPerPass, gcMaxMarks, gcMaxSweeps, gcInterval } = profile;
  const minEntriesToCompact = options?.minEntriesToCompact ?? WRITE_TICK_MIN_ENTRIES_TO_COMPACT;
  const phasesPerTick = options?.phasesPerTick ?? "single";
  const signal = options?.signal;
  // `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` (args.maxFoldBytes) overrides `C`.
  const C = args.maxFoldBytes ?? profile.maxFoldBytes;
  const E = profile.maxFoldRows;

  // Derive the collection label the same way compact()/runGc() do.
  const collectionPrefix = currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"));
  const collection = collectionPrefix.slice(collectionPrefix.lastIndexOf("/") + 1);

  const gcOpts = {
    maxMarksPerRun: gcMaxMarks,
    maxSweepsPerRun: gcMaxSweeps,
    ...(signal !== undefined && { signal }),
    // @internal test seams — undefined in production, so `runGc` falls
    // back to its 7-day grace and wall-clock `now`.
    ...(options?.gcGraceMillis !== undefined && { graceMillis: options.gcGraceMillis }),
    ...(options?.now !== undefined && { now: options.now }),
  } as InternalRunGcOptions;

  try {
    // ── Step 1. Read current.json once. ──────────────────────────────
    const read = await readCurrentJson(
      storage,
      currentJsonKey,
      signal !== undefined ? { signal } : undefined,
    );
    if (read === null) {
      return; // nothing to maintain yet
    }
    const current = read.json;
    const tailBytes = current.tail_bytes;
    const snapshotBytes = current.snapshot_bytes;
    const snapshotRows = current.snapshot_rows;
    const nextSeq = current.next_seq;
    const logSeqStart = current.log_seq_start;

    const ratio = tailBytes / Math.max(snapshotBytes, MAINTENANCE_MIN_LIVE_BYTES);
    const gate1 = ratio >= MAINTENANCE_TARGET_RATIO && nextSeq - logSeqStart >= minEntriesToCompact;
    const foldViable = snapshotBytes <= C && snapshotRows + maxFoldEntriesPerPass <= E;
    const gcDue = crossesGcBoundary(prevSeq, nextSeq, gcInterval);

    // ── Step 2. Hard-GC starvation guard ("single" only). ────────────
    // A long fold-heavy drain would otherwise starve GC on every
    // ratio-tripping tick. A COARSE cadence the fold may NOT preempt
    // guarantees ~1 GC tick per GC_STARVATION_GUARD intervals.
    const hardGc = crossesGcBoundary(prevSeq, nextSeq, gcInterval * GC_STARVATION_GUARD);
    if (phasesPerTick === "single" && hardGc) {
      await runGc({ storage, currentJsonKey }, gcOpts);
      return;
    }

    // ── Step 3. Fold-priority. ───────────────────────────────────────
    if (gate1) {
      if (foldViable) {
        // Thread the same `C` / `E` ceilings the pre-fold projection
        // above used into compact() as a Node-side belt-and-suspenders.
        // compact() emits `db.compaction.cas_lost_total` itself on a
        // lost CAS, so the runner does NOT (avoids double-count).
        await compact({ storage, currentJsonKey }, {
          maxEntriesPerRun: maxFoldEntriesPerPass,
          minEntriesToCompact,
          ceilingBytes: C,
          ceilingEntries: E,
          ...(signal !== undefined && { signal }),
        } as InternalCompactOptions);
        if (phasesPerTick === "single") {
          return; // this tick's one phase was the fold (attempt)
        }
        // "both": fall through to GC.
      } else {
        // DEFER: snapshot over the ceiling (bytes OR rows).
        // Graduation-pending. A deferring bucket MUST still GC, so we
        // fall through.
        ctxMetrics().counter("db.compaction.deferred_total", 1, {
          collection,
          dimension: snapshotBytes > C ? "bytes" : "rows",
        });
        // Advisory graduation warn, rate-limited off the SHARED
        // current.json.last_warned_seq (NOT a per-isolate Set — a fresh
        // isolate must honour the same rate-limit). Fires only when at
        // least MAINTENANCE_WARN_INTERVAL_WRITES writes have accrued
        // since the last warn, then best-effort CASes the stamp forward.
        if (nextSeq - (current.last_warned_seq ?? 0) >= MAINTENANCE_WARN_INTERVAL_WRITES) {
          console.warn(
            `baerly-storage: collection "${collection}" is deferring compaction — its ` +
              `snapshot exceeds the fold ceiling (${snapshotBytes > C ? "bytes" : "rows"}), ` +
              `so the tail keeps growing and read amplification will climb. This is ` +
              `graduation-pending: the dataset has outgrown prototype-tier maintenance. ` +
              `On paid Cloudflare / Node you can raise BAERLY_MAINTENANCE_MAX_FOLD_BYTES — ` +
              `but on Cloudflare a cap above what a single isolate can fold makes folds get ` +
              `CPU-killed mid-flight and silently not land (no clean metric — watch snapshot ` +
              `age / object count); see docs/about/graduation.md. Otherwise, graduate to a ` +
              `server-backed database.`,
          );
          // SEPARATE best-effort CAS — explicitly NOT folded into any
          // commit CAS. A lost stamp just means another isolate warns
          // slightly sooner/later; it must never throw out of the runner
          // nor block the GC fall-through below.
          try {
            await casUpdateCurrentJson(
              storage,
              currentJsonKey,
              (c) => ({ ...c, last_warned_seq: nextSeq }),
              signal !== undefined ? { signal } : undefined,
            );
          } catch {
            // Swallow — Conflict (another isolate stamped first) or any
            // transient error. The warn already fired; GC must still run.
          }
        }
      }
    }

    // ── Step 4. GC phase — cadence-gated. ────────────────────────────
    // Reaching here on "single" means we did NOT fold (gate1 false, or
    // deferred). Run GC iff the cadence boundary was crossed.
    if (gcDue) {
      await runGc({ storage, currentJsonKey }, gcOpts);
    }
  } catch (error) {
    // CAS contention (Conflict) thrown by compact()/runGc() is an
    // EXPECTED signal — swallow without the unexpected-error counter.
    if (error instanceof BaerlyError && error.code === "Conflict") {
      return;
    }
    // Anything else is unexpected: count it, log the stack, swallow.
    ctxMetrics().counter("db.maintenance.unexpected_error_total", 1, { collection });
    // The one intentional console sink in the runner — surface the stack for
    // operators, since the write-tick caller swallows the throw and emits no
    // canonical line for a post-response (waitUntil) maintenance pass.
    console.error(error);
  }
};

/**
 * Default maintenance dispatcher: run the task inline and await it.
 * Adapters that can keep running after the response (Cloudflare:
 * `ctx.waitUntil`) override this with a fire-and-forget variant that
 * returns `void`.
 */
export const dispatchInlineAwaited = (task: () => Promise<void>): void | Promise<void> => task();

/**
 * Per-request maintenance dispatch config, set by the adapter onto the
 * observability context (NOT `Db.create`). It rides the per-request ALS
 * context because `dispatch = ctx.waitUntil` is inherently per-request,
 * and routing it through `Db.create` would widen that surface past its
 * locked four fields. The writer reads it at the post-CAS dispatch
 * point via `getCurrentContext()?.maintenance`.
 *
 * Absent ⇒ inline dispatch + CF-free-safe caps (the defaults inside
 * {@link runBoundedMaintenance}), so a bare `Db.create(...)` maintains
 * out of the box once enough writes accrue.
 */
export interface MaintenanceDispatch {
  /** How to run the maintenance task. Default {@link dispatchInlineAwaited}. CF sets `ctx.waitUntil`. */
  readonly dispatch?: (task: () => Promise<void>) => void | Promise<void>;
  /** From `BAERLY_MAINTENANCE_DISABLE`. */
  readonly disabled?: boolean;
  /** `C` override, from `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`. */
  readonly maxFoldBytes?: number;
  /** Per-tier caps forwarded to {@link runBoundedMaintenance}. */
  readonly options?: BoundedMaintenanceOptions;
}
