/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol/src/collection-api.ts`'s `Collection<T>` /
   `Query<T>` declarations); the snapshot body carries it through. */

/**
 * Compactor: fold a prefix of the live log into a content-
 * hashed snapshot file and CAS-advance `current.json` to swap the
 * pointer.
 *
 * The hard correctness requirement is **atomic snapshot generation**:
 * a compactor that crashes mid-write must not leave a corrupted body
 * that readers consume as truth. The design: every snapshot's filename
 * embeds the SHA-256 of its body. A crashed mid-PUT leaves a body that
 * doesn't match its own filename hash, and readers reject it as
 * "missing." The atomic moment is the CAS-swap of
 * `current.json.snapshot`, which is a single conditional PUT.
 *
 * Order of operations (matches `Writer.commit`'s manifest-first-
 * REVERSED ordering): PUT snapshot body → CAS-advance `current.json`.
 * A crash before the swap leaves an orphan snapshot file; the swap
 * succeeds iff our captured ETag still matches.
 *
 * Why level-prefixed chunked snapshots over the alternatives: a
 * single monolithic snapshot (every compaction rewrites one well-
 * known key) makes partial writes catastrophic and serializes every
 * writer on one key. WAL-checkpointing in the rqlite / Raft tradition
 * requires a consensus layer Baerly doesn't have. The Litestream-
 * style multi-level scheme — small fixed number of levels, chunked
 * files keyed by sequence range — keeps random GETs cheap on
 * S3-compatible storage and avoids LIST. Current ship is single-
 * level at L9 (one snapshot replaces the prior; no multi-level merge
 * yet); the key format is forward-compatible with future L0..L9
 * rolling merges without a wire change.
 *
 * @see ../../../docs/spec/sync-protocol.md
 */

import {
  type CurrentJson,
  type DocumentData,
  type MetricsRecorder,
  encodeJsonBytes,
  logSeqStartOf,
  BaerlyError,
  noopMetricsRecorder,
  readCurrentJson,
  snapshotHash,
  type Storage,
  type StoragePutOptions,
} from "@baerly/protocol";
import { walkLogRangeWithBytes } from "./log-walk.ts";
import { probeTailFrom } from "./log-tail.ts";
import { getCurrentContext } from "./observability/context.ts";
import {
  encodeSnapshotBody,
  loadSnapshotAsMap,
  type SnapshotBody,
  snapshotKey,
} from "./snapshot.ts";

const ctxMetrics = (): MetricsRecorder => getCurrentContext()?.recorder ?? noopMetricsRecorder;

/**
 * Public configuration knobs for {@link compact}. All optional; the
 * engine works unbounded by default. Opt into a per-run cap via the
 * `CLOUDFLARE_FREE_TIER` profile (from `./maintenance.ts`) or by
 * reaching for {@link InternalCompactOptions} via the
 * `@baerly/server/_internal/testing` subpath.
 */
export interface CompactOptions {
  /**
   * Minimum log-tail length to compact. Skips work when there are
   * fewer than this many live entries past the last snapshot.
   * Default 100.
   */
  readonly minEntriesToCompact?: number;

  /** Optional AbortSignal forwarded to every storage call. */
  readonly signal?: AbortSignal;
}

/**
 * Internal-only widening of {@link CompactOptions}. Surfaced via the
 * `@baerly/server/_internal/testing` subpath (NOT in the published
 * `publishConfig.exports`); production callers should use
 * {@link CompactOptions}.
 *
 * @internal
 */
export interface InternalCompactOptions extends CompactOptions {
  /**
   * @internal Budget cap for the CF free-tier subrequest budget;
   * `CLOUDFLARE_FREE_TIER` sets it. Tests also set it to exercise
   * the cap path. The compactor's I/O profile is
   * `maxEntriesPerRun + 3` subrequests (N GETs + 1 PUT snapshot +
   * 1 GET current + 1 PUT current). The default is effectively
   * unbounded (`Number.MAX_SAFE_INTEGER`).
   */
  readonly maxEntriesPerRun?: number;

  /**
   * @internal SNAPSHOT-axis byte ceiling. The rebuilt snapshot body
   * (NOT snapshot + tail) must be `<= ceilingBytes` or the fold is
   * DEFERRED before the PUT. `undefined ⇒ no ceiling` (`Infinity`).
   * The write-tick runner threads its pre-fold-projection `C` here as
   * a Node-side belt-and-suspenders; on a CPU-killable CF isolate the
   * kill lands during walk+encode (before this check), so the decisive
   * CF guard is the runner's pre-fold projection, not this.
   */
  readonly ceilingBytes?: number;

  /**
   * @internal SNAPSHOT-axis row ceiling. The rebuilt snapshot row count
   * (`base.size`, NOT including the tail) must be `<= ceilingEntries`
   * or the fold is DEFERRED before the PUT. `undefined ⇒ no ceiling`
   * (`Infinity`). Catches the tiny-doc case where bytes stay small but
   * row count balloons.
   */
  readonly ceilingEntries?: number;

  /**
   * @internal A fresh tail LOWER BOUND the caller already observed (the
   * write-tick runner threads the writer's in-memory `observedTail`,
   * `seq + 1`). When present it raises the ceiling-probe FLOOR to
   * `max(log_seq_start, tail_hint, knownTail)`, so on a stale-low stored
   * `tail_hint` the forward probe walks only "commits since this writer's
   * commit" instead of re-walking the whole gap from the stale hint
   * (which could blow the CF subrequest budget — B4). The compactor still
   * discovers the TRUE tail by probing UP from this floor (small gap).
   * Absent on the scheduled path ⇒ probe from `max(log_seq_start,
   * tail_hint)` as before.
   */
  readonly knownTail?: number;
}

export interface CompactResult {
  /** `true` iff a new snapshot landed and `current.json` was advanced. */
  readonly written: boolean;
  /** Reason `written === false`. */
  readonly skippedReason?: "below-min-threshold" | "current-json-missing" | "cas-lost" | "deferred";
  /** `true` on the over-ceiling rebuild-defer path (`skippedReason === "deferred"`). */
  readonly deferred?: boolean;
  /** Prior snapshot key (`null` if no prior snapshot existed). */
  readonly previousSnapshotKey: string | null;
  /** New snapshot key (`undefined` if `written === false` and no PUT happened). */
  readonly newSnapshotKey?: string;
  /** `log_seq_start` before the run. */
  readonly logSeqStartBefore: number;
  /** `log_seq_start` after the run. */
  readonly logSeqStartAfter: number;
  /** Number of log entries folded into the new snapshot. */
  readonly entriesFolded: number;
}

const DEFAULT_MAX_PER_RUN = Number.MAX_SAFE_INTEGER;
const DEFAULT_MIN_TO_COMPACT = 100;
const APPLICATION_JSON = "application/json";

/**
 * Fold a prefix of the live log into a new snapshot and CAS-advance
 * `current.json`. Idempotent: a second run with no new writes is a
 * no-op (below-min-threshold).
 *
 * Single-attempt: on CAS conflict we return
 * `{written: false, skippedReason: "cas-lost", newSnapshotKey}` — the
 * caller (the cron handler invoking `runScheduledMaintenance` from
 * `./maintenance.ts`) decides whether to schedule another run. The
 * orphan snapshot file just written will be swept by `runGc()`.
 *
 * @throws BaerlyError code="InvalidResponse" — `current.json` is
 *   present but malformed, or a snapshot body fails its schema /
 *   collection cross-check.
 * @throws BaerlyError code="Internal" — protocol-invariant violation:
 *   a log entry missing inside `[log_seq_start, foldEnd)`, or the
 *   prior-snapshot pointer resolves to no body / a body whose hash
 *   doesn't match its filename.
 *
 * @example
 * ```ts
 * import { compact } from "@gusto/baerly-storage";
 *
 * const res = await compact(
 *   { storage, currentJsonKey: "app/x/tenant/t/manifests/tickets/current.json" },
 *   { minEntriesToCompact: 100, maxEntriesPerRun: 40 },
 * );
 * if (res.written) console.log("snapshot landed at", res.newSnapshotKey);
 * ```
 */
export const compact = async (
  args: {
    storage: Storage;
    /** Full bucket-relative key of the CAS pointer. */
    currentJsonKey: string;
  },
  options: CompactOptions = {},
): Promise<CompactResult> => {
  const { storage, currentJsonKey } = args;
  // The internal cap fields ride on the same runtime object even
  // though the public `CompactOptions` doesn't surface them. The cast
  // is safe — the JS runtime carries every property regardless of TS
  // narrowing — and keeps the public type honest.
  const internal = options as InternalCompactOptions;
  const maxPerRun = internal.maxEntriesPerRun ?? DEFAULT_MAX_PER_RUN;
  const minToCompact = options.minEntriesToCompact ?? DEFAULT_MIN_TO_COMPACT;
  // Each ceiling: `undefined ⇒ no ceiling` (treated as `Infinity`).
  const ceilingBytes = internal.ceilingBytes ?? Number.POSITIVE_INFINITY;
  const ceilingEntries = internal.ceilingEntries ?? Number.POSITIVE_INFINITY;
  const collectionPrefix = currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"));
  const collectionName = collectionPrefix.slice(collectionPrefix.lastIndexOf("/") + 1);

  // ── Step 1. Read current.json fresh. ────────────────────────────
  const read = await readCurrentJson(
    storage,
    currentJsonKey,
    options.signal !== undefined ? { signal: options.signal } : undefined,
  );
  if (read === null) {
    return {
      written: false,
      skippedReason: "current-json-missing",
      previousSnapshotKey: null,
      logSeqStartBefore: 0,
      logSeqStartAfter: 0,
      entriesFolded: 0,
    };
  }
  const current = read.json;
  const baseEtag = read.etag;
  const logSeqStartBefore = logSeqStartOf(current);
  // Forward-probe the TRUE tail (uncapped) and stamp it as the new
  // `tail_hint` (Step 7). The writer never advances `tail_hint` under
  // single-write commit; the compactor is its sole durable advancer, so
  // it must discover the true tail to keep the writer's per-commit
  // tail-find cheap (a tracking hint ⇒ small gap). The compactor's O(gap)
  // probe is amortized O(1) per write across the fold cadence; it's
  // Class-A-active, not idle-reader-bound.
  // Raise the probe floor to any fresh tail lower bound the caller passed
  // (the write-tick `knownTail` = writer's observed `seq + 1`) so a
  // stale-low stored `tail_hint` doesn't force an O(gap) re-walk (B4).
  const probeFloor = Math.max(logSeqStartBefore, current.tail_hint, internal.knownTail ?? 0);
  const probe = await probeTailFrom(storage, collectionPrefix, probeFloor, {
    ...(options.signal !== undefined && { signal: options.signal }),
  });
  const discoveredTail = probe.tail;
  const nextSeq = discoveredTail;
  const available = nextSeq - logSeqStartBefore;
  if (available < minToCompact) {
    return {
      written: false,
      skippedReason: "below-min-threshold",
      previousSnapshotKey: current.snapshot,
      logSeqStartBefore,
      logSeqStartAfter: logSeqStartBefore,
      entriesFolded: 0,
    };
  }

  const foldEnd = Math.min(nextSeq, logSeqStartBefore + maxPerRun);

  // ── Step 2. Load the previous snapshot (if any) as the fold base.
  const base =
    current.snapshot === null
      ? new Map<string, DocumentData>()
      : await loadSnapshotAsMap(storage, current.snapshot, collectionName, options.signal);

  // ── Step 3. Parallel-fetch [logSeqStartBefore, foldEnd) entries. ──
  // Bytes-aware variant: we need BOTH the parsed entries (for the fold)
  // AND the exact STORED body byteLength per object (to decrement
  // `tail_bytes` by precisely what the writer accumulated).
  const fetched = await walkLogRangeWithBytes(
    storage,
    collectionPrefix,
    logSeqStartBefore,
    foldEnd,
    { signal: options.signal },
  );

  // Sum the STORED body bytes over ALL fetched objects in
  // `[logSeqStartBefore, foldEnd)` — NOT only the entries the fold loop
  // keeps. The writer counted EVERY committed entry's bytes into
  // `tail_bytes` (`encodeJsonBytes(entry).byteLength`, writer.ts Step
  // 6); the stored body IS those bytes, so this sum == the writer's
  // accumulated total for the slice → exact, no re-encode. The byte sum
  // is independent of the fold-apply filter below.
  const foldedSliceBytes = fetched.reduce((sum, f) => sum + f.bytes, 0);

  // ── Step 4. Apply the fold onto `base`. ─────────────────────────
  // I / U overwrite with the post-image (today's per-doc-replace
  // model: writer emits `entry.after` as the full post-image, see
  // packages/protocol/src/log.ts). D tombstones.
  for (const { entry } of fetched) {
    if (entry.collection !== collectionName) {
      continue;
    }
    if (entry.doc_id === undefined) {
      continue;
    }
    switch (entry.op) {
      case "I":
      case "U": {
        if (entry.after !== undefined) {
          base.set(entry.doc_id, entry.after);
        }
        break;
      }
      case "D": {
        // Tombstone purge: the `current.json` CAS serialises commits, so
        // there is no late partition that could resurrect this doc —
        // dropping it here IS the tombstone purge.
        base.delete(entry.doc_id);
        break;
      }
    }
  }

  // ── Step 5. Build the canonical snapshot body. ──────────────────
  // Sort by `_id` so the byte output is deterministic — same fold ⇒
  // same body ⇒ same hash ⇒ same filename. Idempotent re-runs.
  const sortedDocs = Array.from(base.entries())
    .toSorted(([a], [b]) => {
      if (a < b) {
        return -1;
      }
      if (a > b) {
        return 1;
      }
      return 0;
    })
    .map(([id, body]) => ({ _id: id, body }));
  const snapshotBody: SnapshotBody = {
    schema_version: 1,
    min_seq: 0,
    max_seq: foldEnd,
    collection: collectionName,
    docs: sortedDocs,
  };
  const bodyBytes = encodeSnapshotBody(snapshotBody);

  // ── Step 5b. SNAPSHOT-axis ceiling — check BEFORE the PUT. ───────
  // The ceiling is on the SNAPSHOT being rebuilt (`bodyBytes.byteLength`
  // / `base.size`), NOT snapshot + tail — the tail is bounded
  // separately by `maxEntriesPerRun`. This is a Node-side
  // belt-and-suspenders: on a CPU-killable CF isolate the kill lands
  // during the walk + encode above, BEFORE this check, so the decisive
  // CF guard is the runner's pre-fold projection (see maintenance.ts
  // `runBoundedMaintenance`). When over ceiling we DEFER: no PUT, no
  // CAS, no current.json mutation.
  if (bodyBytes.byteLength > ceilingBytes || base.size > ceilingEntries) {
    ctxMetrics().counter("db.compaction.deferred_total", 1, {
      collection: collectionName,
      dimension: bodyBytes.byteLength > ceilingBytes ? "bytes" : "rows",
    });
    return {
      written: false,
      skippedReason: "deferred",
      deferred: true,
      previousSnapshotKey: current.snapshot,
      logSeqStartBefore,
      logSeqStartAfter: logSeqStartBefore,
      entriesFolded: 0,
    };
  }

  const sha256 = await snapshotHash(bodyBytes);
  const newKey = snapshotKey(collectionPrefix, 0, foldEnd, sha256);

  // ── Step 6. PUT the snapshot. ───────────────────────────────────
  // No CAS guard — content-hash filenames make collisions impossible
  // for distinct bodies. If a concurrent compactor produced the same
  // body, this PUT is an idempotent overwrite of the same bytes.
  const putOpts: StoragePutOptions = {
    contentType: APPLICATION_JSON,
    ...(options.signal !== undefined && { signal: options.signal }),
  };
  await storage.put(newKey, bodyBytes, putOpts);

  // ── Step 7. CAS-advance current.json. ───────────────────────────
  const entriesFolded = foldEnd - logSeqStartBefore;
  const next: CurrentJson = {
    ...current,
    snapshot: newKey,
    log_seq_start: foldEnd,
    // Stamp the discovered tail back as the new lower bound (monotone:
    // never lower the stored hint). This makes the compactor the sole
    // durable `tail_hint` advancer ahead of the Phase-4 writer flip.
    tail_hint: Math.max(current.tail_hint, discoveredTail),
    snapshot_bytes: bodyBytes.byteLength,
    snapshot_rows: base.size,
    // tail_bytes is dead post-single-write-commit (writer no longer
    // increments); pinned 0 until Phase 6 drops the field. Decrementing
    // would drive it negative (no writer add) and trip assertCurrentJson.
    tail_bytes: 0,
    // Mean folded-entry byte size for live-tail estimation. Preserve a prior
    // mean on a zero-entry fold (no divide-by-zero, no clobber-with-0).
    mean_entry_bytes:
      entriesFolded > 0
        ? Math.round(foldedSliceBytes / entriesFolded)
        : (current.mean_entry_bytes ?? 0),
  };
  const nextBody = encodeJsonBytes(next);
  const casOpts: StoragePutOptions = {
    ifMatch: baseEtag,
    contentType: APPLICATION_JSON,
    ...(options.signal !== undefined && { signal: options.signal }),
  };
  try {
    await storage.put(currentJsonKey, nextBody, casOpts);
  } catch (error) {
    if (isCasConflict(error)) {
      // Another writer landed between our read and write. The
      // snapshot file we just wrote is now an orphan (correct
      // content, unreferenced) — `runGc()` will sweep it. Surface
      // cas-lost; the cron handler can rerun us next tick.
      //
      // Emit the cas-lost metric HERE so it covers ALL callers
      // (write-tick runner, runScheduledMaintenance, direct tests). A
      // lost fold is EXPECTED contention, not an error. (The runner
      // must NOT also emit it — that would double-count.)
      ctxMetrics().counter("db.compaction.cas_lost_total", 1, { collection: collectionName });
      return {
        written: false,
        skippedReason: "cas-lost",
        previousSnapshotKey: current.snapshot,
        newSnapshotKey: newKey,
        logSeqStartBefore,
        logSeqStartAfter: logSeqStartBefore,
        entriesFolded: foldEnd - logSeqStartBefore,
      };
    }
    throw error;
  }

  // ── Step 8. Emit metrics on a successful run. ───────────────────
  // `lag_window_depth` is the post-compaction live tail length —
  // entries still pending fold after this run. `entries_folded` is
  // the per-run histogram sample. Metrics are in-memory only; they
  // add zero storage ops.
  const metrics = ctxMetrics();
  metrics.histogram("db.compact.entries_folded", entriesFolded, { collection: collectionName });
  metrics.gauge("db.manifest.lag_window_depth", discoveredTail - foldEnd, {
    collection: collectionName,
  });

  return {
    written: true,
    previousSnapshotKey: current.snapshot,
    newSnapshotKey: newKey,
    logSeqStartBefore,
    logSeqStartAfter: foldEnd,
    entriesFolded,
  };
};

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

/**
 * `true` when an `If-Match` CAS guard lost. Every in-tree
 * {@link Storage} impl surfaces a lost CAS as
 * `BaerlyError{code:"Conflict"}`.
 */
const isCasConflict = (err: unknown): boolean =>
  err instanceof BaerlyError && err.code === "Conflict";
