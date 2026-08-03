/**
 * Fold-ceiling headroom probe.
 *
 * ONE QUESTION: how much larger can `C` (snapshot bytes) and `E` (snapshot rows)
 * be, per host profile, before one unsliceable fold stops fitting inside that
 * host's CPU and memory budget?
 *
 * WHY IT EXISTS. `packages/server/src/maintenance.ts` gates a fold on
 * `snapshotBytes <= C && snapshotRows + maxFoldEntriesPerPass <= E`. Crossing it
 * defers compaction permanently: the tail grows without bound and the collection
 * must graduate. All three shipped profiles use identical ceilings
 * (`C = 512 KiB`, `E = 2048`), even though `docs/about/graduation.md` gives
 * Cloudflare paid a 30 s CPU budget against Cloudflare free's ~10 ms.
 * `MAINTENANCE_MAX_FOLD_ROWS`'s own JSDoc says `PROVISIONAL — bench landed; paid
 * recalibration deferred`.
 *
 * RELATIONSHIP TO `bench/fold-cost.ts`. That bench established the METHOD (CPU
 * via `process.cpuUsage()` deltas, peak heap via a 1 ms `heapUsed` sampler,
 * median over N iterations after warmup) and a 12-cell grid tied to the
 * `graduation.md` table. This probe REUSES its fixture builder and sampler
 * verbatim — literally the same `bench/lib/fold-fixture.ts` module, so same seed,
 * same tail length, same measurement definitions, and the two are directly
 * comparable — and extends the grid where the decision needs resolution. That
 * bench's checked-in baseline is FROZEN and is never rewritten; this probe writes
 * a separate attachment.
 *
 * WHAT IS NEW IN THE GRID, and why:
 *   - **bytes axis, 2/3/4 MB** — the frozen baseline jumps 1 MB (2.59 ms) to
 *     5 MB (45.0 ms). That is superlinear with nothing in between, and the shape
 *     of that knee decides how far `C` can move.
 *   - **bytes axis, 8/16/32 MB** — Cloudflare paid's wall is ~128 MB of Worker
 *     memory, not CPU. At the frozen baseline's ~2.4x peak-over-snapshot ratio a
 *     32 MB snapshot lands near 77 MB peak, which is where the paid answer
 *     actually is. Nothing above 5 MB has ever been measured.
 *   - **rows axis, 32k/64k/128k** — the frozen baseline stops at 16384 rows
 *     (10.28 ms), just past the CF-free line. Where per-entry cost walls on PAID
 *     is unmeasured. NOTE: at 64 B/doc, 128k rows is an ~8 MB snapshot, so byte
 *     cost contaminates the top of this axis; the cross axis is what
 *     disambiguates.
 *   - **cross axis (NEW)** — the real predicate is a CONJUNCTION over both axes,
 *     but the frozen baseline measures each axis with the other held
 *     deliberately unloaded (2048 B/doc on bytes, 64 B/doc on rows). A workload
 *     with many medium documents loads both. These cells are the only ones that
 *     resemble the predicate the runtime actually evaluates.
 *
 * ITERATION SCALING. Big cells are slow (a 32 MB fold, warmed and measured 16
 * times, is minutes). Cells at or above `LARGE_CELL_BYTES` drop to
 * `LARGE_WARMUP_ITERS` / `LARGE_MEASURE_ITERS`. Per-cell `iterations` is recorded
 * so a reader can see which cells are noisier.
 *
 * MARGINS, NOT A VERDICT. Today's `C` sits at a wide margin under the CF-free CPU
 * line. Picking a new margin is a human risk decision, not a measurement, so the
 * table is reported at 2x, 4x, and 7x and the recommendation record names an
 * owner rather than choosing.
 *
 * MEASURES ONLY. Changes no constant, no profile, no production behaviour.
 *
 * This module has NO module-scope side effects — the test imports it. The
 * runnable entrypoint is `bench/measurement/fold-ceiling-probe-run.ts`.
 */
import {
  CF_FREE_MAX_SAFE_FOLD_BYTES,
  MAINTENANCE_MAX_FOLD_BYTES_DEFAULT,
  MAINTENANCE_MAX_FOLD_ROWS,
  NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS,
  WRITE_TICK_FOLD_ENTRIES_PER_PASS,
} from "@baerly/protocol";
import { TAIL_ENTRIES, buildFixture, measureOneFold, median } from "../lib/fold-fixture.ts";

export const FOLD_CEILING_PROBE_VERSION = "baerly.fold-ceiling-probe/v1" as const;

export interface HostBudget {
  readonly profile: "cf-free" | "cf-paid" | "node";
  /** Per-invocation CPU budget in ms. */
  readonly cpu_ms: number;
  /** Per-isolate memory budget in bytes. */
  readonly memory_bytes: number;
  /** Where the number comes from, so a reader can re-derive it. */
  readonly source: string;
}

