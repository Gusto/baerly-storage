/**
 * `runScheduledMaintenance` — single-pass composition of `compact()` and
 * `runGc()` over one collection. It always runs both phases. With
 * {@link CLOUDFLARE_FREE_TIER} one invocation fits Workers Free with the R2
 * binding; with storage over `fetch` (S3 over HTTP) on Free it does not,
 * and schedulers there alternate direct `compact()` and `runGc()` calls
 * instead (budgets on {@link CLOUDFLARE_FREE_TIER}). Unbounded on Node.
 *
 * Single-attempt: returns the combined result. The caller (cron
 * handler) is responsible for scheduling the next invocation; this
 * function does not loop or retry. `compact()` and `runGc()` are
 * already CAS-protected single-attempts — a restart safely retries
 * next tick.
 *
 * Callers that want only one phase to fire this tick should invoke
 * the underlying primitive directly (`compact()` or `runGc()` from
 * this same module's re-exports). The even/odd-minute cron pattern
 * for Free with storage over `fetch` uses exactly that.
 */

import {
  type CurrentJson,
  type MetricsRecorder,
  type Storage,
  BaerlyError,
  isWriteConflict,
  casUpdateCurrentJson,
  CF_FREE_COMPACT_TAIL_PROBE_GETS,
  CF_PAID_COMPACT_TAIL_PROBE_GETS,
  GC_STARVATION_GUARD,
  LOG_RETENTION_MAX_DELETES_PER_TICK,
  MAINTENANCE_COLD_START_ENTRY_BYTES,
  MAINTENANCE_FOLD_BASE_REQUESTS,
  MAINTENANCE_GC_BASE_REQUESTS,
  MAINTENANCE_MIN_LIVE_BYTES,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_CF_PAID,
  MAINTENANCE_PROFILE_NODE,
  MAINTENANCE_RETIRE_PRE_FLOOR_REQUESTS,
  MAINTENANCE_TAIL_HINT_REFRESH_REQUESTS,
  MAINTENANCE_TAIL_HINT_REFRESH_WRITES,
  MAINTENANCE_TARGET_RATIO,
  MAINTENANCE_WARN_INTERVAL_WRITES,
  noopMetricsRecorder,
  readCurrentJson,
  SCHEDULED_MIN_ENTRIES_TO_COMPACT,
  STORAGE_RETRY_MAX_ATTEMPTS,
  WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
} from "@baerly/protocol";
import { compact, type CompactResult, type InternalCompactOptions } from "./compactor.ts";
import { runGc, type InternalRunGcOptions, type RunGcResult } from "./gc.ts";
import type {
  InternalBoundedMaintenanceOptions,
  InternalMaintenanceOptions,
  LogRetentionOptions,
  MaintenanceOptions,
} from "./maintenance-options.ts";
import { probeTailFrom } from "./log-tail.ts";
import { retireLogRange } from "./log-retention.ts";
import { getCurrentContext } from "./observability/context.ts";

const ctxMetrics = (): MetricsRecorder => getCurrentContext()?.recorder ?? noopMetricsRecorder;

export { type CompactOptions, type CompactResult, compact } from "./compactor.ts";
export { type RunGcOptions, type RunGcResult, runGc } from "./gc.ts";
export {
  type RebuildIndexOptions,
  type RebuildIndexResult,
  rebuildIndex,
} from "./rebuild-index.ts";
// Public half only. `InternalMaintenanceOptions` is declared alongside
// it but deliberately NOT re-exported here — this is a published entry,
// and re-exporting the widening is exactly the leak being fixed.
export type { MaintenanceOptions } from "./maintenance-options.ts";

export interface MaintenanceArgs {
  readonly storage: Storage;
  /** Full bucket-relative key of the CAS pointer for the target collection. */
  readonly currentJsonKey: string;
}

export interface MaintenanceResult {
  readonly compact: CompactResult;
  readonly gc: RunGcResult;
}

/**
 * One log-retirement pass: run {@link retireLogRange} and emit its
 * counter. Shared by every maintenance trigger that retires stale logs
 * (`runScheduledMaintenance` and both retirement points inside
 * `runBoundedMaintenance`), so the metric name, option threading, and
 * error policy cannot drift between call sites.
 *
 * Error policy — deliberately NOT a bare swallow: `WriteConflict` (the floor
 * CAS lost to another writer, or a concurrent fold moved `log_seq_start`)
 * is routine contention, swallowed here and retried by the next pass.
 * Anything else is re-thrown for the caller's own error path, matching
 * how `compact()` / `runGc()` failures are treated at every call site:
 * `runBoundedMaintenance`'s outer catch counts
 * `db.maintenance.unexpected_error_total` and logs the stack, and
 * `runScheduledMaintenance` propagates per its documented "errors
 * propagate" contract. Retirement is the only mechanism bounding the
 * steady-state log-object count — a persistent unexpected failure must
 * not fail silently while objects accumulate unbounded.
 */
const retireLogs = async (
  storage: Storage,
  currentJsonKey: string,
  opts?: { logRetention?: LogRetentionOptions; signal?: AbortSignal },
): Promise<void> => {
  const collectionPrefix = currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"));
  const collection = collectionPrefix.slice(collectionPrefix.lastIndexOf("/") + 1);
  try {
    const retired = await retireLogRange(storage, currentJsonKey, {
      ...opts?.logRetention,
      ...(opts?.signal !== undefined && { signal: opts.signal }),
    });
    ctxMetrics().counter("db.log_retention.deleted_total", retired.deleted, {
      collection,
    });
  } catch (error) {
    if (isWriteConflict(error)) {
      return; // routine CAS contention — the next pass retries
    }
    throw error;
  }
};

