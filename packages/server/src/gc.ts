/**
 * GC mark + sweep.
 *
 * `runGc` is a single-pass garbage collector that:
 *   1. Reads `current.json` (and bootstraps `gc/pending.json` on first
 *      run).
 *   2. Marks new orphan candidates by LISTing the three artifact
 *      prefixes — log, snapshot, content — and classifying each key.
 *   3. Sweeps any already-pending candidate whose `due_at` has passed.
 *   4. CAS-writes the updated `gc/pending.json`.
 *
 * Two-phase by design: every candidate sits in `gc/pending.json` for a
 * grace period (default 7 days, see {@link GC_GRACE_PERIOD_MILLIS})
 * before it is deleted. The grace bounds the worst plausible
 * writer-retry window — a paused-process writer that resumes hours
 * later still finds its idempotency anchor on the bucket.
 *
 * Idempotent: same input bucket state ⇒ same `pending.json` output.
 * Unbounded by default — the run marks and sweeps the entire eligible
 * set in one pass. Callers on the Cloudflare 50-subrequest free-tier
 * budget opt INTO caps via the `CLOUDFLARE_FREE_TIER` profile's
 * `gc.maxMarksPerRun` / `maxSweepsPerRun` knobs (`InternalRunGcOptions`,
 * not on the public `RunGcOptions`).
 *
 * Three categories of orphan:
 *   - `stale-log`: `<tablePrefix>/log/<seq>.json` with
 *     `seq < log_seq_start`. After `compact()` folds these into a
 *     snapshot, they're unreferenced.
 *   - `orphan-snapshot`: a `<tablePrefix>/snapshot/L<n>/...` key not
 *     equal to `current.snapshot`. Each compactor run replaces the
 *     pointer; the prior file becomes unreferenced.
 *   - `orphan-content`: `<tablePrefix>/content/<sha>.json` whose
 *     32-hex truncated-SHA-256 hash is not in the live content-hash
 *     set (computed by hashing every live `entry.new` post-image —
 *     the same hash the writer's step 4 produces). Surfaces writer
 *     crashes between the content PUT and the log-entry PUT.
 *
 * CAS-lost on `gc/pending.json` is non-fatal: the DELETEs already
 * issued are durable, so we return a successful result and the next
 * pass will pick up any work this pass lost.
 */

import {
  type CurrentJson,
  type GcCandidate,
  type GcPending,
  type MetricsRecorder,
  type Storage,
  type StorageListEntry,
  GC_GRACE_PERIOD_MILLIS,
  GC_MAX_PENDING_CANDIDATES,
  GC_PENDING_SCHEMA_VERSION,
  BaerlyError,
  casUpdateGcPending,
  createGcPending,
  logSeqStartOf,
  noopMetricsRecorder,
  readCurrentJson,
  readGcPending,
  teeMetricsRecorders,
  versionFromContent,
} from "@baerly/protocol";
import { loadSnapshotAsMap } from "./compactor.ts";
import { withObservability } from "./observability/index.ts";

/**
 * Public tunables for {@link runGc}. All optional; the engine works
 * unbounded by default. Opt into per-run caps via the
 * `CLOUDFLARE_FREE_TIER` profile (from `./maintenance.ts`) or by
 * reaching for {@link InternalRunGcOptions} via the
 * `@baerly/server/_internal/testing` subpath.
 */
export interface RunGcOptions {
  readonly signal?: AbortSignal;

  /**
   * Optional metrics sink. Defaults to {@link noopMetricsRecorder}.
   * After every pass (including the CAS-lost arm) emits:
   *   - `db.orphan.candidate_count` gauge (post-pass `pendingDepth`).
   *   - `db.gc.entries_swept_per_second` gauge (sweep count this
   *     pass; downstream aggregation rate-converts).
   *   - `db.gc.swept_total` counter, labelled by `reason` (one
   *     emission per non-zero reason group).
   */
  readonly metrics?: MetricsRecorder;
}