/**
 * From `docs/about/graduation.md`. Node has no platform-imposed CPU or memory
 * limit, so its row is a STATED ASSUMPTION about a modest container, not a
 * platform fact — flagged as such in `source` so nobody quotes it as one.
 */
export const HOST_BUDGETS: readonly HostBudget[] = [
  {
    profile: "cf-free",
    cpu_ms: 10,
    memory_bytes: 128 * 1024 * 1024,
    source: "graduation.md — ~10 ms CPU/request, 128 MB isolate",
  },
  {
    profile: "cf-paid",
    cpu_ms: 30_000,
    memory_bytes: 128 * 1024 * 1024,
    source: "graduation.md — 30 s CPU default, ~128 MB Worker memory (memory is the wall)",
  },
  {
    profile: "node",
    cpu_ms: 30_000,
    memory_bytes: 512 * 1024 * 1024,
    source: "ASSUMPTION, not a platform limit: a modest 512 MB container, 30 s request budget",
  },
];

/** 7x is today's de facto margin at `C`; 2x and 4x bracket a loosening. */
export const REPORTED_MARGINS: readonly number[] = [2, 4, 7];

const BYTES_PER_DOC = 2048;
const ROWS_AXIS_BYTES_PER_DOC = 64;

const WARMUP_ITERS = 5;
const MEASURE_ITERS = 11;
const LARGE_CELL_BYTES = 8 * 1024 * 1024;
const LARGE_WARMUP_ITERS = 2;
/**
 * 9, not 5. Large cells are the ones that lose peak samples to the GC floor
 * (see {@link isPeakSampleUsable}), and a 5-sample median can be carried by
 * floored samples outright — which is how the first run of this grid reported a
 * 0.03 MB peak for a 16 MB fold. 9 leaves a usable median after several discards.
 */
const LARGE_MEASURE_ITERS = 9;

/** Byte axis: extends the frozen grid through the 1-5 MB knee and up to the paid memory wall. */
const BYTES_AXIS_TARGETS: ReadonlyArray<{ label: string; bytes: number }> = [
  { label: "512KB", bytes: 512 * 1024 }, // = C today; overlap cell, cross-checks the frozen baseline
  { label: "1MB", bytes: 1024 * 1024 }, // = CF_FREE_MAX_SAFE_FOLD_BYTES warn threshold; also an overlap cell
  { label: "2MB", bytes: 2 * 1024 * 1024 }, // NEW — knee
  { label: "3MB", bytes: 3 * 1024 * 1024 }, // NEW — knee
  { label: "4MB", bytes: 4 * 1024 * 1024 }, // NEW — knee
  { label: "5MB", bytes: 5 * 1024 * 1024 }, // overlap cell with the frozen baseline
  { label: "8MB", bytes: 8 * 1024 * 1024 }, // NEW
  { label: "16MB", bytes: 16 * 1024 * 1024 }, // NEW
  { label: "32MB", bytes: 32 * 1024 * 1024 }, // NEW — near the ~128 MB paid memory wall
];

/** Rows axis: extends past the frozen grid's 16384 to find the paid per-entry wall. */
const ROWS_AXIS_ROW_COUNTS: readonly number[] = [
  MAINTENANCE_MAX_FOLD_ROWS, // 2048 — overlap cell
  8192, // overlap cell
  16_384, // overlap cell — the frozen grid's top
  32_768, // NEW
  65_536, // NEW
  131_072, // NEW — ~8 MB at 64 B/doc; byte cost starts to contaminate
];

/**
 * Cross axis: both axes loaded at once, which is what `foldViable` actually
 * gates on. No cell here exists in the frozen baseline.
 */
const CROSS_AXIS_CELLS: ReadonlyArray<{ label: string; rows: number; bytesPerDoc: number }> = [
  { label: "4k x 1KB", rows: 4096, bytesPerDoc: 1024 },
  { label: "16k x 512B", rows: 16_384, bytesPerDoc: 512 },
  { label: "65k x 256B", rows: 65_536, bytesPerDoc: 256 },
];

export interface ProbeCell {
  readonly axis: "bytes" | "rows" | "cross";
  readonly label: string;
  readonly rows: number;
  readonly bytes_per_doc: number;
  readonly snapshot_bytes: number;
  readonly tail_entries: number;
  readonly iterations: number;
  readonly cpu_ms_median: number;
  readonly peak_bytes_median: number;
  readonly peak_over_snapshot: number;
  /**
   * Peak samples discarded as GC-floored (see {@link isPeakSampleUsable}). A
   * non-zero value means this cell's `peak_bytes_median` is a median over fewer
   * than `iterations` samples and is correspondingly noisier.
   */
  readonly peak_samples_discarded: number;
}

