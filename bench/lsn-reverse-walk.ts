/**
 * Patent C3 evidence — quantify bytes-listed reduction of the
 * descending-base-32 LSN encoding over a naïve ascending-base-32
 * forward-list + in-memory reverse alternative.
 *
 * Two arms over a population of N synthetic LSN-shaped keys:
 *
 *   - **DESC** (today's encoding): keys are
 *     `${timestamp(millis)}_<sess>_${countKey(seq)}` — the production
 *     encoder, descending base-32 at `COUNT_BIT_WIDTH`.
 *     The reader's "fetch K newest" is one `Storage.list(prefix,
 *     {maxKeys: K})` — bytes listed scales with K.
 *   - **ASC** (counterfactual baseline): same key shape and the same
 *     seq width, but ascending base-32 —
 *     `${uint2str(millis,42)}_<sess>_${uint2str(seq,COUNT_BIT_WIDTH)}`.
 *     `Storage.list` is forward-lex so "fetch K newest" requires
 *     listing the full N-sized prefix and reversing-and-truncating
 *     in memory — bytes listed scales with N.
 *
 * "Bytes listed" is defined as `Σ key.length` across the
 * `StorageListEntry`s yielded by `Storage.list`. This isolates the
 * keyspace cost (the dominant variable cost of S3's
 * `ListObjectsV2` XML response — etag/size/last-modified are
 * fixed-size per entry). It does NOT model the network framing
 * overhead of S3's XML envelope; the ratio between the two arms
 * is what matters for the patent claim, not absolute byte counts.
 *
 * Grid: K ∈ {10, 100, 1000, 10000}, N = 100_000. One JSON file per
 * run to `bench/results/lsn-reverse-walk/`. Prints one summary
 * line per K cell to stdout.
 *
 * Reproduction: `pnpm bench:lsn-reverse-walk`. Seeded so two runs
 * on the same machine produce identical numbers; the seed is
 * captured in the result JSON.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { COUNT_BIT_WIDTH, MemoryStorage, countKey, uint2str, timestamp } from "@baerly/protocol";

/** Bench config. Pinned constants — tweak in the source if needed. */
const POPULATION_N = 100_000;
const K_GRID = [10, 100, 1000, 10000] as const;
const SESSION = "bench00"; // 7 hex chars; the bench doesn't care about session validation
const PREFIX = "lsn-reverse-walk/";
const SEED = 0x5eed_5eed; // any 32-bit constant; reproduction handle

/**
 * Mulberry32 PRNG — small, seedable, no deps. We don't need
 * cryptographic quality; we need deterministic input across
 * runs so the result JSON is comparable.
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

interface CellResult {
  readonly k: number;
  readonly desc_bytes_listed: number;
  readonly desc_keys_listed: number;
  readonly asc_bytes_listed: number;
  readonly asc_keys_listed: number;
  /** desc / asc — lower is better (less bytes listed). */
  readonly bytes_ratio: number;
  /** (1 - desc/asc) — fraction of bytes saved by the DESC encoding. */
  readonly bytes_saved_fraction: number;
}

interface RunResult {
  readonly schema_version: 1;
  readonly population_n: number;
  readonly seed: number;
  readonly k_grid: readonly number[];
  readonly metric: "sum_of_key_lengths_yielded_by_storage_list";
  readonly cells: readonly CellResult[];
  readonly timestamp_iso: string;
  readonly node_version: string;
}

/**
 * Generate POPULATION_N (millis, seq) tuples deterministically.
 * Millis drifts monotonically with jitter so writes interleave
 * across the time domain; seq cycles through a small bounded range
 * so keys vary in the seq segment. The exact seq value doesn't
 * affect key length — every seq encodes to a fixed
 * `Math.ceil(COUNT_BIT_WIDTH / 5)`-char segment in both arms.
 */
const generatePoints = (): Array<{ millis: number; seq: number }> => {
  const rng = mulberry32(SEED);
  const points: Array<{ millis: number; seq: number }> = [];
  let m = 1_700_000_000_000;
  for (let i = 0; i < POPULATION_N; i++) {
    // Random drift 0..7 ms per write; occasionally jump 1s to
    // simulate clusters of writes within the same epoch second.
    m += Math.floor(rng() * 8);
    if (rng() < 0.001) {
      m += 1000;
    }
    points.push({ millis: m, seq: i % 1024 });
  }
  return points;
};