/**
 * Internal-only widening of {@link RunGcOptions}. Surfaced via the
 * `@baerly/server/_internal/testing` subpath (NOT in the published
 * `publishConfig.exports`); production callers should use
 * {@link RunGcOptions}.
 *
 * @internal
 */
export interface InternalRunGcOptions extends RunGcOptions {
  /**
   * @internal Override grace-period for tests. Defaults to
   * {@link GC_GRACE_PERIOD_MILLIS} (7 days). Tests use `0` to bypass
   * the grace and exercise the sweep path in one pass.
   */
  readonly graceMillis?: number;

  /**
   * @internal Budget cap on candidates marked per category per run.
   * `CLOUDFLARE_FREE_TIER` sets it; bounds LIST + classification
   * cost per pass. The default is effectively unbounded
   * (`Number.MAX_SAFE_INTEGER`).
   */
  readonly maxMarksPerRun?: number;

  /**
   * @internal Budget cap on keys deleted per run.
   * `CLOUDFLARE_FREE_TIER` sets it — CF free-tier safe when paired
   * with `compact()` in the same scheduled handler. The default is
   * effectively unbounded (`Number.MAX_SAFE_INTEGER`).
   */
  readonly maxSweepsPerRun?: number;

  /**
   * @internal Clock injection for tests. Defaults to
   * `() => new Date()`. The function is invoked at mark time (to
   * compute `due_at` when `lastModified` is absent) and at sweep
   * time (to compare against candidate `due_at`).
   */
  readonly now?: () => Date;
}

/**
 * Return shape of {@link runGc}.
 */
export interface RunGcResult {
  /** Per-category counts of newly-marked candidates in this pass. */
  readonly marked: {
    readonly stale_log: number;
    readonly orphan_snapshot: number;
    readonly orphan_content: number;
  };
  /** Number of keys deleted in this pass. */
  readonly swept: number;
  /**
   * Depth of `gc/pending.json` after this pass. Drives the
   * `db.orphan.candidate_count` metric. Best-effort on `cas-lost` —
   * see module JSDoc.
   */
  readonly pendingDepth: number;
}

const DEFAULT_MAX_MARKS = Number.MAX_SAFE_INTEGER;
const DEFAULT_MAX_SWEEPS = Number.MAX_SAFE_INTEGER;

/**
 * Single GC pass — mark new orphans, sweep due-elapsed candidates,
 * persist via CAS-update on `gc/pending.json`.
 *
 * Returns immediately if `current.json` is missing — there's nothing
 * to do until a writer has bootstrapped the collection.
 *
 * @example
 * ```ts
 * import { runGc } from "baerly-storage";
 *
 * const r = await runGc({ storage, currentJsonKey });
 * console.log(`marked ${r.marked.stale_log} stale logs, swept ${r.swept}`);
 * ```
 */
export const runGc = (
  args: { storage: Storage; currentJsonKey: string },
  options: RunGcOptions = {},
): Promise<RunGcResult> =>
  withObservability("gc", (_ctx, recorder) => runGcInner(args, options, recorder));