/**
 * A fold must hold at least one copy of the snapshot resident, so a sampled
 * peak-heap delta BELOW the snapshot size is not a measurement — it is the
 * GC artifact `bench/fold-cost.ts` documents: `peakBytes` is
 * `max(sample) - heapUsedAtStart`, so a `heapStart` captured at a pre-GC
 * high-water mark floors the whole fold to ~0.
 *
 * Observed on this grid: bytes/16MB reported a 0.03 MB peak against a 16.24 MB
 * snapshot while its 8 MB and 32 MB neighbours both sat at ~2.1-2.4x. At 11
 * iterations the median absorbs an occasional floored sample; at the large
 * cells' lower iteration count it does not, and a floored median silently
 * passes the memory test and inflates the reported ceiling.
 *
 * Discarding is deliberately conservative — only physically impossible samples
 * go — and the count is recorded per cell rather than hidden. The measurement
 * definition in `bench/lib/fold-fixture.ts` is untouched, so cells remain
 * directly comparable to the frozen `fold-cost-baseline.json`.
 */
export const isPeakSampleUsable = (peakBytes: number, snapshotBytes: number): boolean =>
  peakBytes >= snapshotBytes;

export interface SustainableCeiling {
  readonly profile: HostBudget["profile"];
  readonly margin: number;
  /** Largest measured snapshot_bytes whose cell fits cpu AND memory at margin. */
  readonly max_c_bytes: number | null;
  /** Largest measured row count whose cell fits cpu AND memory at margin. */
  readonly max_e_rows: number | null;
  readonly binding_axis: "cpu" | "memory" | "grid-exhausted" | "none";
  /** max_c_bytes / MAINTENANCE_MAX_FOLD_BYTES_DEFAULT, or null. */
  readonly c_multiple_of_today: number | null;
  /** max_e_rows / MAINTENANCE_MAX_FOLD_ROWS, or null. */
  readonly e_multiple_of_today: number | null;
}

const fits = (cell: ProbeCell, budget: HostBudget, margin: number): boolean =>
  cell.cpu_ms_median * margin <= budget.cpu_ms &&
  cell.peak_bytes_median * margin <= budget.memory_bytes;

/**
 * Which resource stopped us. Evaluated on the SMALLEST cell that did not fit —
 * the first wall encountered walking up the grid, not the worst violation
 * anywhere in it.
 */
const bindingFor = (cell: ProbeCell, budget: HostBudget, margin: number): "cpu" | "memory" =>
  cell.cpu_ms_median * margin > budget.cpu_ms ? "cpu" : "memory";

/**
 * Pure. Given measured cells and one budget, the largest cell on each axis whose
 * `cpu_ms_median * margin <= budget.cpu_ms` AND
 * `peak_bytes_median * margin <= budget.memory_bytes`.
 *
 * `binding_axis` is `"grid-exhausted"` when the LARGEST measured cell still fits
 * — the true ceiling is above the grid and the answer is a lower bound.
 */
export const largestSustainable = (input: {
  readonly cells: readonly ProbeCell[];
  readonly budget: HostBudget;
  readonly margin: number;
}): SustainableCeiling => {
  const { budget, margin } = input;

  // `C` is read from the bytes axis (rows deliberately unloaded); `E` from the
  // rows and cross axes (bytes deliberately small, or both loaded). Reading `E`
  // off a bytes-axis cell would credit a huge row count that was never
  // per-entry-stressed.
  const byBytes = input.cells.filter((c) => c.axis === "bytes");
  const byRows = input.cells.filter((c) => c.axis === "rows" || c.axis === "cross");

  const fittingBytes = byBytes.filter((c) => fits(c, budget, margin));
  const fittingRows = byRows.filter((c) => fits(c, budget, margin));

  const maxC =
    fittingBytes.length === 0 ? null : Math.max(...fittingBytes.map((c) => c.snapshot_bytes));
  const maxE = fittingRows.length === 0 ? null : Math.max(...fittingRows.map((c) => c.rows));

  const all = [...input.cells].toSorted((a, b) => a.snapshot_bytes - b.snapshot_bytes);
  const firstMiss = all.find((c) => !fits(c, budget, margin));

  let binding: SustainableCeiling["binding_axis"];
  if (firstMiss === undefined) {
    binding = "grid-exhausted";
  } else if (maxC === null && maxE === null) {
    binding = "none";
  } else {
    binding = bindingFor(firstMiss, budget, margin);
  }

  return {
    profile: budget.profile,
    margin,
    max_c_bytes: maxC,
    max_e_rows: maxE,
    binding_axis: binding,
    c_multiple_of_today: maxC === null ? null : maxC / MAINTENANCE_MAX_FOLD_BYTES_DEFAULT,
    e_multiple_of_today: maxE === null ? null : maxE / MAINTENANCE_MAX_FOLD_ROWS,
  };
};

