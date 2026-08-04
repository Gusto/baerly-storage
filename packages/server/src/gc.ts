/**
 * GC mark + sweep.
 *
 * `runGc` is a single-pass garbage collector that:
 *   1. Reads `current.json` (and bootstraps `gc/pending.json` on first
 *      run).
 *   2. Marks new orphan candidates by LISTing the three artifact
 *      prefixes — log, snapshot, content — and classifying each key.
 *   3. Rescues candidates proven live, then sweeps due candidates that
 *      are safe to classify.
 *   4. CAS-writes the updated `gc/pending.json`.
 *
 * Two-phase by design: every candidate sits in `gc/pending.json` for a
 * grace period (default 7 days, see {@link GC_GRACE_PERIOD_MILLIS})
 * before it is deleted. The grace bounds the worst plausible
 * writer-retry window — a paused-process writer that resumes hours
 * later still finds its idempotency anchor on the bucket.
 *
 * Idempotent modulo the rotation cursors: same input bucket state ⇒
 * same candidate set and same DELETEs. The two `*_scan_cursor` fields
 * are position, not state, and advance on every pass by design.
 * Unbounded by default — the run marks and sweeps the entire eligible
 * set in one pass. Callers on the Cloudflare 50-subrequest free-tier
 * budget opt INTO caps via the `CLOUDFLARE_FREE_TIER` profile's
 * `gc.maxMarksPerRun` / `maxSweepsPerRun` knobs (`InternalRunGcOptions`,
 * not on the public `RunGcOptions`).
 *
 * **When a bounded pass needs a rotation cursor.** A budget-capped
 * LIST that always starts at the lexicographic beginning only makes
 * progress if deletion clears the front of its window. The test is:
 * *is the set of PERMANENTLY-undeletable keys under this prefix
 * unbounded, and lex-interleaved with the deletable set?* Both halves
 * matter. Unbounded, because a window can only be entirely undeletable
 * if at least `maxMarks` such keys cluster at its front — one of them
 * sorting first is not enough. Permanently, because a key that is
 * merely already-marked and awaiting grace blocks marking without
 * blocking progress. Where the test passes, a fixed first-`maxMarks`
 * window can be all-undeletable and the pass marks nothing, forever —
 * and no budget increase fixes it, because the failure is the window's
 * position, not its size.
 *
 * Two of the three categories below fail that test and carry a
 * persisted cursor (`gc/pending.json`); each bounded pass resumes
 * `startAfter` the prior pass's last EXAMINED key — examined, not
 * marked, so a window of live or already-pending keys still steps
 * forward — and wraps at end-of-keyspace, so the whole prefix is
 * covered over a rotation within the per-pass budget.
 *
 * Three categories of orphan:
 *   - `stale-log`: `<collectionPrefix>/log/<seq>.json` with
 *     `seq < log_seq_start`. After `compact()` folds these into a
 *     snapshot, they're unreferenced. **Cursored**
 *     (`log_scan_cursor`). `logObjectKey` builds UNPADDED decimal, so
 *     lex order is `0, 1, 10, 100…109, 11, …`: a numeric prefix is not
 *     a lexicographic prefix, and the permanently-undeletable live
 *     keys at/above the floor interleave with — and routinely precede
 *     — the stale ones. With `log_seq_start = 100` and keys `0..999`,
 *     the lex-first 20 are `0, 1, 10, 100–109, 11, 110–115`: four
 *     stale. Sweep those and the window is `100–119`, twenty live
 *     keys, zero marks, and seqs `2–9` + `12–99` are unreachable.
 *   - `orphan-snapshot`: a `<collectionPrefix>/snapshot/L<n>/...` key not
 *     equal to `current.snapshot`. Each compactor run replaces the
 *     pointer; the prior file becomes unreferenced. **Not cursored** —
 *     the one category the test above exempts, and the exemption rests
 *     on CARDINALITY, not ordering: exactly ONE key under `snapshot/`
 *     is permanently undeletable (the live `current.snapshot`), so for
 *     any `maxMarks >= 2` the window can never be all-undeletable
 *     however the keys sort. Ordering is a second, weaker argument —
 *     today `snapshotKey` zero-pads both seq fields to a fixed width
 *     and `compactor.ts` always passes `minSeq = 0`, so lex order
 *     equals numeric order and the live snapshot (highest `maxSeq`)
 *     sorts LAST. Don't lean on that one: `snapshot.ts` documents the
 *     `L<n>` level prefix as forward-compatible with L0..L8 rolling
 *     merges, and an L0 key would sort before the L9 live snapshot.
 *     The cardinality argument survives that; the ordering one does
 *     not.
 *   - `orphan-content`: `<collectionPrefix>/content/<sha>.json` whose
 *     32-hex truncated-SHA-256 hash is not in the live content-hash
 *     set (computed by hashing every live `entry.after` post-image —
 *     the same hash the writer's step 4 produces). Surfaces writer
 *     crashes between the content PUT and the log-entry PUT.
 *     **Cursored** (`content_scan_cursor`). Content keys are
 *     hash-named (random lex order) and live content is never deleted,
 *     so a first-`maxMarks` window can be all-live.
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
   * compute every candidate's `due_at`) and at sweep time (to
   * compare against candidate `due_at`).
   */
  readonly now?: () => Date;
}

