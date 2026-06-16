/**
 * Fold-cost microbench — Phase 2 measurement infrastructure.
 *
 * Measures the CPU + peak-memory cost of ONE compaction fold — the
 * UNSLICEABLE snapshot rebuild — as a function of two axes:
 *
 *   - **snapshot size in bytes** (the JSON parse / stringify / SHA-256
 *     axis), and
 *   - **snapshot row count** (the per-entry parse / merge / serialize
 *     axis — many tiny docs).
 *
 * This is the bench that will eventually REPLACE the *modelled* numbers
 * in `docs/about/graduation.md` ("≈ 11 ms CPU per MB of snapshot
 * rebuilt", and the PROVISIONAL `E = 2048` row ceiling) with *measured*
 * ones, so the snapshot ceilings `C` / `E` can rise on a more capable
 * host later (paid Cloudflare is MEMORY-bound where free is CPU-bound,
 * so BOTH axes are reported). This bench MEASURES ONLY — it changes no
 * production behaviour and no constant.
 *
 * What a "fold" is here: each iteration runs the real
 * `compact()` (`@gusto/baerly-storage/maintenance`) against a fresh
 * `MemoryStorage` seeded with a `current.json` + a prior snapshot of the
 * exact (rows, bytesPerDoc) shape + a representative log tail. The whole
 * tail folds in a SINGLE pass (`maxEntriesPerRun` large,
 * `minEntriesToCompact = 1`) so we measure the unsliceable rebuild, not
 * a sliced drain. The fold does the production work end to end: load +
 * hash-verify the old snapshot, apply the tail merge, re-serialize the
 * new snapshot body, SHA-256 it, PUT it, CAS-advance `current.json`.
 * Storage is in-memory so I/O is ~free and the measured cost is the
 * CPU/allocation of the rebuild itself.
 *
 * MEASUREMENT METHOD
 *   - **CPU**: `process.cpuUsage()` deltas (user + system µs) bracketing
 *     the fold, reported in ms. NOT wall-clock — folds are CPU-bound on
 *     Workers and wall would include I/O (which MemoryStorage makes ~free
 *     anyway). Median over N iterations after warmup.
 *   - **Peak memory**: a tight sampling sampler on
 *     `process.memoryUsage().heapUsed` (default 1 ms via a `setInterval`)
 *     running for the duration of the fold; the per-fold peak is
 *     `max(sample) - heapUsedAtStart`. The fold holds old snapshot + new
 *     snapshot + tail resident (~2–3× snapshot). Sampling (not
 *     `--expose-gc` deltas) so the bench runs with a bare `node` like the
 *     other no-infra benches. Median over N iterations.
 *   - **Median only** — only the median of each axis is reported.
 *     min/max are deliberately omitted: a GC inside a fold can drop
 *     heapUsed below the start mark, flooring the sampled-peak min to 0
 *     (which reads as "no memory used" but is a GC artifact), and a GC
 *     CPU spike is an outlier the median correctly absorbs but that reads
 *     as signal in a checked-in reference. The median is the
 *     load-bearing number.
 *   - **Fixture realism** — the byte-axis pad is a single repeated-char
 *     string (`"x".repeat(n)`), so the absolute byte-axis numbers are a
 *     mild lower bound vs. heterogeneous real documents; the linear
 *     *shape* (linear in bytes, the per-row slope) is the portable
 *     signal, not the absolute bytes.
 *
 * GRID — tied to the graduation.md cost-model table.
 *   - **bytes axis** brackets the table's 64 KB / 256 KB / 512 KB (the
 *     default `C`) / 1 MB (≈ CF-free CPU line) / 5 MB rows. We hold
 *     bytes/doc fixed and vary row count to hit each target snapshot
 *     size, so the dominant variable is snapshot bytes.
 *   - **rows axis** holds bytes/doc small (tiny docs) and sweeps row
 *     count from hundreds up past the current `E = 2048` to ~16k, so the
 *     per-entry (parse/merge/serialize) cost is isolated from the byte
 *     cost. This is the axis that decides whether `E = 2048` is
 *     well-sized.
 *
 * OUTPUT — one JSON file per run to `bench/results/fold-cost/`, shaped so
 * a future reader can find "where does ~30 s CPU / ~128 MB intersect"
 * (the input to raising `C` / `E` on paid). A checked-in baseline lives
 * at `docs/spec/attachments/fold-cost-baseline.json` (per-run output under
 * `bench/results/fold-cost/` is gitignored).
 *
 * Reproduction: `pnpm bench:fold-cost`. Seeded; the seed is captured in
 * the result JSON. Numbers are machine-specific (they record the host's
 * node version); the *shape* (linear in bytes, the per-row slope) is the
 * portable signal.
 */