/** Measured cost at today's shipped ceilings, per budget. */
export interface TodayHeadroom {
  readonly profile: HostBudget["profile"];
  readonly at_c_cpu_ms: number;
  readonly at_c_peak_bytes: number;
  readonly at_e_cpu_ms: number;
  readonly at_e_peak_bytes: number;
  readonly cpu_margin_at_c: number;
  readonly cpu_margin_at_e: number;
  readonly memory_margin_at_c: number;
  readonly memory_margin_at_e: number;
}

/** The largest cell on `axis` at or below `limit`, or the smallest if none is. */
const nearestAtOrBelow = (
  cells: readonly ProbeCell[],
  axis: ProbeCell["axis"],
  key: (c: ProbeCell) => number,
  limit: number,
): ProbeCell | undefined => {
  const on = cells.filter((c) => c.axis === axis).toSorted((a, b) => key(a) - key(b));
  const under = on.filter((c) => key(c) <= limit);
  return under.length > 0 ? under[under.length - 1] : on[0];
};

export const todayHeadroom = (input: {
  readonly cells: readonly ProbeCell[];
  readonly budget: HostBudget;
}): TodayHeadroom => {
  const atC = nearestAtOrBelow(
    input.cells,
    "bytes",
    (c) => c.snapshot_bytes,
    MAINTENANCE_MAX_FOLD_BYTES_DEFAULT,
  );
  const atE = nearestAtOrBelow(input.cells, "rows", (c) => c.rows, MAINTENANCE_MAX_FOLD_ROWS);
  if (atC === undefined || atE === undefined) {
    throw new Error("fold-ceiling-probe: cells must cover both the bytes and rows axes");
  }
  return {
    profile: input.budget.profile,
    at_c_cpu_ms: atC.cpu_ms_median,
    at_c_peak_bytes: atC.peak_bytes_median,
    at_e_cpu_ms: atE.cpu_ms_median,
    at_e_peak_bytes: atE.peak_bytes_median,
    cpu_margin_at_c: input.budget.cpu_ms / atC.cpu_ms_median,
    cpu_margin_at_e: input.budget.cpu_ms / atE.cpu_ms_median,
    memory_margin_at_c: input.budget.memory_bytes / atC.peak_bytes_median,
    memory_margin_at_e: input.budget.memory_bytes / atE.peak_bytes_median,
  };
};

export interface ProbeRecommendation {
  readonly schema: typeof FOLD_CEILING_PROBE_VERSION;
  readonly subject_commit: string;
  readonly node_version: string;
  readonly platform: string;
  readonly arch: string;
  readonly todays_ceilings: { readonly c_bytes: number; readonly e_rows: number };
  readonly budgets: readonly HostBudget[];
  readonly margins: readonly number[];
  readonly cells: readonly ProbeCell[];
  readonly today_headroom: readonly TodayHeadroom[];
  readonly sustainable: readonly SustainableCeiling[];
  /** Free-text findings the probe is confident enough to assert. */
  readonly findings: readonly string[];
  /** Changes this probe RECOMMENDS but does not make. Owner named per entry. */
  readonly recommended_changes: readonly {
    readonly file: string;
    readonly change: string;
    readonly owner: string;
    readonly blocked_by: string | null;
  }[];
}

const mb = (b: number): string => (b / (1024 * 1024)).toFixed(2);

const msPerMb = (c: ProbeCell): number => c.cpu_ms_median / (c.snapshot_bytes / (1024 * 1024));

/** Nearest cell on `axis` to `bytes`, by absolute snapshot-size distance. */
const nearestBySize = (
  cells: readonly ProbeCell[],
  axis: ProbeCell["axis"],
  bytes: number,
): ProbeCell | undefined =>
  cells
    .filter((c) => c.axis === axis)
    .toSorted((a, b) => Math.abs(a.snapshot_bytes - bytes) - Math.abs(b.snapshot_bytes - bytes))[0];

/**
 * Findings DERIVED from the cells in the same record, never hand-transcribed.
 *
 * The plan asks for findings that are "independently checkable against the
 * `cells` array in the same record". Hard-coding numbers read off one run makes
 * that false the moment the probe is re-run — the record would carry prose from
 * one measurement and cells from another. Deriving them makes the two
 * inseparable by construction.
 */