const runGcInner = async (
  args: { storage: Storage; currentJsonKey: string },
  options: RunGcOptions,
  obsRecorder: MetricsRecorder,
): Promise<RunGcResult> => {
  const { storage, currentJsonKey } = args;
  // The internal seam fields (caps + clock + grace) ride on the same
  // runtime object even though the public `RunGcOptions` doesn't
  // surface them. Safe cast — the JS runtime carries every property.
  const internal = options as InternalRunGcOptions;
  const grace = internal.graceMillis ?? GC_GRACE_PERIOD_MILLIS;
  const maxMarks = internal.maxMarksPerRun ?? DEFAULT_MAX_MARKS;
  const maxSweeps = internal.maxSweepsPerRun ?? DEFAULT_MAX_SWEEPS;
  const now = internal.now ?? ((): Date => new Date());
  // Tee per-run observability recorder onto the operator's sink (see
  // `compactor.ts`'s identical pattern for rationale).
  const metrics = teeMetricsRecorders(options.metrics ?? noopMetricsRecorder, obsRecorder);
  const tablePrefix = currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"));
  const tableName = tablePrefix.slice(tablePrefix.lastIndexOf("/") + 1);
  const gcPendingKey = `${tablePrefix}/gc/pending.json`;
  const signal = options.signal;
  const signalOpts = signal !== undefined ? { signal } : undefined;

  // ── Step 1. Read current.json (skip silently if absent). ────────
  const cur = await readCurrentJson(storage, currentJsonKey, signalOpts);
  if (cur === null) {
    return {
      marked: { stale_log: 0, orphan_snapshot: 0, orphan_content: 0 },
      swept: 0,
      pendingDepth: 0,
    };
  }
  const current = cur.json;
  const logSeqStart = logSeqStartOf(current);

  // ── Step 2. Read or create gc/pending.json. ─────────────────────
  // Race-tolerant create: a concurrent pass may have bootstrapped
  // between our read and our create. Re-read on Conflict.
  let pending = await readGcPending(storage, gcPendingKey, signalOpts);
  if (pending === null) {
    const initial: GcPending = {
      schema_version: GC_PENDING_SCHEMA_VERSION,
      candidates: [],
      last_swept_at: "",
    };
    try {
      pending = await createGcPending(storage, gcPendingKey, initial, signalOpts);
    } catch (err) {
      if (err instanceof BaerlyError && err.code === "Conflict") {
        pending = await readGcPending(storage, gcPendingKey, signalOpts);
        if (pending === null) throw err;
      } else {
        throw err;
      }
    }
  }

  // Set of keys already pending — don't re-mark.
  const known = new Set(pending.json.candidates.map((c) => c.key));

  // ── Step 3. Mark stale log entries [0, log_seq_start). ──────────
  const newCandidates: GcCandidate[] = [];
  let markedStaleLog = 0;
  if (logSeqStart > 0) {
    for await (const entry of listBounded(storage, `${tablePrefix}/log/`, maxMarks, signal)) {
      if (markedStaleLog >= maxMarks) break;
      const seq = parseSeqFromLogKey(entry.key);
      if (seq === null || seq >= logSeqStart) continue;
      if (known.has(entry.key)) continue;
      newCandidates.push({
        key: entry.key,
        due_at: computeDueAt(entry, now, grace),
        reason: "stale-log",
      });
      markedStaleLog++;
    }
  }

  // ── Step 4. Mark orphan snapshots. ──────────────────────────────
  let markedOrphanSnapshot = 0;
  for await (const entry of listBounded(storage, `${tablePrefix}/snapshot/`, maxMarks, signal)) {
    if (markedOrphanSnapshot >= maxMarks) break;
    if (entry.key === current.snapshot) continue;
    if (known.has(entry.key)) continue;
    newCandidates.push({
      key: entry.key,
      due_at: computeDueAt(entry, now, grace),
      reason: "orphan-snapshot",
    });
    markedOrphanSnapshot++;
  }

  // ── Step 5. Mark orphan content. ────────────────────────────────
  // Build the live content-hash set by hashing every live post-image:
  //   - log entries [log_seq_start, next_seq)
  //   - snapshot rows (via `loadSnapshotAsMap` so the hash check
  //     defends against a tampered snapshot)
  // Hash with the same `versionFromContent` (32-hex truncated SHA-256)
  // the writer used to mint the content key.
  const liveHashes = await collectLiveContentHashes(
    storage,
    tablePrefix,
    tableName,
    current,
    logSeqStart,
    signal,
  );
  let markedOrphanContent = 0;
  for await (const entry of listBounded(storage, `${tablePrefix}/content/`, maxMarks, signal)) {
    if (markedOrphanContent >= maxMarks) break;
    const hash = parseHashFromContentKey(entry.key);
    if (hash === null || liveHashes.has(hash)) continue;
    if (known.has(entry.key)) continue;
    newCandidates.push({
      key: entry.key,
      due_at: computeDueAt(entry, now, grace),
      reason: "orphan-content",
    });
    markedOrphanContent++;
  }

  // ── Step 6. Sweep candidates whose due_at is in the past. ───────
  // Eligible set = previously-pending entries PLUS this pass's freshly
  // marked entries. Including the new marks lets `runGc({graceMillis:0})`
  // mark-and-sweep in a single pass — useful for tests and for
  // grace-bypassing maintenance jobs. Order: pre-existing first
  // (they've been waiting longer), then new marks.
  const nowMs = now().getTime();
  const sweepCandidates: GcCandidate[] = [...pending.json.candidates, ...newCandidates];
  const toSweep: GcCandidate[] = [];
  const remaining: GcCandidate[] = [];
  for (const cand of sweepCandidates) {
    if (toSweep.length < maxSweeps && Date.parse(cand.due_at) <= nowMs) {
      toSweep.push(cand);
    } else {
      remaining.push(cand);
    }
  }
  // Idempotent DELETE on every in-tree Storage impl — a 404 is a
  // no-op. Parallel via Promise.all; one failure aborts the rest,
  // but the per-key DELETEs that landed are durable.
  await Promise.all(toSweep.map((c) => storage.delete(c.key, signalOpts)));

  // ── Step 7. CAS-write pending.json. ─────────────────────────────
  // Un-swept candidates (pre-existing un-due + new un-due) form the
  // post-pass ledger. Bounded by GC_MAX_PENDING_CANDIDATES.
  const merged: GcCandidate[] = remaining.slice(0, GC_MAX_PENDING_CANDIDATES);
  const lastSweptAt = toSweep.length > 0 ? now().toISOString() : pending.json.last_swept_at;
  const markedSummary = {
    stale_log: markedStaleLog,
    orphan_snapshot: markedOrphanSnapshot,
    orphan_content: markedOrphanContent,
  };
  let pendingDepth: number;
  try {
    const updated = await casUpdateGcPending(
      storage,
      gcPendingKey,
      () => ({
        schema_version: GC_PENDING_SCHEMA_VERSION,
        candidates: merged,
        last_swept_at: lastSweptAt,
      }),
      signalOpts,
    );
    pendingDepth = updated.json.candidates.length;
  } catch (err) {
    // CAS-lost on pending.json: another GC pass landed concurrently.
    // The DELETEs we issued are durable; the next pass picks up any
    // marks we couldn't persist. Surface success — re-throwing here
    // would mask the work we DID complete.
    if (err instanceof BaerlyError && err.code === "Conflict") {
      // Best-effort: we know `remaining.length` is at least the
      // post-sweep depth; concurrent passes may have moved it.
      pendingDepth = remaining.length;
    } else {
      throw err;
    }
  }

  // ── Step 8. Emit metrics. ───────────────────────────────────────
  // In-memory only — zero storage ops. Emit regardless of CAS-lost
  // (the operator wants visibility into best-effort runs too).
  const labels = { collection: tableName };
  metrics.gauge("db.orphan.candidate_count", pendingDepth, labels);
  metrics.gauge("db.gc.entries_swept_per_second", toSweep.length, labels);
  if (toSweep.length > 0) {
    const byReason = new Map<GcCandidate["reason"], number>();
    for (const c of toSweep) {
      byReason.set(c.reason, (byReason.get(c.reason) ?? 0) + 1);
    }
    for (const [reason, count] of byReason) {
      metrics.counter("db.gc.swept_total", count, { collection: tableName, reason });
    }
  }

  return {
    marked: markedSummary,
    swept: toSweep.length,
    pendingDepth,
  };
};

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

