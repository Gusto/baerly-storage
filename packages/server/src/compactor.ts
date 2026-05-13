/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol/src/db.ts`'s `Table<T>` /
   `Query<T>` declarations); the snapshot body carries it through. */

/**
 * Phase-5 compactor: fold a prefix of the live log into a content-
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
 * Order of operations (matches `ServerWriter.commit`'s manifest-first-
 * REVERSED ordering): PUT snapshot body → CAS-advance `current.json`.
 * A crash before the swap leaves an orphan snapshot file; the swap
 * succeeds iff our captured ETag still matches.
 *
 * @see ../../../../.claude/research/planning/tickets/14-snapshot-build-and-pointer-swap.md
 */

import {
  type CurrentJson,
  type JSONArraylessObject,
  type LogEntry,
  type MetricsRecorder,
  logSeqStartOf,
  BaerlyError,
  noopMetricsRecorder,
  readCurrentJson,
  snapshotHash,
  type Storage,
  type StoragePutOptions,
} from "@baerly/protocol";

/**
 * Snapshot filenames are sealed by their body's SHA-256:
 *
 *   `<tablePrefix>/snapshot/L<level>/<minSeq>-<maxSeq>-<sha256>.json`
 *
 *   - `L<level>`: integer ≥ 0. This ticket ships single-level
 *     snapshots written at L9 (one snapshot replaces the prior; no
 *     multi-level merge yet). Future tickets may introduce L0 (small,
 *     recent) and merge runs that produce L1, L2, …, L9.
 *   - `minSeq` / `maxSeq`: zero-padded decimal log sequence numbers,
 *     inclusive-exclusive. `maxSeq` equals the new `log_seq_start` —
 *     the snapshot covers `[minSeq, maxSeq)` and the live log starts
 *     at `maxSeq`.
 *   - `sha256`: 64 hex chars; the body's SHA-256.
 *
 * `minSeq` and `maxSeq` are padded to {@link SEQ_DIGITS} digits so
 * lex-order over snapshot keys matches numeric order. JavaScript's
 * `Number.MAX_SAFE_INTEGER` is 2^53 - 1 ≈ 9.007e15 (16 digits); we
 * pad to 12 digits — enough for ~one trillion entries — without
 * making the filenames noisy. `snapshotKey` refuses to produce a
 * snapshot whose `maxSeq` overflows 12 digits.
 */
export const SNAPSHOT_LEVEL = 9 as const;
export const SEQ_DIGITS = 12 as const;
const MAX_SEQ = 10 ** SEQ_DIGITS - 1;

export const snapshotKey = (
  tablePrefix: string,
  minSeq: number,
  maxSeq: number,
  sha256: string,
): string => {
  if (minSeq < 0 || maxSeq < 0 || minSeq > maxSeq || maxSeq > MAX_SEQ) {
    throw new BaerlyError("InvalidConfig", `snapshotKey: invalid range [${minSeq}, ${maxSeq})`);
  }
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new BaerlyError("InvalidConfig", "snapshotKey: sha256 must be 64 hex chars");
  }
  const pad = (n: number): string => n.toString().padStart(SEQ_DIGITS, "0");
  return `${tablePrefix}/snapshot/L${SNAPSHOT_LEVEL}/${pad(minSeq)}-${pad(maxSeq)}-${sha256}.json`;
};

/**
 * On-bucket body of a snapshot file. The reader recomputes the SHA-256
 * over the canonical serialisation ({@link encodeSnapshotBody}) and
 * rejects any mismatch with the filename hash.
 *
 * `docs` is sorted by `_id` for deterministic byte output — two
 * compactions over the same fold produce byte-identical snapshots,
 * which means same filename, which means an idempotent re-run never
 * leaves an orphan.
 */
export interface SnapshotBody {
  readonly schema_version: 1;
  readonly min_seq: number;
  readonly max_seq: number;
  readonly collection: string;
  readonly docs: ReadonlyArray<{
    readonly _id: string;
    readonly body: JSONArraylessObject;
  }>;
}

/**
 * Canonical byte encoding of a {@link SnapshotBody}. Only the
 * compactor produces snapshots, and only this function does the
 * serialisation — so the byte output is deterministic for a given
 * `SnapshotBody` (identical input ⇒ identical bytes ⇒ identical
 * filename hash).
 */
export const encodeSnapshotBody = (s: SnapshotBody): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(s));

/**
 * Configuration knobs. All optional; defaults are tuned for the
 * Cloudflare free-tier subrequest budget (50 / request).
 */
export interface CompactOptions {
  /**
   * Maximum number of log entries to fold in a single `compact()`
   * call. The compactor's I/O profile is `maxEntriesPerRun + 3`
   * subrequests (N GETs + 1 PUT snapshot + 1 GET current + 1 PUT
   * current). Default 40 keeps us under the 50-cap free tier with
   * headroom. Cloudflare paid tier supports 10k; pick `9000` there.
   * Node has no cap; pick anything.
   */
  readonly maxEntriesPerRun?: number;

  /**
   * Minimum log-tail length to compact. Skips work when there are
   * fewer than this many live entries past the last snapshot.
   * Default 100.
   */
  readonly minEntriesToCompact?: number;

  /** Optional AbortSignal forwarded to every storage call. */
  readonly signal?: AbortSignal;

  /**
   * Optional metrics sink. Defaults to {@link noopMetricsRecorder}.
   * On a landed compaction (i.e. `result.written === true`) emits:
   *   - `db.compact.entries_folded` histogram (the count of log
   *     entries folded into the new snapshot).
   *   - `db.manifest.lag_window_depth` gauge (post-compaction live
   *     tail length: `next_seq - foldEnd`).
   */
  readonly metrics?: MetricsRecorder;
}

export interface CompactResult {
  /** `true` iff a new snapshot landed and `current.json` was advanced. */
  readonly written: boolean;
  /** Reason `written === false`. */
  readonly skippedReason?: "below-min-threshold" | "current-json-missing" | "cas-lost";
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

const DEFAULT_MAX_PER_RUN = 40;
const DEFAULT_MIN_TO_COMPACT = 100;
const APPLICATION_JSON = "application/json";

/**
 * Fold a prefix of the live log into a new snapshot and CAS-advance
 * `current.json`. Idempotent: a second run with no new writes is a
 * no-op (below-min-threshold).
 *
 * Single-attempt: on CAS conflict we return
 * `{written: false, skippedReason: "cas-lost", newSnapshotKey}` — the
 * caller (ticket 16's cron handler) decides whether to schedule
 * another run. The orphan snapshot file just written will be swept by
 * ticket 15.
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
 * import { compact } from "@baerly/server";
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
  const maxPerRun = options.maxEntriesPerRun ?? DEFAULT_MAX_PER_RUN;
  const minToCompact = options.minEntriesToCompact ?? DEFAULT_MIN_TO_COMPACT;
  const metrics = options.metrics ?? noopMetricsRecorder;
  const tablePrefix = currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"));
  const tableName = tablePrefix.slice(tablePrefix.lastIndexOf("/") + 1);

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
  const nextSeq = current.next_seq;
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
      ? new Map<string, JSONArraylessObject>()
      : await loadSnapshotAsMap(storage, current.snapshot, tableName, options.signal);

  // ── Step 3. Parallel-fetch [logSeqStartBefore, foldEnd) entries. ──
  const reads: Array<Promise<LogEntry>> = [];
  for (let s = logSeqStartBefore; s < foldEnd; s++) {
    reads.push(readLogEntry(storage, `${tablePrefix}/log/${s}.json`, options.signal));
  }
  const entries = await Promise.all(reads);

  // ── Step 4. Apply the fold onto `base`. ─────────────────────────
  // I / U overwrite with the post-image (today's per-doc-replace
  // model: writer emits `entry.new` as the full post-image, see
  // packages/protocol/src/log.ts:67-72). D tombstones. T / M are
  // forward-compat shapes (writer doesn't emit them today).
  for (const entry of entries) {
    if (entry.collection !== tableName) continue;
    if (entry.doc_id === undefined) continue;
    switch (entry.op) {
      case "I":
      case "U":
        if (entry.new !== undefined) base.set(entry.doc_id, entry.new);
        break;
      case "D":
        base.delete(entry.doc_id);
        break;
      case "T":
      case "M":
        // No-op for this ticket.
        break;
    }
  }

  // ── Step 5. Build the canonical snapshot body. ──────────────────
  // Sort by `_id` so the byte output is deterministic — same fold ⇒
  // same body ⇒ same hash ⇒ same filename. Idempotent re-runs.
  const sortedDocs = Array.from(base.entries())
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([id, body]) => ({ _id: id, body }));
  const snapshotBody: SnapshotBody = {
    schema_version: 1,
    min_seq: 0,
    max_seq: foldEnd,
    collection: tableName,
    docs: sortedDocs,
  };
  const bodyBytes = encodeSnapshotBody(snapshotBody);
  const sha256 = await snapshotHash(bodyBytes);
  const newKey = snapshotKey(tablePrefix, 0, foldEnd, sha256);

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
  const next: CurrentJson = {
    ...current,
    snapshot: newKey,
    log_seq_start: foldEnd,
  };
  const nextBody = new TextEncoder().encode(JSON.stringify(next));
  const casOpts: StoragePutOptions = {
    ifMatch: baseEtag,
    contentType: APPLICATION_JSON,
    ...(options.signal !== undefined && { signal: options.signal }),
  };
  try {
    await storage.put(currentJsonKey, nextBody, casOpts);
  } catch (err) {
    if (isCasConflict(err)) {
      // Another writer landed between our read and write. The
      // snapshot file we just wrote is now an orphan (correct
      // content, unreferenced) — GC ticket 15 will sweep it. Surface
      // cas-lost; the cron handler can rerun us next tick.
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
    throw err;
  }

  // ── Step 8. Emit metrics on a successful run. ───────────────────
  // `lag_window_depth` is the post-compaction live tail length —
  // entries still pending fold after this run. `entries_folded` is
  // the per-run histogram sample. Metrics are in-memory only; they
  // add zero storage ops.
  const entriesFolded = foldEnd - logSeqStartBefore;
  metrics.histogram("db.compact.entries_folded", entriesFolded, { collection: tableName });
  metrics.gauge("db.manifest.lag_window_depth", current.next_seq - foldEnd, {
    collection: tableName,
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

/**
 * Load a snapshot at `key`, verify its body's SHA-256 against the
 * hash embedded in its filename, and return the docs as a
 * `Map<_id, body>`. Used by both the compactor (loading the prior
 * snapshot as a fold base) and the reader (`Query.runRead`).
 *
 * @throws BaerlyError code="Internal" — the pointer resolves to no
 *   body, or the body's hash doesn't match the filename. A crashed
 *   mid-PUT compactor produces the latter; readers treat it as
 *   "missing."
 * @throws BaerlyError code="InvalidResponse" — body isn't valid JSON,
 *   carries an unknown schema_version, or names a different
 *   collection than expected.
 */
export const loadSnapshotAsMap = async (
  storage: Storage,
  key: string,
  expectedCollection: string,
  signal?: AbortSignal,
): Promise<Map<string, JSONArraylessObject>> => {
  const got = await storage.get(key, signal !== undefined ? { signal } : undefined);
  if (got === null) {
    throw new BaerlyError(
      "Internal",
      `compact: snapshot pointer ${key} resolves to no body; protocol violation`,
    );
  }
  // Verify hash: the filename shape is
  // `<...>/snapshot/L<n>/<min>-<max>-<sha256>.json`. The sha256 is
  // the segment after the LAST `-` (the two seq fields don't contain
  // dashes), with `.json` stripped.
  const filename = key.slice(key.lastIndexOf("/") + 1).replace(/\.json$/, "");
  const lastDash = filename.lastIndexOf("-");
  const expectedHash = filename.slice(lastDash + 1);
  const actualHash = await snapshotHash(got.body);
  if (actualHash !== expectedHash) {
    throw new BaerlyError(
      "Internal",
      `compact: snapshot ${key} body hash mismatch (got ${actualHash}); protocol violation`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(got.body));
  } catch (e) {
    throw new BaerlyError("InvalidResponse", `compact: snapshot ${key} body is not valid JSON`, e);
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new BaerlyError("InvalidResponse", `compact: snapshot ${key} body is not an object`);
  }
  const body = parsed as SnapshotBody;
  if (body.schema_version !== 1) {
    throw new BaerlyError(
      "InvalidResponse",
      `compact: snapshot ${key} has unsupported schema_version ${String(body.schema_version)}`,
    );
  }
  if (body.collection !== expectedCollection) {
    throw new BaerlyError(
      "InvalidResponse",
      `compact: snapshot ${key} carries collection ${body.collection}, expected ${expectedCollection}`,
    );
  }
  const map = new Map<string, JSONArraylessObject>();
  for (const row of body.docs) map.set(row._id, row.body);
  return map;
};

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

const readLogEntry = async (
  storage: Storage,
  key: string,
  signal: AbortSignal | undefined,
): Promise<LogEntry> => {
  const got = await storage.get(key, signal !== undefined ? { signal } : undefined);
  if (got === null) {
    throw new BaerlyError(
      "Internal",
      `compact: missing log entry at ${key}; protocol invariant violation`,
    );
  }
  try {
    return JSON.parse(new TextDecoder().decode(got.body)) as LogEntry;
  } catch (e) {
    throw new BaerlyError("InvalidResponse", `compact: malformed log entry at ${key}`, e);
  }
};

/**
 * `true` when an `If-Match` CAS guard lost. Every in-tree
 * {@link Storage} impl surfaces a lost CAS as
 * `BaerlyError{code:"Conflict"}`.
 */
const isCasConflict = (err: unknown): boolean =>
  err instanceof BaerlyError && err.code === "Conflict";