/**
 * Single maintenance pass for one collection. Always runs `compact()` then
 * `runGc()` (in that order; the compactor's advance of `log_seq_start`
 * produces the stale-log candidates the GC then marks), then log
 * retirement. With {@link CLOUDFLARE_FREE_TIER} the whole pass is at most
 * 94 storage calls, 282 with every call retried, which fits the 900 a
 * Workers Free invocation may spend through the R2 binding. It does not fit
 * the 45 a Free invocation may spend through `fetch` (S3 over HTTP): there,
 * alternate direct `compact()` and `runGc()` calls, one per invocation, and
 * rely on the in-band write tick, which folds early on that host: a
 * scheduled compact there stalls once `tail_hint` is about 20 entries
 * stale (see {@link CLOUDFLARE_FREE_TIER}). The request ledger refuses any
 * call past the invocation's limit before it is sent, so a pass never
 * exceeds the limit.
 *
 * Defaults: `minEntriesToCompact` defaults to
 * {@link SCHEDULED_MIN_ENTRIES_TO_COMPACT} (1) on THIS entry point only — a
 * scheduler that fires has already decided it is time to work, so the
 * scheduled path drains the live tail to zero rather than parking it in a
 * dead zone between a count floor and the per-entry GET cost every read
 * pays. This is deliberately NOT `compact()`'s own default (100) or the
 * write-tick floor ({@link WRITE_TICK_MIN_ENTRIES_TO_COMPACT}, 50), both
 * of which exist to keep an in-band write from thrashing snapshot
 * rewrites. Every fold rewrites the whole snapshot, so a caller whose
 * fold cost outweighs its tail-read cost can raise the floor explicitly
 * via `options.compact.minEntriesToCompact`. {@link CLOUDFLARE_PAID_TIER}
 * carries this same floor of 1 plus per-pass caps — pass it for those
 * caps, not for an in-band count floor. {@link CLOUDFLARE_FREE_TIER}
 * carries an explicit 20, which keeps `minEntriesToCompact <= P` for its
 * bounded tail probe (derivation on that constant).
 *
 * Errors propagate — the caller's cron handler is responsible for
 * logging them. The Cloudflare runtime ships uncaught Worker errors
 * to the dashboard; Node operators wrap their `node-cron` callbacks
 * themselves.
 *
 * @example
 * ```ts
 * import {
 *   CLOUDFLARE_FREE_TIER,
 *   compact,
 *   runGc,
 *   runScheduledMaintenance,
 * } from "@gusto/baerly-storage/maintenance";
 *
 * // Node (unbounded — defaults fold the entire live tail):
 * const res = await runScheduledMaintenance(
 *   { storage, currentJsonKey: "app/x/tenant/t/manifests/tickets/current.json" },
 * );
 * console.log("compacted:", res.compact.entriesFolded, "swept:", res.gc.swept);
 *
 * // Write-amplification-sensitive: fold only once a tail has accumulated.
 * // Each fold rewrites the whole snapshot; the floor trades tail GETs on
 * // reads against snapshot PUTs on the schedule.
 * const res = await runScheduledMaintenance(
 *   { storage, currentJsonKey },
 *   { compact: { minEntriesToCompact: 10 } },
 * );
 *
 * // Cloudflare Free with the R2 binding: one bounded pass fits.
 * await runScheduledMaintenance({ storage, currentJsonKey }, CLOUDFLARE_FREE_TIER);
 *
 * // Cloudflare Free with S3 over HTTP: alternate the direct phases.
 * if (Math.floor(controller.scheduledTime / 60_000) % 2 === 0) {
 *   await compact({ storage, currentJsonKey }, CLOUDFLARE_FREE_TIER.compact);
 * } else {
 *   await runGc({ storage, currentJsonKey }, CLOUDFLARE_FREE_TIER.gc);
 * }
 * ```
 */
export const runScheduledMaintenance = async (
  args: MaintenanceArgs,
  options: MaintenanceOptions = {},
): Promise<MaintenanceResult> => {
  // The scheduled path owns its own fold floor. `compact()`'s own default
  // (100) and the write-tick floor (WRITE_TICK_MIN_ENTRIES_TO_COMPACT, 50)
  // exist for the IN-BAND tick, where a write is not a scheduling decision;
  // inheriting either here parks a low-write collection's tail permanently
  // in the dead zone between the floor and the per-entry GET cost every
  // read pays. A scheduler that fires has already decided it is time to
  // work — fold whatever tail exists. Callers that prefer to batch folds
  // pass `options.compact.minEntriesToCompact` explicitly, which suppresses
  // this default. `CLOUDFLARE_PAID_TIER` is built by
  // `profileToScheduledOptions`, whose default floor is also
  // SCHEDULED_MIN_ENTRIES_TO_COMPACT — callers pass it for per-pass caps.
  // `CLOUDFLARE_FREE_TIER` carries an explicit 20 (its bounded probe).
  const compactRes = await compact(args, {
    ...options.compact,
    ...(options.compact?.minEntriesToCompact === undefined && {
      minEntriesToCompact: SCHEDULED_MIN_ENTRIES_TO_COMPACT,
    }),
    ...(options.signal !== undefined && { signal: options.signal }),
  });
  const gcRes = await runGc(args, {
    ...options.gc,
    ...(options.signal !== undefined && { signal: options.signal }),
  });

  // Retire stale log objects. Cheap and bounded — a computed key range,
  // no LIST — and placed after GC so it runs on every maintenance pass.
  // `WriteConflict` is swallowed inside `retireLogs`; an unexpected error
  // propagates like a compact()/runGc() error, per the contract above.
  await retireLogs(args.storage, args.currentJsonKey, {
    logRetention: (options as InternalMaintenanceOptions).logRetention,
    ...(options.signal !== undefined && { signal: options.signal }),
  });

  return { compact: compactRes, gc: gcRes };
};

/** Host-agnostic write-tick budgets (`maxFoldBytes`=`C`, `maxFoldRows`=`E`). Canonical shape; mirrors the protocol constants (typed there to avoid a cycle). */
export interface MaintenanceProfile {
  readonly gcInterval: number;
  readonly gcMaxMarks: number;
  readonly gcMaxSweeps: number;
  readonly maxFoldEntriesPerPass: number;
  readonly maxFoldBytes: number;
  readonly maxFoldRows: number;
}

export {
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_CF_PAID,
  MAINTENANCE_PROFILE_NODE,
} from "@baerly/protocol";

// Snapshot ceilings aren't part of the scheduled cap surface; omitted.
// Default fold floor is the scheduled drain (1), not the write-tick 50:
// a library-provided scheduled profile exists for per-pass caps, and
// inheriting the in-band floor parks a 1–49 entry tail forever.
const profileToScheduledOptions = (
  profile: MaintenanceProfile,
  compactMaxTailProbeGets?: number,
  minEntriesToCompact: number = SCHEDULED_MIN_ENTRIES_TO_COMPACT,
): InternalMaintenanceOptions => ({
  compact: {
    maxEntriesPerRun: profile.maxFoldEntriesPerPass,
    minEntriesToCompact,
    ...(compactMaxTailProbeGets !== undefined && {
      maxTailProbeGets: compactMaxTailProbeGets,
    }),
  },
  gc: {
    maxMarksPerRun: profile.gcMaxMarks,
    maxSweepsPerRun: profile.gcMaxSweeps,
  },
});

