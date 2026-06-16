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
 *   - `stale-log`: `<collectionPrefix>/log/<seq>.json` with
 *     `seq < log_seq_start`. After `compact()` folds these into a
 *     snapshot, they're unreferenced.
 *   - `orphan-snapshot`: a `<collectionPrefix>/snapshot/L<n>/...` key not
 *     equal to `current.snapshot`. Each compactor run replaces the
 *     pointer; the prior file becomes unreferenced.
 *   - `orphan-content`: `<collectionPrefix>/content/<sha>.json` whose
 *     32-hex truncated-SHA-256 hash is not in the live content-hash
 *     set (computed by hashing every live `entry.after` post-image —
 *     the same hash the writer's step 4 produces). Surfaces writer
 *     crashes between the content PUT and the log-entry PUT. Because
 *     content keys are hash-named (random lex order) and live content
 *     is never deleted, a bounded pass cannot rely on deletion to
 *     advance its LIST window the way `stale-log` does — so the
 *     orphan-content LIST carries a persisted rotation cursor
 *     (`content_scan_cursor` in `gc/pending.json`): each bounded pass
 *     resumes `startAfter` the prior pass's last examined key and wraps
 *     at end-of-keyspace, so the whole `content/` keyspace is swept
 *     over a rotation within the per-pass `maxMarksPerRun` budget.
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
  MAX_PARALLEL_LOG_READS,
  BaerlyError,
  casUpdateGcPending,
  createGcPending,
  decodeJsonBytes,
  encodeJsonBytes,
  logObjectKey,
  logSeqStartOf,
  mergeGcPending,
  noopMetricsRecorder,
  readCurrentJson,
  readGcPending,
  versionFromContent,
} from "@baerly/protocol";
import { loadSnapshotAsMap } from "./snapshot.ts";
import { probeTailFrom } from "./log-tail.ts";
import { getCurrentContext } from "./observability/context.ts";

const ctxMetrics = (): MetricsRecorder => getCurrentContext()?.recorder ?? noopMetricsRecorder;

/**
 * Public tunables for {@link runGc}. All optional; the engine works
 * unbounded by default. Opt into per-run caps via the
 * `CLOUDFLARE_FREE_TIER` profile (from `./maintenance.ts`) or by
 * reaching for {@link InternalRunGcOptions} via the
 * `@baerly/server/_internal/testing` subpath.
 */
