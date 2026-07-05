/**
 * Shared log-walk primitives consumed by the read path (`query.ts`),
 * the compactor (`compactor.ts`), and the optional integrity walk in
 * `Writer.#singleAttemptCommit` (`writer.ts`).
 *
 * Two operations: read one log entry, or walk a contiguous range of
 * log entries with bounded parallelism. Each kernel call site
 * previously inlined the same range-build + unbounded `Promise.all`
 * pattern; on a free-tier collection where the compactor lags the
 * tail to 50-100 entries, that fans out 50-100 concurrent GETs per
 * call — and a contended writer multiplies that by the CAS retry
 * budget. `walkLogRange` caps concurrency at
 * {@link MAX_PARALLEL_LOG_READS} so a single call costs at most that
 * many simultaneous GETs against the storage backend.
 *
 * Order invariant: results are returned in seq order regardless of
 * resolution order. The read-side fold is order-sensitive (`U` then
 * `D` on the same doc must apply in that order); callers may iterate
 * the returned array as-is.
 *
 * Signal invariant: when the caller's `AbortSignal` fires, no further
 * chunks dispatch. In-flight reads see the signal via the underlying
 * `Storage.get` call.
 */

import {
  type DocumentData,
  type LogEntry,
  type Storage,
  BaerlyError,
  decodeJsonBytes,
  logObjectKey,
  MAX_PARALLEL_LOG_READS,
} from "@baerly/protocol";

/**
 * Fetch a single log entry. Centralises the "missing entry inside the
 * visible log range is a protocol-invariant violation" rule used by
 * every caller.
 *
 * @throws BaerlyError code="Internal" when the key resolves to no
 *   body — a hole inside `[log_seq_start, tail_hint)` is a corruption
 *   the kernel can't continue past.
 * @throws BaerlyError code="InvalidResponse" when the body isn't
 *   valid JSON.
 */
export const readLogEntry = async (
  storage: Storage,
  key: string,
  opts?: { signal?: AbortSignal },
): Promise<LogEntry> => {
  const got = await readLogEntryWithBytes(storage, key, opts);
  return got.entry;
};

/**
 * Like {@link readLogEntry}, but also surfaces `bytes` — the
 * byteLength of the STORED log-object body exactly as it was GET back
 * from storage (`got.body.byteLength`).
 *
 * The compactor uses this to sum the byte cost of the folded slice.
 * The stored body byteLength IS what the writer PUT for each entry,
 * so summing `got.body.byteLength` over the folded range yields the
 * exact cost — no re-encode, no round-trip assumption (a re-encode
 * of the parsed `LogEntry` could drift if key-order/whitespace ever
 * diverged from what was PUT).
 *
 * Same error semantics as {@link readLogEntry}.
 */
const readLogEntryWithBytes = async (
  storage: Storage,
  key: string,
  opts?: { signal?: AbortSignal },
): Promise<{ entry: LogEntry; bytes: number }> => {
  const got = await storage.get(
    key,
    opts?.signal !== undefined ? { signal: opts.signal } : undefined,
  );
  if (got === null) {
    throw new BaerlyError(
      "Internal",
      `log-walk: missing log entry at ${key}; protocol invariant violation`,
    );
  }
  try {
    return { entry: decodeJsonBytes<LogEntry>(got.body), bytes: got.body.byteLength };
  } catch (error) {
    throw new BaerlyError("InvalidResponse", `log-walk: malformed log entry at ${key}`, error);
  }
};

/**
 * Walk `[fromSeq, toSeqExclusive)` of `${logPrefix}/log/<seq>.json`
 * in chunks of {@link MAX_PARALLEL_LOG_READS} concurrent GETs.
 * Returns the materialised entries in seq order.
 *
 * Empty range (`fromSeq >= toSeqExclusive`) returns `[]` and issues
 * zero GETs.
 *
 * Same error semantics as {@link readLogEntry}: a missing entry
 * throws `Internal`, a malformed body throws `InvalidResponse`.
 */
