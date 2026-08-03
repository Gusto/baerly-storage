/**
 * Shared fold fixture + measurement primitives for the fold benches
 * (bench/fold-cost.ts, bench/measurement/fold-ceiling-probe.ts).
 *
 * A "fold" here is ONE real `compact()` — the UNSLICEABLE snapshot
 * rebuild — run against a fresh `MemoryStorage` seeded with a
 * `current.json` + a prior snapshot of an exact (rows, bytesPerDoc)
 * shape + a representative log tail. The whole tail folds in a SINGLE
 * pass (`maxEntriesPerRun` large, `minEntriesToCompact = 1`) so what is
 * measured is the unsliceable rebuild, not a sliced drain. The fold does
 * the production work end to end: load + hash-verify the old snapshot,
 * apply the tail merge, re-serialize the new snapshot body, SHA-256 it,
 * PUT it, CAS-advance `current.json`. Storage is in-memory so I/O is
 * ~free and the measured cost is the CPU/allocation of the rebuild
 * itself.
 *
 * MEASUREMENT METHOD
 *   - **CPU**: `process.cpuUsage()` deltas (user + system µs) bracketing
 *     the fold, reported in ms. NOT wall-clock — folds are CPU-bound on
 *     Workers and wall would include I/O (which MemoryStorage makes ~free
 *     anyway).
 *   - **Peak memory**: a tight sampler on
 *     `process.memoryUsage().heapUsed` ({@link HEAP_SAMPLE_INTERVAL_MS}
 *     via a `setInterval`) running for the duration of the fold; the
 *     per-fold peak is `max(sample) - heapUsedAtStart`. The fold holds
 *     old snapshot + new snapshot + tail resident (~2–3× snapshot).
 *     Sampling (not `--expose-gc` deltas) so the benches run with a bare
 *     `node` like the other no-infra benches.
 *   - **Fixture realism** — the pad is a single repeated-char string
 *     (`"x".repeat(n)`), so absolute byte-axis numbers are a mild lower
 *     bound vs. heterogeneous real documents; the linear *shape* (linear
 *     in bytes, the per-row slope) is the portable signal.
 *
 * This module has NO module-scope side effects, so it is safe to import
 * from a test or from another bench. Its callers own the grid, the
 * iteration counts, and the output format. MEASURES ONLY — it changes no
 * production behaviour and no constant.
 */

/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document + snapshot shapes (see `@baerly/protocol`'s
   `Collection<T>` / the snapshot body). */

import {
  type CurrentJson,
  type DocumentData,
  type LogEntry,
  MemoryStorage,
  countKey,
  encodeJsonBytes,
  snapshotHash,
  timestamp,
} from "@baerly/protocol";
import { type SnapshotBody, encodeSnapshotBody, snapshotKey } from "@baerly/server";
import { compact } from "@baerly/server/maintenance";
import type { InternalCompactOptions } from "@baerly/server/_internal/testing";

// ── Fixture config. Pinned constants — tweak in the source if needed. ──

/** "fold cost"; reproduction handle. Captured in every result JSON. */
export const SEED = 0xf01d_c057;
const SESSION = "fold000"; // 7 chars; the bench doesn't validate sessions.
const COLLECTION = "notes";
const CURRENT_JSON_KEY = `app/x/tenant/t/manifests/${COLLECTION}/current.json`;
const COLLECTION_PREFIX = `app/x/tenant/t/manifests/${COLLECTION}`;

/** Heap-sampling interval during a fold (ms). */
export const HEAP_SAMPLE_INTERVAL_MS = 1;

/**
 * Tail length folded per measured rebuild. Small + fixed so the fold's
 * cost is dominated by the snapshot rebuild (load old + serialize new +
 * hash), not by the tail walk — which mirrors the production shape (the
 * tail is SLICED, the snapshot rebuild is the unsliceable cost). The
 * tail updates existing docs so the new snapshot stays the same size /
 * row count as the old (a steady-state fold).
 */
export const TAIL_ENTRIES = 100;

/**
 * Mulberry32 PRNG — small, seedable, no deps. Deterministic input so
 * two runs on the same machine produce comparable snapshot shapes.
 */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Build a document whose canonical JSON byteLength is close to
 * `targetBytes`. The doc carries a few typed fields plus a `pad` string
 * sized to hit the target; representative of a real notes-shaped record
 * (string body + scalars) rather than one giant blob.
 */
const makeDoc = (id: string, targetBytes: number, rng: () => number): DocumentData => {
  // Fixed scaffold the encoder always emits; the pad absorbs the rest.
  const scaffold: DocumentData = {
    _id: id,
    title: `note ${id}`,
    n: Math.floor(rng() * 1_000_000),
    done: rng() < 0.5,
    pad: "",
  };
  const scaffoldBytes = encodeJsonBytes(scaffold).byteLength;
  const padLen = Math.max(0, targetBytes - scaffoldBytes);
  // Printable ASCII so each char is one JSON byte (no escaping / multi-
  // byte surprises that would throw off the target).
  return { ...scaffold, pad: "x".repeat(padLen) };
};

/** Lexicographic `_id` comparator — same ordering the compactor uses. */
const byIdAsc = (a: string, b: string): number => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