/** DESC arm: `<timestamp(millis)>_<sess>_<countKey(seq)>` — the production encoder. */
const encodeDesc = (p: { millis: number; seq: number }): string =>
  `${timestamp(p.millis)}_${SESSION}_${countKey(p.seq)}`;

/**
 * ASC arm: same key shape and the SAME seq width as DESC
 * (`COUNT_BIT_WIDTH`), but ascending base-32 (no max-value
 * subtraction). Both arms must encode the seq segment at one width
 * or the bytes-listed comparison stops being apples-to-apples —
 * `countKey` derives its width from `COUNT_BIT_WIDTH`, so this arm
 * does too.
 */
const encodeAsc = (p: { millis: number; seq: number }): string =>
  `${uint2str(p.millis, 42)}_${SESSION}_${uint2str(p.seq, COUNT_BIT_WIDTH)}`;

/** Sum of key string lengths yielded by `Storage.list` for K newest. */
const measureDescBytes = async (
  storage: MemoryStorage,
  k: number,
): Promise<{ bytes: number; keys: number }> => {
  let bytes = 0;
  let keys = 0;
  for await (const entry of storage.list(PREFIX, { maxKeys: k })) {
    bytes += entry.key.length;
    keys += 1;
  }
  return { bytes, keys };
};

/**
 * ASC arm: no `maxKeys` shortcut — the reader doesn't know which
 * end of the lex-asc list is newest until it sees them all. List
 * the full prefix, then in-memory reverse + truncate to K.
 * "Bytes listed" counts the bytes the reader paid to receive
 * from `Storage.list`, BEFORE the in-memory truncation.
 */
const measureAscBytes = async (
  storage: MemoryStorage,
): Promise<{ bytes: number; keys: number }> => {
  let bytes = 0;
  let keys = 0;
  for await (const entry of storage.list(PREFIX)) {
    bytes += entry.key.length;
    keys += 1;
  }
  return { bytes, keys };
};

const main = async (): Promise<number> => {
  const startedAt = Date.now();
  const points = generatePoints();

  // Build the two MemoryStorage buckets up front. We populate each
  // arm in its own bucket so the bench isn't measuring fixture
  // teardown.
  const descStore = new MemoryStorage();
  const ascStore = new MemoryStorage();
  for (const p of points) {
    await descStore.put(PREFIX + encodeDesc(p), new Uint8Array(0));
    await ascStore.put(PREFIX + encodeAsc(p), new Uint8Array(0));
  }

  const cells: CellResult[] = [];
  // ASC arm: bytes listed is invariant in K (the full prefix is
  // always listed); measure once and reuse the number across K.
  const ascResult = await measureAscBytes(ascStore);
  for (const k of K_GRID) {
    const desc = await measureDescBytes(descStore, k);
    const ratio = desc.bytes / ascResult.bytes;
    cells.push({
      k,
      desc_bytes_listed: desc.bytes,
      desc_keys_listed: desc.keys,
      asc_bytes_listed: ascResult.bytes,
      asc_keys_listed: ascResult.keys,
      bytes_ratio: ratio,
      bytes_saved_fraction: 1 - ratio,
    });
  }

  const result: RunResult = {
    schema_version: 1,
    population_n: POPULATION_N,
    seed: SEED,
    k_grid: K_GRID,
    metric: "sum_of_key_lengths_yielded_by_storage_list",
    cells,
    timestamp_iso: new Date(startedAt).toISOString(),
    node_version: process.version,
  };

  const outDir = "bench/results/lsn-reverse-walk";
  await mkdir(outDir, { recursive: true });
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  const out = path.join(outDir, `lsn-reverse-walk-${stamp}.json`);
  await writeFile(out, JSON.stringify(result, null, 2));

  for (const cell of cells) {
    console.log(
      `K=${cell.k.toString().padStart(5)}: ` +
        `desc=${cell.desc_bytes_listed.toString().padStart(8)}B ` +
        `asc=${cell.asc_bytes_listed.toString().padStart(8)}B ` +
        `ratio=${cell.bytes_ratio.toFixed(5)} ` +
        `saved=${(cell.bytes_saved_fraction * 100).toFixed(2)}%`,
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