/**
 * Why a pass skipped orphan-content discovery entirely.
 *
 * DEGRADED (never expected) — an artifact that should be readable was
 * not, so no complete live set can be built while the fault persists.
 * Orphan content accumulates for as long as it does:
 *   - `"live-log-unreadable"`: a log entry inside `[log_seq_start, tail)`
 *     was missing or would not decode.
 *   - `"snapshot-unreadable"`: reading or hash-verifying the current
 *     snapshot failed (a persistent `AccessDenied` or a corrupt body
 *     parks orphan-content GC here indefinitely).
 *
 * A reason names the ARTIFACT that could not be read, not the fault
 * class: a one-off transient storage error and a persistent
 * `AccessDenied` on the same object both report
 * `"snapshot-unreadable"`. So a single occurrence does NOT imply a fault
 * that fails to self-clear — a transient one clears on the next pass.
 * Consecutive passes reporting the same reason is the discriminator, and
 * the operator's signal to look at the named artifact; `admin fsck`
 * walks the same chain and surfaces the underlying error.
 */
export type ContentDeferralReason = "live-log-unreadable" | "snapshot-unreadable";

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
  /**
   * Set iff this pass skipped orphan-content discovery: no content was
   * marked, no pending content candidate was swept, and
   * `content_scan_cursor` was held so the next pass resumes in place.
   * `marked.stale_log` / `marked.orphan_snapshot` and their sweeps are
   * unaffected — only the content category defers.
   *
   * Absent means content classification ran on a complete live set. Also
   * emitted as `db.gc.content_deferred_total` (labelled by reason), but a
   * cron caller outside any HTTP scope sees no metrics — read this field
   * and log a reason (see {@link ContentDeferralReason}) that repeats
   * across passes.
   */
  readonly contentDeferredReason?: ContentDeferralReason;
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

  // ── Step 3. Mark stale log entries (seq < log_seq_start). ───────
  // A LEXICOGRAPHIC window of the whole `log/` prefix, filtered
  // NUMERICALLY. The two orders disagree — log keys are unpadded
  // decimal — so the floor is not a lex boundary and there is no
  // `endBefore` that would confine the scan to stale keys. Hence the
  // rotation cursor: same mechanism as the content scan below, same
  // advance-on-examined rule. See `log_scan_cursor`.
  const newCandidates: GcCandidate[] = [];
  let markedStaleLog = 0;
  let logExaminedThisPass = 0;
  let lastExaminedLogKey: string | undefined;
  if (logSeqStart > 0) {
    for await (const entry of storage.list(
      `${collectionPrefix}/log/`,
      listWindow(maxMarks, pending.json.log_scan_cursor, signal),
    )) {
      // Advance on EXAMINED, not marked — an all-live window (or one
      // full of already-pending keys) must still move forward.
      logExaminedThisPass++;
      lastExaminedLogKey = entry.key;
      const seq = parseSeqFromLogKey(entry.key);
      if (seq === null || seq >= logSeqStart) {
        continue;
      }
      if (known.has(entry.key)) {
        continue;
      }
      newCandidates.push({
        key: entry.key,
        due_at: computeDueAt(now, grace),
        reason: "stale-log",
      });
      markedStaleLog++;
    }
  }
  // Same wrap rule as the content scan. When the phase was SKIPPED
  // (`log_seq_start === 0`) this is `0 < maxMarks` ⇒ wrap, which is the
  // intended reading: with no floor the candidate set is empty, so we
  // trivially examined all of it and the next pass should start from
  // the beginning. The pass record has no third state for "phase did
  // not run", and inventing one would buy nothing — the floor is
  // monotonic, so a collection only passes through `0` before its
  // first fold, when there is no stale key to strand.
  const nextLogCursor = logExaminedThisPass < maxMarks ? undefined : lastExaminedLogKey;

  // ── Step 4. Mark orphan snapshots. ──────────────────────────────
  let markedOrphanSnapshot = 0;
  // Uncursored on purpose — `listWindow` with no cursor, so the window
  // is always the lexicographic first `maxMarks`. See the module JSDoc
  // for why this phase is the one exemption.
  for await (const entry of storage.list(
    `${collectionPrefix}/snapshot/`,
    listWindow(maxMarks, undefined, signal),
  )) {
    if (entry.key === current.snapshot) {
      continue;
    }
    if (known.has(entry.key)) {
      continue;
    }
    newCandidates.push({
      key: entry.key,
      due_at: computeDueAt(now, grace),
      reason: "orphan-snapshot",
    });
    markedOrphanSnapshot++;
  }

  // ── Step 5. Mark orphan content. ────────────────────────────────
  // Build the live content-hash set by hashing every live post-image:
  //   - log entries [log_seq_start, true tail)
  //   - snapshot rows (via `loadSnapshotAsMap` so the hash check
  //     defends against a tampered snapshot)
  // Hash with the same `versionFromContent` (32-hex truncated SHA-256)
  // the writer used to mint the content key.
  let markedOrphanContent = 0;
  let nextContentCursor: string | undefined;
  let preserveContentCursor = false;
  // Why content discovery deferred, for the result field and the metric.
  let contentDeferredReason: ContentDeferralReason | undefined;
  let completeLiveContentHashes: ReadonlySet<string> | undefined;
  const liveContent = await collectLiveContentHashes(
    storage,
    collectionPrefix,
    collectionName,
    current,
    logSeqStart,
    signal,
  );
  if (!liveContent.complete) {
    // A partial live set cannot prove ANY content key dead — the missing
    // post-images are exactly the ones that would look orphan. Defer the
    // whole category (cursor held, nothing marked, nothing swept) rather
    // than classify against an incomplete set.
    preserveContentCursor = true;
    contentDeferredReason = liveContent.incompleteReason;
  } else {
    completeLiveContentHashes = liveContent.hashes;
    const contentPass = await markOrphanContent({
      storage,
      collectionPrefix,
      liveHashes: liveContent.hashes,
      known,
      maxMarks,
      cursor: pending.json.content_scan_cursor,
      now,
      grace,
      signal,
    });
    newCandidates.push(...contentPass.candidates);
    markedOrphanContent = contentPass.candidates.length;
    nextContentCursor = contentPass.nextContentCursor;
  }

  // ── Step 6. Rescue live candidates, then sweep due candidates. ──
  // Eligible set = previously-pending entries PLUS this pass's freshly
  // marked entries. Including the new marks lets `runGc({graceMillis:0})`
  // mark-and-sweep in a single pass — useful for tests and for
  // grace-bypassing maintenance jobs. Order: pre-existing first
  // (they've been waiting longer), then new marks.
  const nowMs = now().getTime();
  const sweepCandidates: GcCandidate[] = [...pending.json.candidates, ...newCandidates];
  // Snapshot classification used the initial manifest so stale work remains
  // monotone and deterministic. Re-read only when a due snapshot could be
  // deleted, as late as possible before DELETE. The fresh pointer rescues a
  // candidate it names; every other due snapshot still needs a strict
  // generation-floor proof below before it may enter `toSweep`.
  const hasDueSnapshot = sweepCandidates.some(
    (candidate) => candidate.reason === "orphan-snapshot" && Date.parse(candidate.due_at) <= nowMs,
  );
  const freshCurrent = hasDueSnapshot
    ? await readCurrentJson(storage, currentJsonKey, signalOpts)
    : undefined;
  const rescuedKeys = new Set<string>();
  for (const candidate of sweepCandidates) {
    if (candidate.reason === "orphan-snapshot" && candidate.key === freshCurrent?.json.snapshot) {
      rescuedKeys.add(candidate.key);
      continue;
    }
    if (candidate.reason === "orphan-content" && completeLiveContentHashes !== undefined) {
      const hash = parseHashFromContentKey(candidate.key);
      if (hash !== null && completeLiveContentHashes.has(hash)) {
        rescuedKeys.add(candidate.key);
      }
    }
  }
  const toSweep: GcCandidate[] = [];
  const remaining: GcCandidate[] = [];
  for (const cand of sweepCandidates) {
    if (rescuedKeys.has(cand.key)) {
      continue;
    }
    // Without a complete live hash set, an orphan-content candidate cannot
    // be proven dead. Keep it pending while independent stale-log/snapshot
    // candidates continue through the same bounded sweep.
    if (cand.reason === "orphan-content" && completeLiveContentHashes === undefined) {
      remaining.push(cand);
    } else if (toSweep.length < maxSweeps && Date.parse(cand.due_at) <= nowMs) {
      if (cand.reason === "orphan-snapshot") {
        const maxSeq = parseMaxSeqFromCanonicalSnapshotKey(cand.key, collectionPrefix);
        // A compactor may publish this candidate after the fresh manifest GET
        // but before DELETE. The manifest floor is monotone, so only a
        // canonical snapshot wholly below that observed floor is already
        // obsolete in every later generation. Equality stays pending: the
        // internal zero-entry fold seam may publish `[floor, floor)`.
        if (maxSeq === null || maxSeq >= (freshCurrent?.json.log_seq_start ?? 0)) {
          remaining.push(cand);
          continue;
        }
      }
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
  // `mergeGcPending` drops terminal keys via its existing `sweptKeys`
  // merge input. Positively-live rescues are terminal ledger resolutions too,
  // but only `toSweep` drives DELETEs, result counts, timestamps, and metrics.
  const sweptKeys = new Set([...toSweep.map((candidate) => candidate.key), ...rescuedKeys]);
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
          nextLogCursor,
          ...(preserveContentCursor && { preserveContentCursor: true }),
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
  // Emitted only on a deferred pass, so a flat zero rate is the healthy
  // signal and any non-zero reason is the alertable one. Without this, a
  // pass that classified nothing because it COULDN'T is indistinguishable
  // from one that found no orphans.
  if (contentDeferredReason !== undefined) {
    metrics.counter("db.gc.content_deferred_total", 1, {
      collection: collectionName,
      reason: contentDeferredReason,
    });
  }

  return {
    marked: markedSummary,
    swept: toSweep.length,
    pendingDepth,
    ...(contentDeferredReason !== undefined && { contentDeferredReason }),
  };
};

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

/**
 * `Storage.list` options for one bounded rotation window: at most
 * `maxKeys` keys, resuming strictly after `cursor` when the ledger
 * carries one. `maxKeys` is a hard cross-page total on every adapter
 * (`docs/spec/storage-compatibility.md`), which is what makes
 * "yielded fewer than we asked for ⇒ end of keyspace" a sound wrap
 * test. `startAfter` is strict-greater on the key VALUE, so a cursor
 * naming a key this pass already deleted still resumes correctly —
 * never probe whether it still exists.
 */
const listWindow = (
  maxKeys: number,
  cursor: string | undefined,
  signal: AbortSignal | undefined,
): { startAfter?: string; maxKeys: number; signal?: AbortSignal } => ({
  maxKeys,
  ...(cursor !== undefined && { startAfter: cursor }),
  ...(signal !== undefined && { signal }),
});

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
 * Parse the exclusive `max_seq` from the exact key shape emitted by
 * `snapshotKey`. Unknown levels/layouts and invalid ranges stay opaque so GC
 * retains them rather than guessing at a generation boundary.
 */
const parseMaxSeqFromCanonicalSnapshotKey = (
  key: string,
  collectionPrefix: string,
): number | null => {
  const snapshotPrefix = `${collectionPrefix}/snapshot/L9/`;
  if (!key.startsWith(snapshotPrefix)) {
    return null;
  }
  const match = /^(\d{12})-(\d{12})-[0-9a-f]{64}\.json$/.exec(key.slice(snapshotPrefix.length));
  if (match === null) {
    return null;
  }
  const minSeq = Number(match[1]);
  const maxSeq = Number(match[2]);
  // Twelve decimal digits are always safely below MAX_SAFE_INTEGER.
  return minSeq <= maxSeq ? maxSeq : null;
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
 * Anchor `due_at` on the MARK: `now() + graceMs`. Grace measures the
 * writer-retry window from when we judged a key dead, which is
 * unrelated to when the object was written.
 *
 * Never anchor on the object's own timestamp. Doing so made the
 * effective grace `max(0, graceMs − object age)` — zero past the
 * 7-day default, for exactly the old objects GC marks. It read a
 * `lastModified` that only the S3/GCS/R2 adapters populated, so the
 * suite's backends showed a full window and no test could see it.
 * `StorageListEntry` no longer carries a timestamp; `gc.test.ts`
 * still pins the behaviour against an entry that fakes one.
 *
 * Called per candidate, not hoisted per pass, so the local-clock
 * backends keep their exact previous horizon.
 */
const computeDueAt = (now: () => Date, graceMs: number): string =>
  new Date(now().getTime() + graceMs).toISOString();

/**
 * One bounded rotation window over `content/`: LIST at most `maxMarks`
 * keys resuming after `cursor`, mark every key whose content hash is
 * absent from `liveHashes` and not already pending, and report where the
 * next pass resumes.
 *
 * `liveHashes` MUST be complete. A partial set marks live content as
 * orphan, and the grace period does not save it — a marked live key is
 * only rescued if a LATER pass builds a complete set before the due date.
 * `runGc` owns that gate; this helper trusts it.
 *
 * Rotation cursor: bounded passes (`maxMarks` < keyspace) sweep the whole
 * `content/` keyspace over a rotation instead of re-scanning the same
 * lexicographic-first window forever — content keys are hash-named
 * (random lex order) and live content is never deleted, so a fixed
 * first-`maxMarks` window can be all-live and never reach orphan content
 * past it. See `content_scan_cursor`.
 */
const markOrphanContent = async (opts: {
  readonly storage: Storage;
  readonly collectionPrefix: string;
  readonly liveHashes: ReadonlySet<string>;
  readonly known: ReadonlySet<string>;
  readonly maxMarks: number;
  readonly cursor: string | undefined;
  readonly now: () => Date;
  readonly grace: number;
  readonly signal: AbortSignal | undefined;
}): Promise<{
  readonly candidates: GcCandidate[];
  readonly nextContentCursor: string | undefined;
}> => {
  const candidates: GcCandidate[] = [];
  let examinedThisPass = 0;
  let lastExaminedKey: string | undefined;
  for await (const entry of opts.storage.list(
    `${opts.collectionPrefix}/content/`,
    listWindow(opts.maxMarks, opts.cursor, opts.signal),
  )) {
    // The cursor advances by EXAMINED keys (not marked), so an all-live
    // window still moves the window forward to fresh keys next pass.
    examinedThisPass++;
    lastExaminedKey = entry.key;
    const hash = parseHashFromContentKey(entry.key);
    if (hash === null || opts.liveHashes.has(hash)) {
      continue;
    }
    if (opts.known.has(entry.key)) {
      continue;
    }
    candidates.push({
      key: entry.key,
      due_at: computeDueAt(opts.now, opts.grace),
      reason: "orphan-content",
    });
  }
  // New cursor: if the LIST yielded FEWER than `maxKeys` keys it reached
  // the end of the keyspace ⇒ WRAP (next pass starts from the beginning,
  // cursor cleared). The unbounded reconcile path (maxMarks ≈
  // MAX_SAFE_INTEGER) always yields < maxKeys, so it always WRAPS — but it
  // does not necessarily scan the whole keyspace first. Bounded and
  // cursored are INDEPENDENT axes: `listWindow` applies `startAfter`
  // whenever the ledger carries a cursor, whatever `maxKeys` is, so an
  // unbounded pass that finds a cursor left by a bounded one covers only
  // cursor→end. Liveness-only and self-healing — that pass wraps, so the
  // next starts from the beginning and marks the remainder. Otherwise
  // carry the last examined key.
  const reachedEnd = examinedThisPass < opts.maxMarks;
  return { candidates, nextContentCursor: reachedEnd ? undefined : lastExaminedKey };
};

/**
 * Outcome of one live-content-set build — a discriminated union on
 * `complete`, so the two invariants are the compiler's to keep rather
 * than a runtime convention's:
 *
 *   - Only the `false` arm exists without a reason, so a deferral can
 *     never be silent. Independent `complete` + `incompleteReason?`
 *     fields would admit `{ complete: false }` with no reason, which
 *     holds the cursor and reports nothing — the exact silent deferral
 *     {@link ContentDeferralReason} exists to remove.
 *   - Only the `true` arm carries `hashes`, so a partial set is not
 *     merely unsafe to classify against, it is unreachable.
 */
type LiveContentScan =
  | { readonly complete: true; readonly hashes: ReadonlySet<string> }
  | { readonly complete: false; readonly incompleteReason: ContentDeferralReason };

/**
 * Build the live content-hash set. The set covers every live
 * post-image: every `entry.after` in `[logSeqStart, true tail)` plus
 * every row body in the current snapshot.
 *
 * Missing or malformed live entries and snapshot read failures yield the
 * incomplete arm, which carries a reason and no hashes — the caller
 * cannot reach a partial set to classify against.
 */
const collectLiveContentHashes = async (
  storage: Storage,
  collectionPrefix: string,
  collectionName: string,
  current: CurrentJson,
  logSeqStart: number,
  signal: AbortSignal | undefined,
): Promise<LiveContentScan> => {
  const hashes = new Set<string>();
  // First cause wins: the log walk runs before the snapshot read, and a
  // log fault is the earlier link in the same chain. Set ⇒ incomplete;
  // there is no separate `complete` flag to disagree with it.
  let incompleteReason: ContentDeferralReason | undefined;
  const markIncomplete = (reason: ContentDeferralReason): void => {
    incompleteReason ??= reason;
  };
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
      markIncomplete("live-log-unreadable");
      return;
    }
    let entry: { after?: unknown };
    try {
      entry = decodeJsonBytes<{ after?: unknown }>(got.body);
    } catch {
      markIncomplete("live-log-unreadable");
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
      // Swallowed deliberately: throwing here would abort the stale-log
      // and orphan-snapshot categories, which need no snapshot read. The
      // caller defers only content classification — but a persistent fault
      // (AccessDenied, corrupt body) parks that category indefinitely, so
      // the reason must reach the caller rather than die here.
      markIncomplete("snapshot-unreadable");
    }
  }

  return incompleteReason !== undefined
    ? { complete: false, incompleteReason }
    : { complete: true, hashes };
};