/**
 * Tuning profile for Cloudflare Workers Free, derived from
 * {@link MAINTENANCE_PROFILE_CF_FREE} (one source of truth): fold slice
 * N=20, compact tail probe P=25 ({@link CF_FREE_COMPACT_TAIL_PROBE_GETS}),
 * GC sweeps S=10, marks 20.
 *
 * **These caps are ceilings, not the budget.** Every storage call is
 * charged to the invocation's request ledger, which refuses a call past
 * the host's limit before sending it: 900 calls through the R2 binding
 * (`CF_FREE_INTERNAL_REQUEST_LIMIT`), 45 through `fetch`
 * (`CF_FREE_EXTERNAL_REQUEST_LIMIT`). The caps bound one pass's work so
 * that it fits those limits; they do not need to stay under a 50 of their
 * own. The in-band write tick (`runBoundedMaintenance`) also sizes each
 * phase from what the ledger has left, net of commit holds: a fold that
 * does not fit is skipped, and a GC slice or retirement pass runs with a
 * smaller DELETE cap.
 *
 * Budget arithmetic (worst case, one storage call per GET, PUT, DELETE or
 * LIST page):
 *   compact: 1 current GET + P tail-probe GETs + 1 optional prior-snapshot
 *     GET + N folded-log GETs + 1 snapshot PUT + 1 `current.json` CAS PUT
 *     = 4 + N + P.
 *   GC, maximally contended: 1 current GET + 3 pending-bootstrap-conflict
 *     operations + 1 `snapshot/` LIST page (the mark window never exceeds
 *     one page) + 1 conditional fresh-current GET before a due snapshot
 *     sweep + S DELETEs + all three final pending CAS attempts (3 GETs +
 *     3 PUTs) = 12 + S.
 *   retirement: 1 advisory-gate GET + 1 CAS GET + 1 CAS PUT + up to
 *     `LOG_RETENTION_MAX_DELETES_PER_TICK` (20) DELETEs = 23.
 *
 * At these caps, fault-free / with every call retried
 * `STORAGE_RETRY_MAX_ATTEMPTS` (3) times:
 *
 * | Pass | Calls | Retried |
 * | --- | --- | --- |
 * | compaction | 49 | 147 |
 * | GC | 22 | 66 |
 * | write-tick GC (runner GET + GC + `tail_hint` refresh GET+PUT + retirement gate GET) | 26 | 78 |
 * | retirement | 23 | 69 |
 * | write-tick GC + retirement | 48 | 144 |
 * | scheduled compact + GC + retirement | 94 | 282 |
 *
 * Every row fits 900, so on Free with the R2 binding one
 * {@link runScheduledMaintenance} call per invocation is safe. Free CPU is
 * the tighter limit there (about 0.25 ms per binding call against a 10 ms
 * budget), which is why the caps stay at their measured values. Through
 * `fetch` the compaction row alone can pass 45: a scheduler on that host
 * runs one direct `compact()` or `runGc()` phase per invocation, and even
 * then a scheduled compact whose `tail_hint` is about 20 or more entries
 * stale stalls. Its probe and log GETs reach call 46 before it writes
 * anything, so the ledger refuses a log GET, nothing is checkpointed, and
 * every later pass repeats it. On that host the in-band write tick, which
 * folds early (`CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES`) from the writer's own
 * tail, is the path that keeps the tail moving.
 *
 * `minEntriesToCompact` is `maxFoldEntriesPerPass` (20) here, passed
 * explicitly (not the scheduled helper default of 1), because a bounded
 * probe changes what "available" can even mean. `compact()` measures
 * `available = discoveredTail − log_seq_start`, and a P-capped probe
 * certifies at most `probeFloor + P`, so
 * a threshold above P is only reachable after several passes have each spent
 * P GETs to ratchet `tail_hint` forward — every one of them returning
 * `probe-budget-checkpointed` without folding. Holding 50 against P=25 also
 * pairs a threshold with a smaller per-pass fold cap (N=20), which folds 20
 * of an accumulated 50 and then waits for the remainder to climb back to 50.
 * Keeping the threshold at N makes a pass fold exactly when one pass's worth
 * of work exists. Any future edit must keep `minEntriesToCompact <= P`.
 *
 * `maintenance-budget.test.ts` pins the per-phase counts exactly and checks
 * each against the Free limit with retries.
 */
export const CLOUDFLARE_FREE_TIER: MaintenanceOptions = profileToScheduledOptions(
  MAINTENANCE_PROFILE_CF_FREE,
  CF_FREE_COMPACT_TAIL_PROBE_GETS,
  MAINTENANCE_PROFILE_CF_FREE.maxFoldEntriesPerPass,
);

/**
 * Tuning profile for Cloudflare Workers Paid, derived from
 * {@link MAINTENANCE_PROFILE_CF_PAID} (one source of truth): Node-tier
 * per-pass fold, GC classification, and sweep budgets, and a compact tail
 * probe of {@link CF_PAID_COMPACT_TAIL_PROBE_GETS} (`P` = 1,000) GETs.
 *
 * Worst cases, with the {@link CLOUDFLARE_FREE_TIER} formulas at N=200,
 * P=1,000, S=100 (fault-free / every call retried
 * `STORAGE_RETRY_MAX_ATTEMPTS` = 3 times): compaction `4 + N + P` =
 * 1,204 / 3,612; GC `12 + S` = 112 / 336; retirement 23 / 69; one
 * scheduled compact + GC + retirement pass 1,339 / 4,017. All fit the Paid
 * request ledger limit of 9,000 (`CF_PAID_REQUEST_LIMIT`). The bounded
 * probe is what makes the compaction figure finite: unbounded, a pass
 * behind a stale `tail_hint` could need up to `LOG_FORWARD_PROBE_CAP`
 * GETs, which the ledger refuses before the fold lands.
 *
 * Fold floor is {@link SCHEDULED_MIN_ENTRIES_TO_COMPACT} (1): this object
 * exists for per-pass caps (`maxEntriesPerRun: 200`, GC bounds), not for
 * an in-band count floor. Pass it to {@link runScheduledMaintenance} and
 * a live tail of any length folds, sliced by those caps.
 *
 * To honour `BAERLY_MAINTENANCE_PROFILE=cf-paid` on the cron path, pass this
 * constant to `runScheduledMaintenance` inside your
 * {@link WorkerScheduledHandler}; the worked recipe lives in the `scheduled`
 * handler docstring of `baerlyWorker` (`@gusto/baerly-storage/cloudflare`).
 *
 * @see packages/server/src/maintenance-budget.test.ts
 */
export const CLOUDFLARE_PAID_TIER: MaintenanceOptions = profileToScheduledOptions(
  MAINTENANCE_PROFILE_CF_PAID,
  CF_PAID_COMPACT_TAIL_PROBE_GETS,
);

// =====================================================================
// Write-tick (in-band) maintenance — `runBoundedMaintenance`.
//
// This is the runner the writer hook dispatches after a successful
// commit. It is intentionally a thin, bounded composition over the
// EXISTING `compact()` / `runGc()` primitives. The fold-viability
// decision is made HERE (a pre-fold projection over `current.json`'s
// `snapshot_bytes` / `snapshot_rows`) rather than inside `compact()`:
// on a CPU-limited Cloudflare isolate an invocation terminated mid-rebuild
// would never reach a post-rebuild size check, so the gate is one that
// never starts an over-ceiling fold.
// =====================================================================

/**
 * Floor-based GC-cadence boundary crossing. Every commit advances the
 * writer-observed tail by one logical slot; `tail_hint` remains a
 * lower bound and may be refreshed later by maintenance. The floor test
 * trips on any interval boundary inside `(prevSeq, nextSeq]`, so it
 * stays correct whether the observed/probed tail advances by one or
 * catches up by a larger step.
 */
export const crossesGcBoundary = (prevSeq: number, nextSeq: number, interval: number): boolean =>
  Math.floor(prevSeq / interval) !== Math.floor(nextSeq / interval);

/**
 * The write-tick runner's pre-fold projection off STORED figures: the
 * snapshot it would load is within `C` bytes and `E` rows. It does not
 * project the pass: `compact()` counts real rows as it applies the range
 * and folds the longest prefix that stays within `E`, so an update/delete
 * tail keeps folding at the ceiling and only an entry that would add a row
 * past `E` stops it. The runner, `baerly inspect` and the backlog bench
 * share this predicate. Both comparisons are written so a NaN ceiling
 * fails closed.
 */
export const isFoldViable = (
  snapshotBytes: number,
  snapshotRows: number,
  ceilings: Pick<MaintenanceProfile, "maxFoldBytes" | "maxFoldRows">,
): boolean => snapshotBytes <= ceilings.maxFoldBytes && snapshotRows <= ceilings.maxFoldRows;