export const deriveFindings = (cells: readonly ProbeCell[]): readonly string[] => {
  const findings: string[] = [];

  // 1. Measured margin at today's shipped ceilings, per profile.
  for (const budget of HOST_BUDGETS) {
    const head = todayHeadroom({ cells, budget });
    findings.push(
      `${budget.profile}: at today's C the fold costs ${head.at_c_cpu_ms.toFixed(2)} ms and ` +
        `${(head.at_c_peak_bytes / (1024 * 1024)).toFixed(2)} MB peak — ` +
        `${head.cpu_margin_at_c.toFixed(1)}x CPU margin, ${head.memory_margin_at_c.toFixed(1)}x memory margin. ` +
        `At today's E it costs ${head.at_e_cpu_ms.toFixed(2)} ms and ` +
        `${(head.at_e_peak_bytes / (1024 * 1024)).toFixed(2)} MB peak — ` +
        `${head.cpu_margin_at_e.toFixed(1)}x CPU, ${head.memory_margin_at_e.toFixed(1)}x memory.`,
    );
  }

  // 2. Where the bytes-axis cost-per-MB knee starts.
  const byBytes = cells
    .filter((c) => c.axis === "bytes")
    .toSorted((a, b) => a.snapshot_bytes - b.snapshot_bytes);
  const knee = byBytes.find(
    (c, i) => i > 0 && msPerMb(c) > 1.25 * Math.min(...byBytes.slice(0, i).map(msPerMb)),
  );
  if (knee === undefined) {
    findings.push(
      "bytes axis: no cost-per-MB knee in the measured range — CPU stays within 1.25x of its " +
        "cheapest per-MB rate across the whole grid.",
    );
  } else {
    const before = byBytes[byBytes.indexOf(knee) - 1];
    findings.push(
      `bytes axis: the cost-per-MB knee is REAL and starts between ` +
        `${mb(before?.snapshot_bytes ?? 0)} MB (${msPerMb(before ?? knee).toFixed(2)} ms/MB) and ` +
        `${mb(knee.snapshot_bytes)} MB (${msPerMb(knee).toFixed(2)} ms/MB). ` +
        `Series, ms/MB: ${byBytes.map((c) => `${c.label}=${msPerMb(c).toFixed(1)}`).join(", ")}.`,
    );
  }

  // 3. The paid ceiling, marked as a lower bound when the grid ran out first.
  for (const margin of REPORTED_MARGINS) {
    const paid = largestSustainable({
      cells,
      budget: HOST_BUDGETS.find((b) => b.profile === "cf-paid") ?? HOST_BUDGETS[0]!,
      margin,
    });
    const bound = paid.binding_axis === "grid-exhausted" ? "LOWER BOUND (grid exhausted)" : "wall";
    findings.push(
      `cf-paid @${margin}x margin: C ${paid.max_c_bytes === null ? "-" : `${mb(paid.max_c_bytes)} MB`} ` +
        `(${paid.c_multiple_of_today === null ? "-" : `${paid.c_multiple_of_today.toFixed(1)}x`} today), ` +
        `E ${paid.max_e_rows ?? "-"} rows ` +
        `(${paid.e_multiple_of_today === null ? "-" : `${paid.e_multiple_of_today.toFixed(1)}x`} today), ` +
        `bound by ${paid.binding_axis} — ${bound}.`,
    );
  }

  // 4. THE decisive one: does a two-way (C, E) ceiling describe the cost surface?
  for (const cross of cells.filter((c) => c.axis === "cross")) {
    const peer = nearestBySize(cells, "bytes", cross.snapshot_bytes);
    if (peer === undefined) {
      continue;
    }
    findings.push(
      `cross ${cross.label} (${cross.rows} rows x ${cross.bytes_per_doc} B, ${mb(cross.snapshot_bytes)} MB) ` +
        `vs the nearest bytes-axis cell ${peer.label} (${peer.rows} rows x ${peer.bytes_per_doc} B, ` +
        `${mb(peer.snapshot_bytes)} MB): CPU ${cross.cpu_ms_median.toFixed(1)} ms vs ` +
        `${peer.cpu_ms_median.toFixed(1)} ms (${(cross.cpu_ms_median / peer.cpu_ms_median).toFixed(2)}x), ` +
        `peak ${mb(cross.peak_bytes_median)} MB vs ${mb(peer.peak_bytes_median)} MB ` +
        `(${(cross.peak_bytes_median / peer.peak_bytes_median).toFixed(2)}x). ` +
        `peak/snapshot ${cross.peak_over_snapshot.toFixed(2)} vs ${peer.peak_over_snapshot.toFixed(2)}.`,
    );
  }

  // 5. Sample hygiene — how much of the grid needed GC-floored samples dropped.
  const dropped = cells.filter((c) => c.peak_samples_discarded > 0);
  findings.push(
    `peak-sample hygiene: ${dropped.length} of ${cells.length} cells lost at least one ` +
      `GC-floored peak sample (see isPeakSampleUsable); worst cell dropped ` +
      `${Math.max(0, ...cells.map((c) => c.peak_samples_discarded))} of its samples. ` +
      `CPU is unaffected — cpuUsage() deltas have no baseline to float.`,
  );

  return findings;
};