/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document + snapshot shapes (see `@baerly/protocol`'s
   `Collection<T>` / the snapshot body). */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type CurrentJson,
  type DocumentData,
  type LogEntry,
  MAINTENANCE_MAX_FOLD_ROWS,
  MemoryStorage,
  countKey,
  encodeJsonBytes,
  snapshotHash,
  timestamp,
} from "@baerly/protocol";
import { type SnapshotBody, encodeSnapshotBody, snapshotKey } from "@baerly/server";
import { compact } from "@baerly/server/maintenance";
import type { InternalCompactOptions } from "@baerly/server/_internal/testing";

// ── Bench config. Pinned constants — tweak in the source if needed. ──

const SEED = 0xf01d_c057; // "fold cost"; reproduction handle.
const SESSION = "fold000"; // 7 chars; the bench doesn't validate sessions.
const COLLECTION = "notes";
const CURRENT_JSON_KEY = `app/x/tenant/t/manifests/${COLLECTION}/current.json`;
const COLLECTION_PREFIX = `app/x/tenant/t/manifests/${COLLECTION}`;

/** Warmup folds (discarded) then measured folds, per grid point. */
const WARMUP_ITERS = 5;
const MEASURE_ITERS = 11;

/** Heap-sampling interval during a fold (ms). */
const HEAP_SAMPLE_INTERVAL_MS = 1;

/**
 * Tail length folded per measured rebuild. Small + fixed so the fold's
 * cost is dominated by the snapshot rebuild (load old + serialize new +
 * hash), not by the tail walk — which mirrors the production shape (the
 * tail is SLICED, the snapshot rebuild is the unsliceable cost). The
 * tail updates existing docs so the new snapshot stays the same size /
 * row count as the old (a steady-state fold).
 */
const TAIL_ENTRIES = 100;

/**
 * BYTES axis — fixed bytes/doc, row count chosen to bracket the
 * graduation.md cost-model table's snapshot sizes
 * (64 KB / 256 KB / 512 KB / 1 MB / 5 MB). 2 KB/doc sits in the table's
 * "1–5 KB/doc" band, so the row counts below land each target size.
 */
const BYTES_AXIS_BYTES_PER_DOC = 2048;
const BYTES_AXIS_TARGETS: ReadonlyArray<{ label: string; snapshotBytesApprox: number }> = [
  { label: "64KB", snapshotBytesApprox: 64 * 1024 },
  { label: "256KB", snapshotBytesApprox: 256 * 1024 },
  { label: "512KB", snapshotBytesApprox: 512 * 1024 }, // default ceiling C
  { label: "1MB", snapshotBytesApprox: 1024 * 1024 }, // ≈ CF-free CPU line
  { label: "5MB", snapshotBytesApprox: 5 * 1024 * 1024 },
];

/**
 * ROWS axis — fixed SMALL bytes/doc (tiny docs), row count swept from
 * hundreds up past the current `E = 2048` to ~16k so the per-entry
 * parse/merge/serialize cost is isolated from the byte cost. 64 bytes/doc
 * keeps the snapshot small (16k × ~64 B ≈ 1 MB) so byte-cost stays a
 * minority of the work and the per-row slope dominates.
 */
const ROWS_AXIS_BYTES_PER_DOC = 64;
const ROWS_AXIS_ROW_COUNTS: readonly number[] = [
  256,
  512,
  1024,
  MAINTENANCE_MAX_FOLD_ROWS, // 2048 — the current row ceiling E
  4096,
  8192,
  16384,
];

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