export const walkLogRange = async (
  storage: Storage,
  logPrefix: string,
  fromSeq: number,
  toSeqExclusive: number,
  opts?: { signal?: AbortSignal },
): Promise<LogEntry[]> => {
  const withBytes = await walkLogRangeWithBytes(storage, logPrefix, fromSeq, toSeqExclusive, opts);
  return withBytes.map((r) => r.entry);
};

/**
 * Like {@link walkLogRange}, but each element also carries `bytes` —
 * the STORED log-object body byteLength (see {@link readLogEntryWithBytes}).
 * Same seq-order, empty-range, error, and bounded-parallelism
 * ({@link MAX_PARALLEL_LOG_READS}) guarantees as {@link walkLogRange};
 * this is the bytes-aware core `walkLogRange` is implemented on top of.
 *
 * The compactor consumes this so it gets BOTH the parsed entries (for
 * the fold) AND the exact byte sum (for `mean_entry_bytes` stamping) from a
 * single walk.
 */
export const walkLogRangeWithBytes = async (
  storage: Storage,
  logPrefix: string,
  fromSeq: number,
  toSeqExclusive: number,
  opts?: { signal?: AbortSignal },
): Promise<Array<{ entry: LogEntry; bytes: number }>> => {
  if (fromSeq >= toSeqExclusive) {
    return [];
  }
  const total = toSeqExclusive - fromSeq;
  const out: Array<{ entry: LogEntry; bytes: number }> = Array.from({ length: total });
  for (let chunkStart = 0; chunkStart < total; chunkStart += MAX_PARALLEL_LOG_READS) {
    opts?.signal?.throwIfAborted();
    const chunkEnd = Math.min(chunkStart + MAX_PARALLEL_LOG_READS, total);
    const promises: Array<Promise<{ entry: LogEntry; bytes: number }>> = [];
    for (let i = chunkStart; i < chunkEnd; i++) {
      const seq = fromSeq + i;
      promises.push(readLogEntryWithBytes(storage, logObjectKey(logPrefix, seq), opts));
    }
    const results = await Promise.all(promises);
    for (let i = 0; i < results.length; i++) {
      out[chunkStart + i] = results[i]!;
    }
  }
  return out;
};

/**
 * Fold a sequence of `LogEntry` records onto a doc-id-keyed map,
 * applying the protocol's per-doc-replace semantics:
 *
 *   - `I` / `U`: when `entry.after !== undefined`, set
 *     `map.set(entry.doc_id, entry.after)`. Entries with `after ===
 *     undefined` (the partial-merge writer's future patch-only shape)
 *     are ignored — today's writer always emits `after`, so this is a
 *     forward-compat guard, not a live branch.
 *   - `D`: tombstone — `map.delete(entry.doc_id)`.
 *
 * Entries whose `collection` does not match `opts.collection`, or
 * whose `doc_id` is `undefined`, are skipped. When
 * `opts.docIdFilter` is provided, only entries whose `doc_id` is
 * present in the filter set are folded — used by the index-walk
 * read path to scope the fold to the docs the planner already
 * resolved.
 *
 * This is the canonical fold used by the read path
 * (`query.ts`) and the index reconciler (`rebuild-index.ts`).
 * Centralising it keeps the
 * "straight `set` on I/U; tombstone on D" protocol invariant in one place.
 *
 * @see ../../../docs/spec/sync-protocol.md
 */
export const foldLogEntriesOnto = <T extends DocumentData>(
  map: Map<string, T>,
  entries: Iterable<LogEntry>,
  opts: {
    readonly collection: string;
    readonly docIdFilter?: ReadonlySet<string>;
  },
): void => {
  const { collection, docIdFilter } = opts;
  for (const entry of entries) {
    if (entry.collection !== collection) {
      continue;
    }
    if (entry.doc_id === undefined) {
      continue;
    }
    if (docIdFilter !== undefined && !docIdFilter.has(entry.doc_id)) {
      continue;
    }
    switch (entry.op) {
      case "I":
      case "U": {
        if (entry.after === undefined) {
          continue;
        }
        map.set(entry.doc_id, entry.after as T);
        break;
      }
      case "D": {
        map.delete(entry.doc_id);
        break;
      }
    }
  }
};
