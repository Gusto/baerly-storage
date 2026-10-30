/**
 * Node-host fold measurements across byte, row, and mixed workload shapes.
 * Reuses the fixture and sampler from fold-cost.ts for host-scoped comparison.
 *
 * CPU is process.cpuUsage() on this Node host. Peak memory is a sampled heap
 * delta, not total process or Worker isolate memory. Neither measurement
 * establishes a production ceiling. Separate byte and row maxima also do not
 * establish a jointly safe workload envelope. Cloudflare admission belongs to
 * the workload-ceiling program's matched deployed study.
 *
 * No module-scope execution; fold-ceiling-probe-run.ts owns the sweep.
 */
import {
  CF_FREE_MAX_SAFE_FOLD_BYTES,
  MAINTENANCE_MAX_FOLD_BYTES_DEFAULT,
  MAINTENANCE_MAX_FOLD_ROWS,
  NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS,
  WRITE_TICK_FOLD_ENTRIES_PER_PASS,
} from "@baerly/protocol";
import { TAIL_ENTRIES, buildFixture, measureOneFold, median } from "../lib/fold-fixture.ts";

export const FOLD_CEILING_PROBE_VERSION = "baerly.fold-ceiling-probe/v2" as const;

const BYTES_PER_DOC = 2048;
const ROWS_AXIS_BYTES_PER_DOC = 64;

const WARMUP_ITERS = 5;
const MEASURE_ITERS = 11;
const LARGE_CELL_BYTES = 8 * 1024 * 1024;
const LARGE_WARMUP_ITERS = 2;
/** More large-cell samples leave room for GC-floor rejections. */
const LARGE_MEASURE_ITERS = 9;

/** Byte axis: extends the frozen grid through the 1-5 MB knee and larger snapshots. */
const BYTES_AXIS_TARGETS: ReadonlyArray<{ label: string; bytes: number }> = [
  { label: "512KB", bytes: 512 * 1024 }, // = C today; overlap cell, cross-checks the frozen baseline
  { label: "1MB", bytes: 1024 * 1024 }, // = CF_FREE_MAX_SAFE_FOLD_BYTES warn threshold; also an overlap cell
  { label: "2MB", bytes: 2 * 1024 * 1024 }, // NEW — knee
  { label: "3MB", bytes: 3 * 1024 * 1024 }, // NEW — knee
  { label: "4MB", bytes: 4 * 1024 * 1024 }, // NEW — knee
  { label: "5MB", bytes: 5 * 1024 * 1024 }, // overlap cell with the frozen baseline
  { label: "8MB", bytes: 8 * 1024 * 1024 }, // NEW
  { label: "16MB", bytes: 16 * 1024 * 1024 }, // NEW
  { label: "32MB", bytes: 32 * 1024 * 1024 }, // larger-snapshot cell
];

/** Rows axis: extends past the frozen grid's 16384 rows. */
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
 * Heuristic rejection for GC-floored heap deltas. The snapshot bytes are already
 * resident at the starting sample, so this threshold is not a physical lower
 * bound on incremental heap usage. Retained samples remain diagnostic only.
 */
export const isPeakSampleUsable = (peakBytes: number, snapshotBytes: number): boolean =>
  Number.isFinite(peakBytes) && peakBytes >= snapshotBytes;

export interface ProbeRecord {
  readonly schema: typeof FOLD_CEILING_PROBE_VERSION;
  readonly subject_commit: string;
  readonly node_version: string;
  readonly platform: string;
  readonly arch: string;
  readonly measurement_scope: "node-host-only";
  readonly cells: readonly ProbeCell[];
  readonly findings: readonly string[];
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
      `bytes axis: the measured cost-per-MB knee starts between ` +
        `${mb(before?.snapshot_bytes ?? 0)} MB (${msPerMb(before ?? knee).toFixed(2)} ms/MB) and ` +
        `${mb(knee.snapshot_bytes)} MB (${msPerMb(knee).toFixed(2)} ms/MB). ` +
        `Series, ms/MB: ${byBytes.map((c) => `${c.label}=${msPerMb(c).toFixed(1)}`).join(", ")}.`,
    );
  }

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

  // Report rejected samples alongside the retained host measurements.
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
 * host-specific and is expected to differ; the ratio helps interpret the
 * host measurements.
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
  const slowest = Math.max(...cpuRatios);
  const fastest = Math.min(...cpuRatios);
  let direction: string;
  if (fastest > 1) {
    direction = "THIS HOST IS SLOWER than the host that produced the baseline";
  } else if (slowest < 1) {
    direction = "THIS HOST IS FASTER than the host that produced the baseline";
  } else {
    direction = "this host straddles the baseline (some cells faster, some slower)";
  }
  return [
    `overlap vs the frozen fold-cost baseline (${compared} shared cells): ${bytesVerdict}. ` +
      `sampled heap delta ${span(peakRatios)} of frozen. ` +
      `cpu_ms_median ${span(cpuRatios)} of frozen, so ${direction}. ` +
      `These are Node-host comparisons; neither CPU nor heap deltas establish Worker limits.`,
  ];
};

export const buildRecord = (input: {
  readonly cells: readonly ProbeCell[];
  readonly subject_commit: string;
  readonly extraFindings?: readonly string[];
}): ProbeRecord => ({
  schema: FOLD_CEILING_PROBE_VERSION,
  subject_commit: input.subject_commit,
  node_version: process.version,
  platform: process.platform,
  arch: process.arch,
  measurement_scope: "node-host-only",
  cells: input.cells,
  findings: [...deriveFindings(input.cells), ...(input.extraFindings ?? [])],
});

export const renderTable = (rec: ProbeRecord): string => {
  const lines: string[] = [];
  lines.push("Node-host measurements only; no production ceiling recommendations");
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
  if (usablePeak.length === 0) {
    throw new Error(`fold-ceiling-probe: ${axis}/${label} has no usable peak samples`);
  }
  const peakMedian = median(usablePeak);
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