export interface FoldFixture {
  readonly storage: MemoryStorage;
  /** Actual canonical snapshot-body byteLength (measured, not target). */
  readonly snapshotBytes: number;
  readonly rows: number;
}

/**
 * Seed a fresh `MemoryStorage` with a `current.json` + a prior snapshot
 * of (rows × bytesPerDoc) + a `TAIL_ENTRIES`-long log tail that updates
 * existing docs. After this returns, a single `compact()` call folds the
 * whole tail into a rebuilt snapshot of the same shape.
 */
export const buildFixture = async (rows: number, bytesPerDoc: number): Promise<FoldFixture> => {
  const storage = new MemoryStorage();
  const rng = mulberry32(SEED ^ (rows * 0x9e37_79b1) ^ bytesPerDoc);

  // 1. Prior snapshot: `rows` docs, sorted by _id (compactor invariant).
  const docs: Array<{ _id: string; body: DocumentData }> = [];
  for (let i = 0; i < rows; i++) {
    const id = `doc-${i.toString().padStart(8, "0")}`;
    docs.push({ _id: id, body: makeDoc(id, bytesPerDoc, rng) });
  }
  docs.sort((a, b) => byIdAsc(a._id, b._id));
  const snapBody: SnapshotBody = {
    schema_version: 1,
    min_seq: 0,
    max_seq: rows, // prior snapshot covered [0, rows)
    collection: COLLECTION,
    docs,
  };
  const snapBytes = encodeSnapshotBody(snapBody);
  const sha = await snapshotHash(snapBytes);
  const snapKey = snapshotKey(COLLECTION_PREFIX, 0, rows, sha);
  await storage.put(snapKey, snapBytes, { contentType: "application/json" });

  // 2. Log tail: TAIL_ENTRIES updates to existing docs at seqs
  //    [rows, rows + TAIL_ENTRIES). U with a full post-image keeps the
  //    rebuilt snapshot the same row count (steady-state fold).
  for (let t = 0; t < TAIL_ENTRIES; t++) {
    const seq = rows + t;
    const targetIdx = Math.floor(rng() * rows);
    const id = `doc-${targetIdx.toString().padStart(8, "0")}`;
    const entry: LogEntry = {
      lsn: `${timestamp(1_700_000_000_000 + seq)}_${SESSION}_${countKey(seq)}`,
      commit_ts: new Date(1_700_000_000_000 + seq).toISOString(),
      op: "U",
      collection: COLLECTION,
      doc_id: id,
      after: makeDoc(id, bytesPerDoc, rng),
      session: SESSION,
      seq,
    };
    const entryBytes = encodeJsonBytes(entry);
    await storage.put(`${COLLECTION_PREFIX}/log/${seq}.json`, entryBytes, {
      contentType: "application/json",
    });
  }

  // 3. current.json pointing at the prior snapshot with the tail live.
  const current: CurrentJson = {
    schema_version: 3,
    snapshot: snapKey,
    tail_hint: rows + TAIL_ENTRIES,
    log_seq_start: rows,
    writer_fence: { epoch: 1, owner: "fold-cost-bench", claimed_at: "" },
    snapshot_bytes: snapBytes.byteLength,
    snapshot_rows: rows,
  };
  await storage.put(CURRENT_JSON_KEY, encodeJsonBytes(current), {
    ifNoneMatch: "*",
    contentType: "application/json",
  });

  return { storage, snapshotBytes: snapBytes.byteLength, rows };
};

/** A single measured fold over an already-built fixture. */
export const measureOneFold = async (
  storage: MemoryStorage,
): Promise<{ cpuMs: number; peakBytes: number }> => {
  const heapStart = process.memoryUsage().heapUsed;
  let peak = heapStart;
  const sampler = setInterval(() => {
    const h = process.memoryUsage().heapUsed;
    if (h > peak) {
      peak = h;
    }
  }, HEAP_SAMPLE_INTERVAL_MS);
  // `unref` so a stray timer can never keep the process alive.
  sampler.unref();

  const cpu0 = process.cpuUsage();
  // Whole tail in one pass (the unsliceable rebuild); no ceiling (we are
  // measuring the fold, not the defer path). `maxEntriesPerRun` rides on
  // the internal options object.
  const opts: InternalCompactOptions = {
    minEntriesToCompact: 1,
    maxEntriesPerRun: Number.MAX_SAFE_INTEGER,
  };
  const res = await compact({ storage, currentJsonKey: CURRENT_JSON_KEY }, opts);
  const cpu1 = process.cpuUsage(cpu0);
  clearInterval(sampler);

  if (!res.written) {
    throw new Error(`fold-cost: expected a written fold, got skippedReason=${res.skippedReason}`);
  }
  // One last sample in case the fold finished between ticks.
  const heapEnd = process.memoryUsage().heapUsed;
  if (heapEnd > peak) {
    peak = heapEnd;
  }
  const cpuMs = (cpu1.user + cpu1.system) / 1000; // µs → ms
  const peakBytes = Math.max(0, peak - heapStart);
  return { cpuMs, peakBytes };
};

export const median = (xs: readonly number[]): number => {
  const s = [...xs].toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
};