/** The fold ceilings `C` (`maxFoldBytes`) and `E` (`maxFoldRows`) a host folds within. */
export type FoldCeilings = Pick<MaintenanceProfile, "maxFoldBytes" | "maxFoldRows">;

/**
 * Resolve the serving host's fold ceilings: `profile` (absent ⇒
 * {@link MAINTENANCE_PROFILE_CF_FREE}) with `C` overridden by
 * `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` (`maxFoldBytes`). `E` has no
 * override. The write-tick runner and growth refusal (`capacity.ts`) both
 * resolve through here, so a refusal and a fold never see different
 * ceilings.
 */
export const resolveFoldCeilings = (
  profile: MaintenanceProfile | undefined,
  maxFoldBytes: number | undefined,
): FoldCeilings => {
  const resolved = profile ?? MAINTENANCE_PROFILE_CF_FREE;
  return {
    maxFoldBytes: maxFoldBytes ?? resolved.maxFoldBytes,
    maxFoldRows: resolved.maxFoldRows,
  };
};

/**
 * Derived live-tail byte size — the ratio TRIGGER input that replaces the
 * formerly-stored exact byte count. `(observedTail − log_seq_start) ×
 * mean_entry_bytes`. `observedTail` is a param so write-tick callers can
 * pass the writer-observed tail and scheduled callers can pass a
 * probe-discovered true tail. Cold-start (no mean yet) falls back to
 * {@link MAINTENANCE_COLD_START_ENTRY_BYTES}, never 0 (see that constant).
 * TRIGGER-only — structurally barred from `foldViable` (the exact-bytes fold
 * ceiling).
 */
export const estimateTailBytes = (current: CurrentJson, observedTail: number): number =>
  Math.max(0, observedTail - current.log_seq_start) *
  (current.mean_entry_bytes ?? MAINTENANCE_COLD_START_ENTRY_BYTES);

/**
 * The cheap DISPATCH gate the writer calls after a commit — zero
 * storage ops; it reads the post-commit {@link CurrentJson} already in
 * scope. Ratio-OR-boundary, WITHOUT the entry floor (the floor is part
 * of the fold-trigger Gate 1 checked inside {@link runBoundedMaintenance}).
 * Returning `false` lets the writer skip the dispatch entirely. Ratio
 * numerator is the DERIVED {@link estimateTailBytes};
 * `observedTail` threads from the caller (the writer's in-memory observed
 * tail `seq+1` under single-write commit). Both the boundary check and the
 * ratio key off `observedTail`, since the stored `tail_hint` is now only a
 * non-authoritative lower bound (compactor-advanced).
 */
export const shouldFireMaintenance = (
  current: CurrentJson,
  prevSeq: number,
  gcInterval: number,
  observedTail: number,
): boolean =>
  crossesGcBoundary(prevSeq, observedTail, gcInterval) ||
  estimateTailBytes(current, observedTail) /
    Math.max(current.snapshot_bytes, MAINTENANCE_MIN_LIVE_BYTES) >=
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
  /**
   * @internal — test seam. Log retention options (window size, max deletes).
   * Production callers should omit it and take the defaults.
   */
  readonly logRetention?: LogRetentionOptions;
  readonly signal?: AbortSignal;
}

/** Which fold gate closed: the runner's pre-fold projection, or compact()'s post-rebuild check. */
type FoldGate = "pre-fold" | "rebuild";

/**
 * Structured fields of one fold-wall deferral — the `fold_deferred`
 * LogTape record carries these plus `detail`, the
 * {@link foldDeferredWarning} rendering of them for humans. `snapshot_*` are the stored figures on a
 * `pre-fold` defer and the rebuilt (unwritten) figures on a `rebuild` one.
 */
// A `type` (not `interface`) so it is assignable to the `warn` sink's
// `Readonly<Record<string, unknown>>` parameter.
type FoldDeferredFields = {
  readonly collection: string;
  readonly dimension: "bytes" | "rows";
  readonly gate: FoldGate;
  readonly snapshot_bytes: number;
  readonly snapshot_rows: number;
  /** `C`, after any `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` override. */
  readonly ceiling_bytes: number;
  /** `E` — per host profile, no env override. */
  readonly ceiling_rows: number;
  readonly live_log_tail: number;
  readonly log_seq_start: number;
};

/**
 * Human-readable line for a fold-wall deferral. Names both ceilings, which
 * arm tripped, that `log_seq_start` and log retention are frozen, and the
 * remedy that actually applies to that arm — the bytes override does
 * nothing for rows.
 */
const foldDeferredWarning = (f: FoldDeferredFields): string => {
  const which = f.gate === "rebuild" ? "rebuilt" : "stored";
  const rowsTripped =
    f.gate === "rebuild"
      ? `the rows arm tripped (the next log entry adds a row past E, or the rebuilt snapshot is over E)`
      : `the rows arm tripped (snapshot_rows > E)`;
  const tripped =
    f.dimension === "bytes" ? `the bytes arm tripped (snapshot_bytes > C)` : rowsTripped;
  const remedy =
    f.dimension === "bytes"
      ? `On Workers Paid set BAERLY_MAINTENANCE_PROFILE=cf-paid (C=${MAINTENANCE_PROFILE_CF_PAID.maxFoldBytes}); ` +
        `on paid Cloudflare / Node you can also raise BAERLY_MAINTENANCE_MAX_FOLD_BYTES — but on ` +
        `Cloudflare a cap above the configured default may exceed an invocation's CPU or ` +
        `memory resources, so such folds may not land. Otherwise, move to a database service (D1 / Postgres).`
      : `E has no env override, and BAERLY_MAINTENANCE_MAX_FOLD_BYTES does not apply to rows. ` +
        `On Cloudflare, move to Workers Paid and set BAERLY_MAINTENANCE_PROFILE=cf-paid ` +
        `(E=${MAINTENANCE_PROFILE_CF_PAID.maxFoldRows}); on Node (E=${MAINTENANCE_PROFILE_NODE.maxFoldRows}) ` +
        `or past the paid ceiling, split the collection or move to a database service (D1 / Postgres).`;
  return (
    `baerly-storage: collection "${f.collection}" has stopped compacting — the ${which} ` +
    `snapshot is ${f.snapshot_bytes} bytes / ${f.snapshot_rows} rows against this host's fold ` +
    `ceiling C=${f.ceiling_bytes} bytes, E=${f.ceiling_rows} rows, and ${tripped}. Until it ` +
    `folds again log_seq_start stays at ${f.log_seq_start}, log retention is paused, the live ` +
    `tail (${f.live_log_tail} entries) and the bucket grow without bound, and every read ` +
    `replays the tail. ${remedy} See docs/about/graduation.md.`
  );
};