export interface RunGcOptions {
  readonly signal?: AbortSignal;
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
 * import { runGc } from "@gusto/baerly-storage";
 *
 * const r = await runGc({ storage, currentJsonKey });
 * console.log(`marked ${r.marked.stale_log} stale logs, swept ${r.swept}`);
 * ```
 */
export const runGc = async (
  args: { storage: Storage; currentJsonKey: string },
  options: RunGcOptions = {},
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
  const collectionPrefix = currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"));
  const collectionName = collectionPrefix.slice(collectionPrefix.lastIndexOf("/") + 1);
  const gcPendingKey = `${collectionPrefix}/gc/pending.json`;
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
    } catch (error) {
      if (error instanceof BaerlyError && error.code === "Conflict") {
        pending = await readGcPending(storage, gcPendingKey, signalOpts);
        if (pending === null) {
          throw error;
        }
      } else {
        throw error;
      }
    }
  }

  // Set of keys already pending — don't re-mark.
  const known = new Set(pending.json.candidates.map((c) => c.key));

  // ── Step 3. Mark stale log entries [0, log_seq_start). ──────────
  const newCandidates: GcCandidate[] = [];
  let markedStaleLog = 0;
  if (logSeqStart > 0) {
    for await (const entry of listBounded(storage, `${collectionPrefix}/log/`, maxMarks, signal)) {
      if (markedStaleLog >= maxMarks) {
        break;
      }
      const seq = parseSeqFromLogKey(entry.key);
      if (seq === null || seq >= logSeqStart) {
        continue;
      }
      if (known.has(entry.key)) {
        continue;
      }
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
  for await (const entry of listBounded(
    storage,
    `${collectionPrefix}/snapshot/`,
    maxMarks,
    signal,
  )) {
    if (markedOrphanSnapshot >= maxMarks) {
      break;
    }
    if (entry.key === current.snapshot) {
      continue;
    }
    if (known.has(entry.key)) {
      continue;
    }
    newCandidates.push({
      key: entry.key,
      due_at: computeDueAt(entry, now, grace),
      reason: "orphan-snapshot",
    });
    markedOrphanSnapshot++;
  }

  // ── Step 5. Mark orphan content. ────────────────────────────────
  // Build the live content-hash set by hashing every live post-image:
  //   - log entries [log_seq_start, tail_hint)
  //   - snapshot rows (via `loadSnapshotAsMap` so the hash check
  //     defends against a tampered snapshot)
  // Hash with the same `versionFromContent` (32-hex truncated SHA-256)
  // the writer used to mint the content key.
  const liveHashes = await collectLiveContentHashes(
    storage,
    collectionPrefix,
    collectionName,
    current,
    logSeqStart,
    signal,
  );
  // Rotation cursor: resume the content LIST after the last key we
  // examined last pass. Bounded passes (`maxMarks` < keyspace) thus
  // sweep the whole `content/` keyspace over a rotation instead of
  // re-scanning the same lexicographic-first window forever — content
  // keys are hash-named (random lex order) and live content is never
  // deleted, so a fixed first-`maxMarks` window can be all-live and
  // never reach orphan content past it. See `content_scan_cursor`.
  const cursor = pending.json.content_scan_cursor;
  const contentPrefix = `${collectionPrefix}/content/`;
  let markedOrphanContent = 0;
  let examinedThisPass = 0;
  let lastExaminedKey: string | undefined;
  const listOpts: { startAfter?: string; maxKeys: number; signal?: AbortSignal } = {
    maxKeys: maxMarks,
    ...(cursor !== undefined && { startAfter: cursor }),
    ...(signal !== undefined && { signal }),
  };
  for await (const entry of storage.list(contentPrefix, listOpts)) {
    // The cursor advances by EXAMINED keys (not marked), so an
    // all-live window still moves the window forward to fresh keys
    // next pass.
    examinedThisPass++;
    lastExaminedKey = entry.key;
    const hash = parseHashFromContentKey(entry.key);
    if (hash === null || liveHashes.has(hash)) {
      continue;
    }
    if (known.has(entry.key)) {
      continue;
    }
    newCandidates.push({
      key: entry.key,
      due_at: computeDueAt(entry, now, grace),
      reason: "orphan-content",
    });
    markedOrphanContent++;
  }
  // New cursor: if the LIST yielded FEWER than `maxKeys` keys it
  // reached the end of the keyspace ⇒ WRAP (next pass starts from the
  // beginning, cursor cleared). The unbounded reconcile path
  // (maxMarks ≈ MAX_SAFE_INTEGER) always yields < maxKeys, so it lists
  // the whole keyspace in one pass, marks every orphan, and wraps —
  // behavior unchanged. Otherwise carry the last examined key.
  const reachedEnd = examinedThisPass < maxMarks;
  const nextContentCursor = reachedEnd ? undefined : lastExaminedKey;

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
  // MERGE this pass's results INTO the latest stored value rather than
  // overwriting with a precomputed set: `casUpdateGcPending` re-reads
  // `latest` and hands it to `mergeGcPending`, so a concurrent pass's
  // candidates (marked between our read and our write) survive. Writing
  // a precomputed `merged` would silently overwrite them — the If-Match
  // would succeed (fresh etag), so NO conflict is raised and the marks
  // are lost. The mutator is pure + the DELETEs are idempotent + already
  // performed, so the helper safely retries the merge on conflict.
  const sweptKeys = new Set(toSweep.map((c) => c.key));
  // `""` when this pass swept nothing — sourcing the no-sweep truth from
  // `latest` (via the merge's "take later" rule) rather than our stale
  // read. With no contention this is observably identical: `latest`
  // equals our read, so the later-of-the-two is the same value.
  const lastSweptAt = toSweep.length > 0 ? now().toISOString() : "";
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
      (latest) =>
        mergeGcPending(latest, {
          sweptKeys,
          newCandidates,
          lastSweptAt,
          nextContentCursor,
          maxCandidates: GC_MAX_PENDING_CANDIDATES,
        }),
      signalOpts,
    );
    pendingDepth = updated.json.candidates.length;
  } catch (error) {
    // CAS-lost on pending.json after exhausting the bounded retry:
    // another GC pass kept landing concurrently. The DELETEs we issued
    // are durable; the next pass picks up any marks we couldn't persist.
    // Surface success — re-throwing here would mask the work we DID
    // complete.
    if (error instanceof BaerlyError && error.code === "Conflict") {
      // Best-effort: we know `remaining.length` is at least the
      // post-sweep depth; concurrent passes may have moved it.
      pendingDepth = remaining.length;
    } else {
      throw error;
    }
  }

  // ── Step 8. Emit metrics. ───────────────────────────────────────
  // In-memory only — zero storage ops. Emit regardless of CAS-lost
  // (the operator wants visibility into best-effort runs too).
  const labels = { collection: collectionName };
  const metrics = ctxMetrics();
  metrics.gauge("db.orphan.candidate_count", pendingDepth, labels);
  metrics.gauge("db.gc.entries_swept_per_second", toSweep.length, labels);
  if (toSweep.length > 0) {
    const byReason = new Map<GcCandidate["reason"], number>();
    for (const c of toSweep) {
      byReason.set(c.reason, (byReason.get(c.reason) ?? 0) + 1);
    }
    for (const [reason, count] of byReason) {
      metrics.counter("db.gc.swept_total", count, { collection: collectionName, reason });
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
    if (yielded >= cap) {
      return;
    }
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
  if (match === null) {
    return null;
  }
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
 * post-image: every `entry.after` in `[logSeqStart, tail_hint)` plus
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
  collectionPrefix: string,
  collectionName: string,
  current: CurrentJson,
  logSeqStart: number,
  signal: AbortSignal | undefined,
): Promise<Set<string>> => {
  const hashes = new Set<string>();
  const getOpts = signal !== undefined ? { signal } : undefined;

  // Live log tail, bounded to the TRUE tail (probe past a stale-low
  // hint) so GC never treats a committed post-image as dead. Floor the
  // probe at `max(log_seq_start, tail_hint)` — entries below
  // `log_seq_start` are folded and never scanned by the loop below. The
  // loop 404-tolerates misses, so over-bounding to `tail` is safe.
  const { tail } = await probeTailFrom(
    storage,
    collectionPrefix,
    Math.max(logSeqStart, current.tail_hint),
    { signal },
  );
  // Read every live entry in `[logSeqStart, tail)`, but cap the
  // simultaneous in-flight log GETs at MAX_PARALLEL_LOG_READS. A raw
  // `Promise.all` over the whole range fans out up to
  // LOG_FORWARD_PROBE_CAP (100_000) concurrent GETs when a backlogged
  // tail makes the range large — which blows the Cloudflare Workers
  // ~50-concurrent-subrequest cap. The walk is COMPLETE (every seq is
  // visited): this is a concurrency bound, never a partial scan. Unlike
  // the shared `walkLogRange` helper, this scan is 404-tolerant (a
  // missing `log/<seq>` past a stale-low hint is skipped, not fatal)
  // and tolerant of a malformed entry, so it keeps its own bounded loop
  // rather than borrowing the throwing walker.
  const ingestLogEntry = async (s: number): Promise<void> => {
    const got = await storage.get(logObjectKey(collectionPrefix, s), getOpts);
    if (got === null) {
      return;
    }
    let entry: { after?: unknown };
    try {
      entry = decodeJsonBytes<{ after?: unknown }>(got.body);
    } catch {
      // A malformed log entry is the writer's concern, not GC's.
      // Skip and let other invariants catch it.
      return;
    }
    if (entry.after === undefined) {
      return;
    }
    const bodyBytes = encodeJsonBytes(entry.after);
    hashes.add(await versionFromContent(bodyBytes));
  };
  for (let chunkStart = logSeqStart; chunkStart < tail; chunkStart += MAX_PARALLEL_LOG_READS) {
    signal?.throwIfAborted();
    const chunkEnd = Math.min(chunkStart + MAX_PARALLEL_LOG_READS, tail);
    const chunk: Array<Promise<void>> = [];
    for (let s = chunkStart; s < chunkEnd; s++) {
      chunk.push(ingestLogEntry(s));
    }
    await Promise.all(chunk);
  }

  // Snapshot rows.
  if (current.snapshot !== null) {
    try {
      const map = await loadSnapshotAsMap(storage, current.snapshot, collectionName, signal);
      const rowReads: Array<Promise<void>> = [];
      for (const body of map.values()) {
        rowReads.push(
          (async (): Promise<void> => {
            const bytes = encodeJsonBytes(body);
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