/**
 * `Storage.list` with a hard ceiling — bounds the I/O cost of a
 * single pass when a runaway prefix has accumulated many keys.
 */
const listBounded = async function* (
  storage: Storage,
  prefix: string,
  cap: number,
  signal: AbortSignal | undefined,
): AsyncGenerator<StorageListEntry> {
  let yielded = 0;
  const opts = signal !== undefined ? { signal } : undefined;
  for await (const entry of storage.list(prefix, opts)) {
    if (yielded >= cap) return;
    yield entry;
    yielded++;
  }
};

/**
 * Parse `<...>/log/<seq>.json` and return `seq`. Returns `null` on
 * any shape that doesn't look like a log entry key — defensively
 * tolerates an unrelated key under the log prefix.
 */
const parseSeqFromLogKey = (key: string): number | null => {
  const match = /\/log\/(\d+)\.json$/.exec(key);
  if (match === null) return null;
  const n = Number.parseInt(match[1]!, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Parse `<...>/content/<sha-32>.json` and return the 32-hex hash.
 * Returns `null` on any shape that doesn't match the writer's
 * `versionFromContent`-produced key format.
 */
const parseHashFromContentKey = (key: string): string | null => {
  const match = /\/content\/([0-9a-f]{32})\.json$/.exec(key);
  return match === null ? null : match[1]!;
};

/**
 * Anchor `due_at` to `lastModified` when the storage adapter
 * surfaces it; fall back to the injected `now` so a Storage impl
 * without a server clock still GCs after `grace` from the mark
 * moment.
 */
const computeDueAt = (entry: StorageListEntry, now: () => Date, graceMs: number): string => {
  const base = entry.lastModified ?? now();
  return new Date(base.getTime() + graceMs).toISOString();
};

/**
 * Build the live content-hash set. The set covers every live
 * post-image: every `entry.new` in `[logSeqStart, next_seq)` plus
 * every row body in the current snapshot.
 *
 * A snapshot read that throws (corrupt body, hash mismatch) is
 * tolerated — the worst-case effect is missing some live hashes,
 * which could mark a live content blob as orphan. The grace period
 * absorbs the false-positive: a retry that re-PUTs the same hash
 * recreates the key before the sweep deletes it.
 */
const collectLiveContentHashes = async (
  storage: Storage,
  tablePrefix: string,
  tableName: string,
  current: CurrentJson,
  logSeqStart: number,
  signal: AbortSignal | undefined,
): Promise<Set<string>> => {
  const hashes = new Set<string>();
  const getOpts = signal !== undefined ? { signal } : undefined;

  // Live log tail.
  const logReads: Array<Promise<void>> = [];
  for (let s = logSeqStart; s < current.next_seq; s++) {
    logReads.push(
      (async (): Promise<void> => {
        const got = await storage.get(`${tablePrefix}/log/${s}.json`, getOpts);
        if (got === null) return;
        let entry: { new?: unknown };
        try {
          entry = JSON.parse(new TextDecoder().decode(got.body)) as { new?: unknown };
        } catch {
          // A malformed log entry is the writer's concern, not GC's.
          // Skip and let other invariants catch it.
          return;
        }
        if (entry.new === undefined) return;
        const bodyBytes = new TextEncoder().encode(JSON.stringify(entry.new));
        hashes.add(await versionFromContent(bodyBytes));
      })(),
    );
  }
  await Promise.all(logReads);

  // Snapshot rows.
  if (current.snapshot !== null) {
    try {
      const map = await loadSnapshotAsMap(storage, current.snapshot, tableName, signal);
      const rowReads: Array<Promise<void>> = [];
      for (const body of map.values()) {
        rowReads.push(
          (async (): Promise<void> => {
            const bytes = new TextEncoder().encode(JSON.stringify(body));
            hashes.add(await versionFromContent(bytes));
          })(),
        );
      }
      await Promise.all(rowReads);
    } catch {
      // Snapshot read failure is non-fatal — see the docstring.
    }
  }

  return hashes;
};