/**
 * The write-tick maintenance runner: a bounded, single-attempt
 * composition of {@link compact} and {@link runGc} for one collection,
 * sized by default to a conservative Cloudflare free-tier CPU budget.
 *
 * INVARIANT: a {@link MaintenanceProfile} changes only maintenance rate +
 * defer threshold — never data/API/query/wire/correctness; reads stay pure.
 * See `maintenance-profile-equivalence.test.ts`.
 *
 * Never throws — the write-tick caller must never see a maintenance
 * failure. CAS contention is swallowed quietly, and so is a call the
 * invocation's request ledger refused (each phase is sized from the
 * ledger's remainder first; see the request-budget note inside, and
 * `docs/spec/sync-protocol.md` "Per-invocation request budget"); an over-ceiling deferral
 * is not an error but is signalled loudly (see `signalFoldDeferred`
 * inside); unexpected throws bump
 * `db.maintenance.unexpected_error_total`, log a stack, and are
 * swallowed.
 *
 * Control flow (fold-priority with a stateless GC-starvation guard):
 *   0. `disabled` → skip fold/GC, but still allow the rate-limited
 *      tail_hint refresh that bounds read/write forward-probes.
 *   1. Read `current.json` once.
 *   2. Hard-GC starvation boundary (`"single"` only) → GC slice, skip fold.
 *   3. Gate 1 (ratio AND entry floor, or a forced tick) trips → fold if the pre-fold
 *      projection is viable, else defer and signal. On `"single"` a fold
 *      attempt is this tick's one phase — including one that compact()
 *      deferred after rebuilding, which signals the same way and ends the
 *      tick. A pre-fold defer falls through to Step 4.
 *   4. Otherwise (or on `"both"`) → GC iff the cadence boundary crossed.
 *
 * Steps 0, 2, 3-defer, and 4 all take the rate-limited `tail_hint`
 * refresh, but the tick publishes the hint AT MOST ONCE — a landed fold
 * (Step-7 CAS) and the refresh itself both count as that publication.
 * Ordering matters: Step 3's defer refreshes and then falls through to
 * Step 4, so without the shared guard that one tick would CAS
 * `current.json` twice with identical bytes.
 */