/**
 * One cell of the frozen `fold-cost` baseline
 * (`docs/spec/attachments/fold-cost-baseline.json`). Only the fields the
 * overlap comparison reads are declared; the file carries more.
 */
export interface FrozenBaselineCell {
  readonly axis: string;
  readonly rows: number;
  readonly bytes_per_doc: number;
  readonly snapshot_bytes: number;
  readonly cpu_ms_median: number;
  readonly peak_bytes_median: number;
}

/**
 * Narrow a parsed JSON document to its `cells` array, THROWING when it is
 * absent rather than asserting the shape and letting `undefined` through.
 *
 * A bare `parsed as { cells: T[] }` succeeds on any valid JSON, so a file
 * without `cells` yields `undefined` typed as an array and defers the failure
 * to the first `.find` / `.length` — as an uncaught `TypeError`, at a call site
 * chosen by luck rather than by the caller. Lives here rather than in the
 * runner because the runner ends in a module-scope `await main()`: nothing can
 * import it, so nothing there can be tested.
 *
 * Checks that `cells` is an array and NOT the shape of each element. Both
 * callers read a file this probe itself wrote, so the array check is what
 * separates "wrong file" from "our file"; a per-field schema would be
 * validating our own serializer.
 */
export const cellsOf = <T>(parsed: unknown, source: string): readonly T[] => {
  const cells = (parsed as { cells?: unknown } | null)?.cells;
  if (!Array.isArray(cells)) {
    throw new TypeError(`${source}: expected a "cells" array, got ${typeof cells}`);
  }
  return cells as readonly T[];
};

/** Range of a ratio series, e.g. `1.42x-2.49x`. */
const span = (xs: readonly number[]): string =>
  `${Math.min(...xs).toFixed(2)}x-${Math.max(...xs).toFixed(2)}x`;

/**
 * Overlap-cell divergence against the frozen `fold-cost` baseline. Comparing
 * the shared cells is the only check that the fixture builder, the seed, and
 * the measurement definitions still mean what they meant in June 2026.
 *
 * Pure, and here rather than in the runner, so it can be tested: the runner
 * owns the file read and passes the parsed cells in.
 *
 * `snapshot_bytes` is seeded and MUST match exactly. `peak_bytes_median` is an
 * allocation measurement and should track closely. `cpu_ms_median` is
 * host-specific and is expected to differ — how much it differs is precisely
 * what tells a reader how far to trust this run's CPU-bound verdicts.
 */
export const compareToFrozen = (
  cells: readonly ProbeCell[],
  frozen: readonly FrozenBaselineCell[],
): readonly string[] => {
  const mismatched: string[] = [];
  const cpuRatios: number[] = [];
  const peakRatios: number[] = [];
  let compared = 0;
  for (const cell of cells) {
    const peer = frozen.find(
      (f) => f.axis === cell.axis && f.rows === cell.rows && f.bytes_per_doc === cell.bytes_per_doc,
    );
    if (peer === undefined) {
      continue;
    }
    compared += 1;
    if (peer.snapshot_bytes !== cell.snapshot_bytes) {
      mismatched.push(
        `${cell.axis}/${cell.label} ${cell.snapshot_bytes} != ${peer.snapshot_bytes}`,
      );
    }
    cpuRatios.push(cell.cpu_ms_median / peer.cpu_ms_median);
    peakRatios.push(cell.peak_bytes_median / peer.peak_bytes_median);
  }

  if (compared === 0) {
    return ["overlap check SKIPPED: no cell in this grid also exists in the frozen baseline."];
  }
  const bytesVerdict =
    mismatched.length === 0
      ? "snapshot_bytes matches the frozen baseline EXACTLY on all of them (same seed, same builder)"
      : `snapshot_bytes DIVERGES on ${mismatched.length} cell(s): ${mismatched.join("; ")} — treat this whole run as suspect`;
  // DERIVED, never transcribed — same rule this module states for its own
  // findings. A literal "THIS HOST IS SLOWER" here would invert the portability
  // caveat the moment the probe is re-run on faster hardware, in the one string
  // that tells a reader how far to trust the CPU rows.
  const slowest = Math.max(...cpuRatios);
  const fastest = Math.min(...cpuRatios);
  let direction: string;
  if (fastest > 1) {
    direction =
      "THIS HOST IS SLOWER than the host that produced the baseline, so CPU-bound verdicts " +
      "(the cf-free rows) are conservative on this hardware";
  } else if (slowest < 1) {
    direction =
      "THIS HOST IS FASTER than the host that produced the baseline, so CPU-bound verdicts " +
      "(the cf-free rows) are OPTIMISTIC on this hardware and must not be published as-is";
  } else {
    direction =
      "this host straddles the baseline (some cells faster, some slower), so the CPU-bound " +
      "verdicts (the cf-free rows) are not comparable cell-for-cell";
  }
  return [
    `overlap vs the frozen fold-cost baseline (${compared} shared cells): ${bytesVerdict}. ` +
      `peak_bytes_median ${span(peakRatios)} of frozen — allocation behaviour is unchanged. ` +
      `cpu_ms_median ${span(cpuRatios)} of frozen, so ${direction}. CPU-bound verdicts are NOT ` +
      `portable; the memory-bound verdicts (cf-paid) are.`,
  ];
};