interface FoldFixture {
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
const buildFixture = async (rows: number, bytesPerDoc: number): Promise<FoldFixture> => {
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
const measureOneFold = async (
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

const median = (xs: readonly number[]): number => {
  const s = [...xs].toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
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

/** Bytes → KB / MB for the summary table. */
const kb = (b: number): string => (b / 1024).toFixed(0);
const mb = (b: number): string => (b / (1024 * 1024)).toFixed(2);

interface CellResult {
  readonly axis: "bytes" | "rows";
  /** For the bytes axis: the table label (64KB…5MB). */
  readonly label?: string;
  readonly rows: number;
  readonly bytes_per_doc: number;
  /** Measured canonical snapshot-body byteLength of the rebuilt snapshot. */
  readonly snapshot_bytes: number;
  readonly tail_entries: number;
  readonly iterations: number;
  readonly cpu_ms_median: number;
  readonly peak_bytes_median: number;
  /** Convenience: peak heap delta as a multiple of the snapshot bytes. */
  readonly peak_over_snapshot: number;
}

interface RunResult {
  readonly schema_version: 1;
  readonly bench: "fold-cost";
  readonly description: string;
  readonly seed: number;
  readonly warmup_iters: number;
  readonly measure_iters: number;
  readonly tail_entries: number;
  readonly heap_sample_interval_ms: number;
  readonly measurement: {
    readonly cpu: "process.cpuUsage() user+system delta, reported ms";
    readonly memory: "sampled process.memoryUsage().heapUsed peak minus start, reported bytes";
    readonly note: "median only (min/max omitted — sampled-peak min can float to 0 on a GC, and a GC CPU spike is an outlier the median absorbs); byte-axis pad is a single repeated-char string, so absolute byte numbers are a mild lower bound vs. heterogeneous real docs — the linear shape is the portable signal";
  };
  /** Modelled reference numbers from docs/about/graduation.md (NOT measured). */
  readonly modelled_reference: {
    readonly cpu_ms_per_mb: 11;
    readonly row_ceiling_E_provisional: number;
    readonly byte_ceiling_C_default_bytes: number;
  };
  readonly cells: readonly CellResult[];
  readonly timestamp_iso: string;
  readonly node_version: string;
  readonly platform: string;
  readonly arch: string;
}

const runCell = async (
  axis: "bytes" | "rows",
  rows: number,
  bytesPerDoc: number,
  label?: string,
): Promise<CellResult> => {
  // Warmup — fresh fixture each time (a fixture is single-use: the fold
  // mutates current.json + the snapshot pointer).
  for (let i = 0; i < WARMUP_ITERS; i++) {
    const { storage } = await buildFixture(rows, bytesPerDoc);
    await measureOneFold(storage);
  }
  const cpuSamples: number[] = [];
  const peakSamples: number[] = [];
  let snapshotBytes = 0;
  for (let i = 0; i < MEASURE_ITERS; i++) {
    const fx = await buildFixture(rows, bytesPerDoc);
    snapshotBytes = fx.snapshotBytes;
    const { cpuMs, peakBytes } = await measureOneFold(fx.storage);
    cpuSamples.push(cpuMs);
    peakSamples.push(peakBytes);
  }
  const peakMedian = median(peakSamples);
  return {
    axis,
    ...(label !== undefined && { label }),
    rows,
    bytes_per_doc: bytesPerDoc,
    snapshot_bytes: snapshotBytes,
    tail_entries: TAIL_ENTRIES,
    iterations: MEASURE_ITERS,
    cpu_ms_median: median(cpuSamples),
    peak_bytes_median: peakMedian,
    peak_over_snapshot: snapshotBytes > 0 ? peakMedian / snapshotBytes : 0,
  };
};

const main = async (): Promise<number> => {
  const startedAt = Date.now();
  const cells: CellResult[] = [];

  // ── BYTES axis ─────────────────────────────────────────────────────
  for (const target of BYTES_AXIS_TARGETS) {
    const rows = Math.max(1, Math.round(target.snapshotBytesApprox / BYTES_AXIS_BYTES_PER_DOC));
    cells.push(await runCell("bytes", rows, BYTES_AXIS_BYTES_PER_DOC, target.label));
  }

  // ── ROWS axis ──────────────────────────────────────────────────────
  for (const rows of ROWS_AXIS_ROW_COUNTS) {
    cells.push(await runCell("rows", rows, ROWS_AXIS_BYTES_PER_DOC));
  }

  const result: RunResult = {
    schema_version: 1,
    bench: "fold-cost",
    description:
      "CPU + peak-heap cost of one unsliceable compaction fold (snapshot rebuild) " +
      "vs snapshot bytes and snapshot row count. Measures only; changes no constant.",
    seed: SEED,
    warmup_iters: WARMUP_ITERS,
    measure_iters: MEASURE_ITERS,
    tail_entries: TAIL_ENTRIES,
    heap_sample_interval_ms: HEAP_SAMPLE_INTERVAL_MS,
    measurement: {
      cpu: "process.cpuUsage() user+system delta, reported ms",
      memory: "sampled process.memoryUsage().heapUsed peak minus start, reported bytes",
      note: "median only (min/max omitted — sampled-peak min can float to 0 on a GC, and a GC CPU spike is an outlier the median absorbs); byte-axis pad is a single repeated-char string, so absolute byte numbers are a mild lower bound vs. heterogeneous real docs — the linear shape is the portable signal",
    },
    modelled_reference: {
      cpu_ms_per_mb: 11,
      row_ceiling_E_provisional: MAINTENANCE_MAX_FOLD_ROWS,
      byte_ceiling_C_default_bytes: 512 * 1024,
    },
    cells,
    timestamp_iso: new Date(startedAt).toISOString(),
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
  };

  const outDir = "bench/results/fold-cost";
  await mkdir(outDir, { recursive: true });
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  const out = path.join(outDir, `fold-cost-${stamp}.json`);
  await writeFile(out, JSON.stringify(result, null, 2));

  console.log("axis   label   rows   snapKB   cpuMs(med)  peakMB(med)  peak/snap");
  for (const c of cells) {
    console.log(
      `${c.axis.padEnd(6)} ${(c.label ?? "-").padEnd(6)} ` +
        `${c.rows.toString().padStart(6)} ` +
        `${kb(c.snapshot_bytes).padStart(7)} ` +
        `${c.cpu_ms_median.toFixed(2).padStart(10)} ` +
        `${mb(c.peak_bytes_median).padStart(11)} ` +
        `${c.peak_over_snapshot.toFixed(2).padStart(9)}`,
    );
  }
  console.log(`wrote ${out}`);
  return 0;
};

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(2);
  },
);