export const runBoundedMaintenance = async (
  args: {
    storage: Storage;
    currentJsonKey: string;
    /** The pre-commit observed tail — the GC cadence baseline. */
    prevSeq: number;
    /**
     * Writer's in-memory observed tail (`seq + 1`). Given on the
     * write-tick path so the runner's Gate-1 ratio + GC cadence key off
     * the true tail without an O(gap) re-probe (the stored `tail_hint` is
     * only a lower bound). Absent on a scheduled tick ⇒ the runner probes.
     */
    observedTail?: number;
    /** `C` override (from `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`). */
    maxFoldBytes?: number;
    /** From `BAERLY_MAINTENANCE_DISABLE`: disable fold/GC phases, not tail_hint refresh. */
    disabled?: boolean;
    /**
     * Forced tick (main-10 G6): the writing verb found the collection at
     * its growth-refusal point, so Gate 1's ratio trigger and entry floor
     * are bypassed and any pending tail folds. Every other step is
     * unchanged: the pre-fold ceiling check, the hard-GC guard, and the
     * per-pass budget (`maxFoldEntriesPerPass`).
     */
    forceFold?: boolean;
  },
  options?: BoundedMaintenanceOptions,
): Promise<void> => {
  const { storage, currentJsonKey, prevSeq } = args;
  // Resolve the profile ONCE (the runner's single CF-free-safe default,
  // preserving the bare-`Db.create()` promise); all phase budgets read off it.
  const profile = options?.profile ?? MAINTENANCE_PROFILE_CF_FREE;
  const { maxFoldEntriesPerPass, gcMaxMarks, gcMaxSweeps, gcInterval } = profile;
  const forceFold = args.forceFold === true;
  // A forced tick folds whatever is pending: one entry clears the floor.
  const minEntriesToCompact = forceFold
    ? 1
    : (options?.minEntriesToCompact ?? WRITE_TICK_MIN_ENTRIES_TO_COMPACT);
  const phasesPerTick = options?.phasesPerTick ?? "single";
  const signal = options?.signal;
  // `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` (args.maxFoldBytes) overrides `C`.
  const ceilings = resolveFoldCeilings(profile, args.maxFoldBytes);
  const C = ceilings.maxFoldBytes;
  const E = ceilings.maxFoldRows;

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

  // Request budget. On a host with a per-invocation request cap the tick
  // shares the ledger of the write that dispatched it (`ctx.waitUntil` work
  // included), so each phase is sized at its start from what that ledger
  // has left on the pool the storage charges, net of active holds
  // (`storageRemaining()`). A tick dispatched while a multi-row write runs
  // sits outside every commit hold, so it sizes against the room the later
  // rows' commit-resolution reserves leave. A phase whose common-path
  // cost does not fit is skipped, and a GC slice or retirement pass that
  // fits only in part runs with a smaller DELETE cap. The profile's caps
  // stay the ceilings. A call that still overruns (a retry, a tail a
  // concurrent writer lengthened) is refused by the ledger before it is
  // sent; the tick ends there and the next one resumes.
  const ledger = getCurrentContext()?.ledger;
  const requestsLeft = (): number => ledger?.storageRemaining() ?? Infinity;
  const skipForBudget = (phase: "fold" | "gc" | "retire" | "tail_hint"): void => {
    ctxMetrics().counter("db.maintenance.request_budget_skipped_total", 1, { collection, phase });
  };

  const retireWithinBudget = async (): Promise<void> => {
    // Unlike the other phases, sized for every attempt: the floor CAS lands
    // before the DELETEs, so a DELETE refused after it leaks for good.
    const deletes = Math.floor(
      (requestsLeft() - MAINTENANCE_RETIRE_PRE_FLOOR_REQUESTS) / STORAGE_RETRY_MAX_ATTEMPTS,
    );
    if (deletes < 1) {
      skipForBudget("retire");
      return;
    }
    const logRetention = options?.logRetention;
    const maxDeletes = logRetention?.maxDeletes ?? LOG_RETENTION_MAX_DELETES_PER_TICK;
    await retireLogs(storage, currentJsonKey, {
      logRetention: deletes < maxDeletes ? { ...logRetention, maxDeletes: deletes } : logRetention,
      ...(signal !== undefined && { signal }),
    });
  };

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
    const snapshotBytes = current.snapshot_bytes;
    const snapshotRows = current.snapshot_rows;
    const logSeqStart = current.log_seq_start;
    // Tail for THIS tick's Gate-1 ratio + GC cadence. Under single-write
    // commit `tail_hint` is only a lower bound (compactor-advanced), so the
    // tick can't read the true tail off `current.json`. Two sources:
    //   - write-tick: use the writer's in-memory `observedTail` directly
    //     (no re-probe — keeps the hot path off an O(gap) forward walk).
    //   - scheduled (no `observedTail`): forward-probe the true tail here
    //     (affordable at cron cadence).
    // Both floor at `max(log_seq_start, tail_hint)`.
    const probeFloor = Math.max(logSeqStart, current.tail_hint);
    let nextSeq: number;
    if (args.observedTail !== undefined) {
      nextSeq = Math.max(args.observedTail, probeFloor);
    } else {
      const probed = await probeTailFrom(
        storage,
        collectionPrefix,
        probeFloor,
        signal !== undefined ? { signal } : undefined,
      );
      nextSeq = probed.tail;
    }
    // Ratio TRIGGER numerator = DERIVED estimate (formerly exact stored field).
    const tailBytesEst = estimateTailBytes(current, nextSeq);

    const ratio = tailBytesEst / Math.max(snapshotBytes, MAINTENANCE_MIN_LIVE_BYTES);
    const foldAtTailEntries = (options as InternalBoundedMaintenanceOptions | undefined)
      ?.foldAtTailEntries;
    const gate1 =
      forceFold ||
      (foldAtTailEntries !== undefined && nextSeq - logSeqStart >= foldAtTailEntries) ||
      (ratio >= MAINTENANCE_TARGET_RATIO && nextSeq - logSeqStart >= minEntriesToCompact);
    // SAFETY ceiling (conservative CF CPU/memory budget) — EXACT snapshot_bytes/rows, NEVER the estimate.
    // The pass is not projected: compact() stops at the first entry that
    // would add a row past E, against the current.json it folds from.
    const foldViable = isFoldViable(snapshotBytes, snapshotRows, ceilings);
    const gcDue = crossesGcBoundary(prevSeq, nextSeq, gcInterval);

    // ONE `tail_hint` publication per tick, whoever performs it: this
    // helper's own CAS, or a fold that landed (compact()'s Step-7 stamps
    // `max(stored, discoveredTail)` with a probe floor including
    // `knownTail = nextSeq`).
    //
    // The rate limit alone cannot enforce this. It tests the in-memory
    // `current`, which `casUpdateCurrentJson` never writes back, so a
    // second call on a >= REFRESH_INTERVAL gap still reads as due and
    // rewrites byte-identical bytes. Every path that reaches GC after
    // already publishing — a landed fold on `"both"`, and the Step-3
    // DEFER refresh that falls through — would otherwise spend a second
    // GET+PUT for no state change.
    let tailHintPublished = false;

    // `stampWarnedSeq` rides the deferral warn's `last_warned_seq` stamp on
    // the SAME CAS as the hint refresh, so a warning defer costs one
    // GET+PUT, not two. A single-phase rebuild-gate defer tick then costs
    // 26 ops — runner GET 1 + deferred compact() 23 (current.json GET,
    // `knownTail` probe, snapshot GET, 20 log GETs) + this CAS 2; pinned in
    // `maintenance-budget.test.ts`.
    const refreshTailHintIfNeeded = async (stampWarnedSeq = false): Promise<void> => {
      if (!stampWarnedSeq) {
        if (tailHintPublished) {
          return;
        }
        if (nextSeq - current.tail_hint < MAINTENANCE_TAIL_HINT_REFRESH_WRITES) {
          return;
        }
      }
      // Set before the CAS, so this counts publication ATTEMPTS: a lost
      // CAS means a peer advanced the hint (the stamp is monotone, so it
      // is published either way) and a transient error is caught by the
      // next tick. Retrying inside one tick would reintroduce the extra
      // ops this guard exists to bound.
      tailHintPublished = true;
      if (requestsLeft() < MAINTENANCE_TAIL_HINT_REFRESH_REQUESTS) {
        skipForBudget("tail_hint");
        return;
      }
      try {
        await casUpdateCurrentJson(
          storage,
          currentJsonKey,
          (c) => ({
            ...c,
            tail_hint: Math.max(c.tail_hint, nextSeq),
            ...(stampWarnedSeq && { last_warned_seq: nextSeq }),
          }),
          signal !== undefined ? { signal } : undefined,
        );
      } catch {
        // Swallow — WriteConflict (compactor/another isolate advanced first) or
        // any transient error. A missed advance just means the next tick
        // catches up; a lost warn stamp just means another isolate warns
        // slightly sooner/later. Never throw out of write-tick maintenance.
      }
    };

    /**
     * The one fold-wall deferral signal, shared by both gates so a
     * deferral counts once and reads the same wherever it closed:
     *
     * - `db.compaction.deferred_total` (labels `collection`, `dimension`,
     *   `gate`) plus `db.compaction.deferred_{bytes,rows}_total` — distinct
     *   names, because the canonical line keys counters by name alone and
     *   drops labels.
     * - A `fold_deferred` structured warning through the adapter's
     *   {@link MaintenanceDispatch.warn} sink, carrying the human text as
     *   `detail` — or, with no sink or one that throws, that text as a
     *   `console.warn` line. Rate-limited by the SHARED `current.json.last_warned_seq` (not a
     *   per-isolate Set — a fresh isolate must honour it). A collection
     *   that has never warned warns on its first deferral. On Cloudflare
     *   the tick runs in `ctx.waitUntil` after the canonical line flushed,
     *   so the log record is the only signal an operator sees.
     * - The bounded `tail_hint` refresh (HR-2): a deferring collection
     *   never reaches compact()'s Step-7 CAS, so without it every read
     *   would re-walk the whole growing tail. Write-tick only; reads stay
     *   pure.
     */
    const signalFoldDeferred = async (d: {
      gate: FoldGate;
      dimension: "bytes" | "rows";
      snapshotBytes: number;
      snapshotRows: number;
    }): Promise<void> => {
      const metrics = ctxMetrics();
      metrics.counter("db.compaction.deferred_total", 1, {
        collection,
        dimension: d.dimension,
        gate: d.gate,
      });
      metrics.counter(
        d.dimension === "bytes"
          ? "db.compaction.deferred_bytes_total"
          : "db.compaction.deferred_rows_total",
        1,
        { collection, gate: d.gate },
      );
      // A collection that has never warned warns on its FIRST deferral, so a
      // young collection does not sit silent until seq 1000.
      const warnDue =
        current.last_warned_seq === undefined ||
        nextSeq - current.last_warned_seq >= MAINTENANCE_WARN_INTERVAL_WRITES;
      if (warnDue) {
        const fields: FoldDeferredFields = {
          collection,
          dimension: d.dimension,
          gate: d.gate,
          snapshot_bytes: d.snapshotBytes,
          snapshot_rows: d.snapshotRows,
          ceiling_bytes: C,
          ceiling_rows: E,
          live_log_tail: nextSeq - logSeqStart,
          log_seq_start: logSeqStart,
        };
        const detail = foldDeferredWarning(fields);
        const sink = getCurrentContext()?.maintenance?.warn;
        let delivered = false;
        if (sink !== undefined) {
          // A throwing custom sink must not skip the stamp + hint refresh
          // below (or GC after it), so its failure is contained here.
          try {
            sink("fold_deferred", { ...fields, detail });
            delivered = true;
          } catch {
            // Fall through to the console line.
          }
        }
        // The human line goes to the console only when no sink took the
        // record — a bare `Db.create()` (no adapter, or `observability:
        // false`) or a sink that threw — so an adapter logs one line per
        // deferral, not two.
        if (!delivered) {
          console.warn(detail);
        }
      }
      await refreshTailHintIfNeeded(warnDue);
    };

    const runGcAndRefreshTailHint = async (): Promise<void> => {
      const sweeps = requestsLeft() - MAINTENANCE_GC_BASE_REQUESTS;
      if (sweeps < 0) {
        skipForBudget("gc");
      } else {
        await runGc(
          { storage, currentJsonKey },
          sweeps < gcMaxSweeps ? { ...gcOpts, maxSweepsPerRun: sweeps } : gcOpts,
        );
      }
      await refreshTailHintIfNeeded();
    };

    // Every tick that is due takes the rate-limited refresh, whichever way
    // it exits: a single-phase fold that published nothing returns early,
    // and with zero adapter retries one 503 throws out of compact() or
    // runGc(). A skipped refresh leaves the writer's `findLogTail` galloping
    // over the lag on every commit. `tailHintPublished` makes this a no-op
    // once a landed fold or an earlier refresh published the hint, so the
    // tick still publishes at most once.
    try {
      // ── Step 0. Phase disable. ───────────────────────────────────────
      // `BAERLY_MAINTENANCE_DISABLE` suppresses fold/GC work, but it must
      // not let `(true_tail - tail_hint)` grow past the read/write
      // forward-probe cap. Keep the same bounded, best-effort hint refresh
      // used by deferring collections; reads stay pure because this path
      // only runs from write-tick maintenance.
      if (args.disabled === true) {
        await refreshTailHintIfNeeded();
        return;
      }

      // ── Step 2. Hard-GC starvation guard ("single" only). ────────────
      // A long fold-heavy drain would otherwise starve GC on every
      // ratio-tripping tick. A COARSE cadence the fold may NOT preempt
      // guarantees ~1 GC tick per GC_STARVATION_GUARD intervals.
      const hardGc = crossesGcBoundary(prevSeq, nextSeq, gcInterval * GC_STARVATION_GUARD);
      if (phasesPerTick === "single" && hardGc) {
        await runGcAndRefreshTailHint();
        // Retire stale logs after GC even on the early-return path.
        // Non-WriteConflict errors re-throw into the outer catch below
        // (unexpected_error_total + stack log), like every other phase.
        await retireWithinBudget();
        return;
      }

      // ── Step 3. Fold-priority. ───────────────────────────────────────
      // A fold folds at most one pass of the tail the runner sees. It is not
      // shortened to fit: the growth refusal (`capacity.ts`) models passes
      // of exactly `maxFoldEntriesPerPass` seqs, so a shorter pass could
      // rebuild past `C` where the modelled one lands. One that does not
      // fit is skipped and falls through to GC like a pre-fold defer.
      const foldFits =
        requestsLeft() >=
        MAINTENANCE_FOLD_BASE_REQUESTS +
          Math.min(maxFoldEntriesPerPass, Math.max(0, nextSeq - logSeqStart));
      if (gate1 && foldViable && !foldFits) {
        skipForBudget("fold");
      } else if (gate1) {
        if (foldViable) {
          // Thread the same `C` / `E` ceilings the pre-fold projection
          // above used into compact() as a Node-side belt-and-suspenders.
          // compact() emits `db.compaction.cas_lost_total` itself on a
          // lost CAS, so the runner does NOT (avoids double-count).
          const foldRes = await compact({ storage, currentJsonKey }, {
            maxEntriesPerRun: maxFoldEntriesPerPass,
            // compact() re-checks the floor against the tail it discovers,
            // so it must accept whichever Gate-1 arm tripped.
            minEntriesToCompact:
              foldAtTailEntries === undefined
                ? minEntriesToCompact
                : Math.min(minEntriesToCompact, foldAtTailEntries),
            ceilingBytes: C,
            ceilingEntries: E,
            // B4: on the write-tick path the runner already knows a fresh
            // tail lower bound (`nextSeq`, derived from the writer's
            // `observedTail`). Pass it as the compactor's probe floor so the
            // ceiling probe is bounded by commits since this writer's commit,
            // not by an O(gap) re-walk from a stale stored `tail_hint`. On
            // the scheduled path (no `observedTail`) `nextSeq` is itself the
            // freshly-probed tail, so it's still a valid (tight) floor.
            knownTail: nextSeq,
            ...(signal !== undefined && { signal }),
          } as InternalCompactOptions);
          // A `written` fold stamped `max(stored, discoveredTail)` at or past
          // `nextSeq` via Step-7. Every other outcome reachable here (failed,
          // skipped, deferred, CAS-lost) published nothing, so it takes the
          // closing refresh. The one skip that does publish,
          // `probe-budget-checkpointed`, needs `maxTailProbeGets`, which this
          // runner never passes.
          if (foldRes.written) {
            tailHintPublished = true;
          }
          // REBUILD-GATE DEFER: the stored snapshot passed the projection but
          // the rebuilt one is over `C` / `E`. The capacity check refuses
          // every write whose fold pass would rebuild past the ceiling, so a
          // write tick lands here only on log entries that check never saw
          // (another host's writes); scheduled runs also reach it on a
          // partial last pass. Same signal as the pre-fold defer below.
          if (foldRes.deferral !== undefined) {
            await signalFoldDeferred({
              gate: "rebuild",
              dimension: foldRes.deferral.dimension,
              snapshotBytes: foldRes.deferral.snapshotBytes,
              snapshotRows: foldRes.deferral.snapshotRows,
            });
          }
          if (phasesPerTick === "single") {
            // This tick's one phase was the fold attempt. A rebuild defer
            // already spent a full compact() walk, so it must NOT also GC:
            // runner GET (1) + deferred compact (23) + the one signal CAS (2)
            // is 26 ops, and a GC slice on top would spend request budget the
            // write's own route needs on Free over `fetch`. An unpublished
            // fold takes the closing refresh in the `finally` below; after a
            // rebuild defer the signal already took it, so that is a no-op.
            return;
          }
          // "both": fall through to GC.
        } else {
          // PRE-FOLD DEFER: stored snapshot over the ceiling (bytes OR rows).
          // A deferring bucket MUST still GC, so we fall through.
          await signalFoldDeferred({
            gate: "pre-fold",
            dimension: snapshotBytes > C ? "bytes" : "rows",
            snapshotBytes,
            snapshotRows,
          });
        }
      }

      // ── Step 4. GC phase — cadence-gated. ────────────────────────────
      // Reaching here on "single" means we did NOT fold (gate1 false, or
      // deferred). Run GC iff the cadence boundary was crossed.
      if (gcDue) {
        await runGcAndRefreshTailHint();
      }

      // ── Step 5. Retire stale log objects. ──────────────────────────────
      // Cheap and bounded — a computed key range, no LIST — and placed
      // after GC so it runs on every maintenance pass. `WriteConflict` is
      // swallowed inside `retireLogs`; anything unexpected re-throws into
      // this runner's outer catch (counter + stack log), never out of the
      // write-tick path.
      await retireWithinBudget();
    } finally {
      await refreshTailHintIfNeeded();
    }
  } catch (error) {
    // CAS contention (WriteConflict) thrown by compact()/runGc() is an
    // EXPECTED signal — swallow without the unexpected-error counter.
    if (isWriteConflict(error)) {
      return;
    }
    // So is a call refused before it was sent (`cause.refused`: the request
    // ledger, or the platform's subrequest limit): the tick spent this
    // invocation's request budget, and the next tick resumes. Any other
    // CapacityExceeded is unexpected here.
    if (
      error instanceof BaerlyError &&
      error.code === "CapacityExceeded" &&
      (error.cause as { refused?: boolean } | undefined)?.refused === true
    ) {
      ctxMetrics().counter("db.maintenance.request_budget_refused_total", 1, { collection });
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
 * Dispatch one write-tick {@link runBoundedMaintenance} through the
 * request's {@link MaintenanceDispatch}: inline and awaited by default,
 * `ctx.waitUntil` on Cloudflare. Never throws: the tick swallows its own
 * failures, and a failing dispatcher bumps
 * `db.write.maintenance_dispatch_failed_total`. The writer calls it after
 * a commit; a write refused with `MaintenancePending` calls it with
 * `forceFold` and nothing committed (`prevSeq === observedTail`).
 */
export const dispatchWriteTick = async (args: {
  storage: Storage;
  currentJsonKey: string;
  collection: string;
  prevSeq: number;
  observedTail: number;
  forceFold?: boolean;
}): Promise<void> => {
  const maint = getCurrentContext()?.maintenance;
  const dispatch = maint?.dispatch ?? dispatchInlineAwaited;
  // `await dispatch(...)`: `dispatchInlineAwaited` returns the task's
  // promise (awaited inline — deterministic for tests + correct for
  // serverful Node). A `ctx.waitUntil`-style dispatch returns void
  // (fire-and-forget off the ack); `await void` is a no-op. The
  // `.then(() => {}, () => {})` is belt-and-suspenders:
  // `runBoundedMaintenance` already swallows internally, but this
  // guarantees a dispatched task can NEVER reject the caller even if a
  // future change makes it throw.
  try {
    await dispatch(() =>
      runBoundedMaintenance(
        {
          storage: args.storage,
          currentJsonKey: args.currentJsonKey,
          prevSeq: args.prevSeq,
          // The in-memory observed tail keys the runner's Gate-1 ratio +
          // GC cadence off the true tail without an O(gap) re-probe (the
          // stored `tail_hint` is only a lower bound).
          observedTail: args.observedTail,
          // `disabled` disables fold/GC phases inside the runner but still
          // permits the bounded tail_hint refresh that prevents a
          // maintenance-off collection from drifting past the probe cap.
          ...(maint?.disabled === true && { disabled: true }),
          ...(maint?.maxFoldBytes !== undefined && { maxFoldBytes: maint.maxFoldBytes }),
          ...(args.forceFold === true && { forceFold: true }),
        },
        maint?.options,
      ).then(
        () => {},
        () => {},
      ),
    );
  } catch {
    // Dispatch is optional work. Its own failure must not surface: after
    // a commit it would make a durable mutation appear safely retriable,
    // and a refused write's refusal stands either way.
    ctxMetrics().counter("db.write.maintenance_dispatch_failed_total", 1, {
      collection: args.collection,
    });
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
 * locked four fields. The writer reads it at the post-commit dispatch
 * point via `getCurrentContext()?.maintenance`.
 *
 * Absent ⇒ inline dispatch + CF-free-safe caps (the defaults inside
 * {@link runBoundedMaintenance}), so a bare `Db.create(...)` maintains
 * out of the box once enough writes accrue.
 */
export interface MaintenanceDispatch {
  /** How to run the maintenance task. Default {@link dispatchInlineAwaited}. CF sets `ctx.waitUntil`. */
  readonly dispatch?: (task: () => Promise<void>) => void | Promise<void>;
  /** From `BAERLY_MAINTENANCE_DISABLE`: disables fold/GC phases while preserving tail_hint refresh. */
  readonly disabled?: boolean;
  /** `C` override, from `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`. */
  readonly maxFoldBytes?: number;
  /** Per-tier caps forwarded to {@link runBoundedMaintenance}. */
  readonly options?: BoundedMaintenanceOptions;
  /**
   * Structured warning sink for maintenance events — today only
   * `fold_deferred`, whose properties are the `collection` / `dimension`
   * / `gate` / `snapshot_*` / `ceiling_*` / `live_log_tail` /
   * `log_seq_start` fields an operator alerts on, plus the human-readable
   * `detail` line naming the remedy. Adapters bind it to LogTape's
   * `["baerly", "maintenance"]` category; the kernel never imports
   * LogTape, which keeps the observability subgraph out of the
   * `index.js` / `maintenance.js` bundles. Absent, or throwing ⇒ the
   * runner writes `detail` as a `console.warn` line instead; a throw is
   * contained and never skips the rest of the tick.
   */
  readonly warn?: (event: string, properties: Readonly<Record<string, unknown>>) => void;
}

/**
 * Parse the two host-agnostic ops-plane env vars into the
 * {@link MaintenanceDispatch} overrides. Shared by every host adapter so the
 * cross-host contract has one source of truth.
 *
 * `maxFoldBytes` (`C`) is the finite, positive
 * `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` or undefined. A non-numeric value
 * (`"8mb"`) is ignored and falls back to the active profile's default — a
 * typo there costs one deploy at the default ceiling. A value that parses
 * to zero or negative throws instead of falling back: `snapshot_bytes <= C`
 * would then be false forever, so the fold would defer on every tick and
 * the live tail would grow unbounded — a config typo reaching the same
 * stall shape as running past scale.
 *
 * `disabled` reads `BAERLY_MAINTENANCE_DISABLE` against a closed,
 * case-insensitive vocabulary: unset, `""`, `"0"`, `"false"` → `false`;
 * `"1"`, `"true"` → `true`; anything else throws. The prior truthy-if-
 * non-empty parsing silently disabled maintenance on `"no"` / `"off"` —
 * the two most natural ways an operator would try to spell "don't disable".
 *
 * @throws {BaerlyError} `InvalidConfig` for a non-positive
 * `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`, or a `BAERLY_MAINTENANCE_DISABLE`
 * value outside the closed vocabulary above.
 */
export const parseMaintenanceEnv = (
  readEnv: (key: string) => string | undefined,
): { maxFoldBytes?: number; disabled: boolean } => {
  const rawFoldBytes = readEnv("BAERLY_MAINTENANCE_MAX_FOLD_BYTES");
  let maxFoldBytes: number | undefined;
  if (rawFoldBytes !== undefined && rawFoldBytes !== "") {
    const parsedFoldBytes = Number(rawFoldBytes);
    if (Number.isFinite(parsedFoldBytes)) {
      if (parsedFoldBytes <= 0) {
        throw new BaerlyError(
          "InvalidConfig",
          `BAERLY_MAINTENANCE_MAX_FOLD_BYTES must be a positive number, got ${JSON.stringify(rawFoldBytes)}`,
        );
      }
      maxFoldBytes = parsedFoldBytes;
    }
    // Non-numeric (NaN): ignored, falls back to the profile default (Ruling 3).
  }

  const rawDisable = readEnv("BAERLY_MAINTENANCE_DISABLE");
  const normalizedDisable = rawDisable?.toLowerCase();
  let disabled: boolean;
  if (
    rawDisable === undefined ||
    normalizedDisable === "" ||
    normalizedDisable === "0" ||
    normalizedDisable === "false"
  ) {
    disabled = false;
  } else if (normalizedDisable === "1" || normalizedDisable === "true") {
    disabled = true;
  } else {
    throw new BaerlyError(
      "InvalidConfig",
      `BAERLY_MAINTENANCE_DISABLE must be one of "", "0", "false", "1", "true" (case-insensitive), got ${JSON.stringify(rawDisable)}`,
    );
  }

  return {
    ...(maxFoldBytes !== undefined && { maxFoldBytes }),
    disabled,
  };
};