export const buildRecommendation = (input: {
  readonly cells: readonly ProbeCell[];
  readonly subject_commit: string;
  /** Findings the RUNNER derives from inputs this pure module cannot read. */
  readonly extraFindings?: readonly string[];
}): ProbeRecommendation => {
  const sustainable: SustainableCeiling[] = [];
  for (const budget of HOST_BUDGETS) {
    for (const margin of REPORTED_MARGINS) {
      sustainable.push(largestSustainable({ cells: input.cells, budget, margin }));
    }
  }
  return {
    schema: FOLD_CEILING_PROBE_VERSION,
    subject_commit: input.subject_commit,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    todays_ceilings: {
      c_bytes: MAINTENANCE_MAX_FOLD_BYTES_DEFAULT,
      e_rows: MAINTENANCE_MAX_FOLD_ROWS,
    },
    budgets: HOST_BUDGETS,
    margins: REPORTED_MARGINS,
    cells: input.cells,
    today_headroom: HOST_BUDGETS.map((budget) => todayHeadroom({ cells: input.cells, budget })),
    sustainable,
    findings: [...deriveFindings(input.cells), ...(input.extraFindings ?? [])],
    // Every actionable output is a REQUEST with a named owner. This probe
    // changes nothing; `constants.ts` is held by a locked live session and
    // `maintenance.ts` belongs to the Protocol owner.
    recommended_changes: [
      {
        file: "packages/protocol/src/constants.ts",
        change:
          "Give MAINTENANCE_PROFILE_CF_PAID and MAINTENANCE_PROFILE_NODE their own " +
          "maxFoldBytes/maxFoldRows instead of sharing the CF-free values. See the " +
          "`sustainable` table for the measured room at each margin.",
        owner: "Protocol owner",
        blocked_by:
          "worktree-fix-issue-74-readpreimage-floor holds packages/protocol/src/constants.ts (locked live session)",
      },
      {
        file: "packages/server/src/maintenance.ts",
        change:
          "`E` has no operator override: the profile read takes `args.maxFoldBytes ?? " +
          "profile.maxFoldBytes` for C but plain `profile.maxFoldRows` for E. Add " +
          "BAERLY_MAINTENANCE_MAX_FOLD_ROWS to mirror the C override. " +
          "(Manifest §11 item 6.)",
        owner: "Protocol owner",
        blocked_by: null,
      },
      {
        file: "docs/about/graduation.md",
        change:
          "The `≈ 11 ms CPU per MB` model and the `1 MB | ~11 ms` table row overstate " +
          "measured cost. Restate against measurement, or mark the model as a " +
          "deliberate upper bound and say so.",
        owner: "Performance owner (graduation.md is a §6.2-owned product doc)",
        blocked_by: null,
      },
    ],
  };
};

export const renderTable = (rec: ProbeRecommendation): string => {
  const lines: string[] = [];
  lines.push("cells");
  lines.push(
    "axis   label        rows     snapMB   cpuMs(med)  peakMB(med)  peak/snap  iters  gcDrop",
  );
  for (const c of rec.cells) {
    lines.push(
      `${c.axis.padEnd(6)} ${c.label.padEnd(12)} ${String(c.rows).padStart(7)}  ` +
        `${mb(c.snapshot_bytes).padStart(7)}  ${c.cpu_ms_median.toFixed(3).padStart(10)}  ` +
        `${mb(c.peak_bytes_median).padStart(11)}  ${c.peak_over_snapshot.toFixed(2).padStart(9)}  ` +
        `${String(c.iterations).padStart(5)}  ${String(c.peak_samples_discarded).padStart(6)}`,
    );
  }
  lines.push("");
  lines.push(
    `today: C = ${mb(rec.todays_ceilings.c_bytes)} MB, E = ${rec.todays_ceilings.e_rows} rows`,
  );
  lines.push("profile   cpuMargin@C  cpuMargin@E  memMargin@C  memMargin@E");
  for (const h of rec.today_headroom) {
    lines.push(
      `${h.profile.padEnd(9)} ${h.cpu_margin_at_c.toFixed(1).padStart(11)}  ` +
        `${h.cpu_margin_at_e.toFixed(1).padStart(11)}  ` +
        `${h.memory_margin_at_c.toFixed(1).padStart(11)}  ` +
        `${h.memory_margin_at_e.toFixed(1).padStart(11)}`,
    );
  }
  lines.push("");
  lines.push("sustainable ceilings");
  lines.push("profile   margin  maxC(MB)  xToday  maxE(rows)  xToday  binding");
  for (const s of rec.sustainable) {
    const maxC = s.max_c_bytes === null ? "-" : mb(s.max_c_bytes);
    const xC = s.c_multiple_of_today === null ? "-" : `${s.c_multiple_of_today.toFixed(1)}x`;
    const maxE = s.max_e_rows === null ? "-" : String(s.max_e_rows);
    const xE = s.e_multiple_of_today === null ? "-" : `${s.e_multiple_of_today.toFixed(1)}x`;
    lines.push(
      `${s.profile.padEnd(9)} ${String(s.margin).padStart(6)}  ` +
        `${maxC.padStart(8)}  ${xC.padStart(6)}  ` +
        `${maxE.padStart(10)}  ${xE.padStart(6)}  ` +
        s.binding_axis,
    );
  }
  return lines.join("\n");
};

const runCell = async (
  axis: ProbeCell["axis"],
  label: string,
  rows: number,
  bytesPerDoc: number,
): Promise<ProbeCell> => {
  const probeBytes = rows * bytesPerDoc;
  const warmup = probeBytes >= LARGE_CELL_BYTES ? LARGE_WARMUP_ITERS : WARMUP_ITERS;
  const measure = probeBytes >= LARGE_CELL_BYTES ? LARGE_MEASURE_ITERS : MEASURE_ITERS;

  for (let i = 0; i < warmup; i++) {
    const fixture = await buildFixture(rows, bytesPerDoc);
    await measureOneFold(fixture.storage);
  }

  const cpu: number[] = [];
  const peak: number[] = [];
  let snapshotBytes = 0;
  for (let i = 0; i < measure; i++) {
    const fixture = await buildFixture(rows, bytesPerDoc);
    snapshotBytes = fixture.snapshotBytes;
    const one = await measureOneFold(fixture.storage);
    cpu.push(one.cpuMs);
    peak.push(one.peakBytes);
  }

  // Drop GC-floored peaks before taking the median; a floored sample is not a
  // small measurement, it is an absent one. CPU is unaffected — `cpuUsage()`
  // deltas have no baseline to float.
  const usablePeak = peak.filter((p) => isPeakSampleUsable(p, snapshotBytes));
  const peakMedian = usablePeak.length > 0 ? median(usablePeak) : median(peak);
  return {
    axis,
    label,
    rows,
    bytes_per_doc: bytesPerDoc,
    snapshot_bytes: snapshotBytes,
    tail_entries: TAIL_ENTRIES,
    iterations: measure,
    cpu_ms_median: median(cpu),
    peak_bytes_median: peakMedian,
    peak_over_snapshot: peakMedian / snapshotBytes,
    peak_samples_discarded: peak.length - usablePeak.length,
  };
};

/** Sweep the whole grid. Minutes — the 32 MB cell alone is 7 folds of 32 MB. */
export const runProbeGrid = async (
  onCell?: (cell: ProbeCell) => void,
): Promise<readonly ProbeCell[]> => {
  const cells: ProbeCell[] = [];
  const push = (cell: ProbeCell): void => {
    cells.push(cell);
    onCell?.(cell);
  };

  for (const target of BYTES_AXIS_TARGETS) {
    const rows = Math.max(1, Math.round(target.bytes / BYTES_PER_DOC));
    push(await runCell("bytes", target.label, rows, BYTES_PER_DOC));
  }
  for (const rows of ROWS_AXIS_ROW_COUNTS) {
    push(await runCell("rows", `${rows} rows`, rows, ROWS_AXIS_BYTES_PER_DOC));
  }
  for (const cross of CROSS_AXIS_CELLS) {
    push(await runCell("cross", cross.label, cross.rows, cross.bytesPerDoc));
  }
  return cells;
};

/** One line of shipped-constant context, printed under the table by the runner. */
export const referenceLine = (): string =>
  `reference: C default ${mb(MAINTENANCE_MAX_FOLD_BYTES_DEFAULT)} MB, ` +
  `CF-free warn threshold ${mb(CF_FREE_MAX_SAFE_FOLD_BYTES)} MB, ` +
  `E ${MAINTENANCE_MAX_FOLD_ROWS} rows, fold slice ` +
  `${WRITE_TICK_FOLD_ENTRIES_PER_PASS} (cf-free) / ` +
  `${NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS} (node)`;
