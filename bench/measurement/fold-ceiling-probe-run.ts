/**
 * Runnable entrypoint for the fold-ceiling headroom probe.
 *
 * Thin by design: the grid, the verdict functions, and the record shape all
 * live in `./fold-ceiling-probe.ts`, which the test imports and which has no
 * module-scope side effects. This file is the only place that executes the
 * sweep, prints, and writes to disk — the same runner/library split
 * `bench/amortized-write-cost.ts` uses over `bench/lib/write-cost-measure.ts`.
 *
 *   BAERLY_SUBJECT_COMMIT=$(git rev-parse HEAD) \
 *     node --import ./bench/register-hooks.mjs \
 *       bench/measurement/fold-ceiling-probe-run.ts
 *
 * Takes minutes. Run it with nothing else competing for CPU; a parallel
 * `pnpm test` will corrupt the medians. (Observed: a run made while the
 * agent was writing files produced a non-monotonic CPU column — 3 MB and
 * 5 MB equal, 4 MB above both.)
 *
 * Set `BAERLY_FOLD_CEILING_CELLS=<record.json>` to re-derive the record from
 * an existing run's cells instead of re-measuring.
 *
 * MEASURES ONLY. Changes no constant, no profile, no production behaviour.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import {
  type ProbeCell,
  buildRecommendation,
  referenceLine,
  renderTable,
  runProbeGrid,
} from "./fold-ceiling-probe.ts";

/**
 * The frozen `fold-cost` baseline. Read-only, never rewritten — manifest §7
 * makes it byte-for-byte immutable. Five of this grid's cells also exist there,
 * and comparing them is the only check that the fixture builder, the seed, and
 * the measurement definitions still mean what they meant in June 2026.
 */
const FROZEN_BASELINE = "docs/spec/attachments/fold-cost-baseline.json";

interface FrozenCell {
  readonly axis: string;
  readonly rows: number;
  readonly bytes_per_doc: number;
  readonly snapshot_bytes: number;
  readonly cpu_ms_median: number;
  readonly peak_bytes_median: number;
}

/** Range of a ratio series, e.g. `1.42x-2.49x`. */
const span = (xs: readonly number[]): string =>
  `${Math.min(...xs).toFixed(2)}x-${Math.max(...xs).toFixed(2)}x`;

/**
 * Overlap-cell divergence against the frozen baseline. Computed here rather
 * than in the pure module because it reads a file the pure module must not.
 *
 * `snapshot_bytes` is seeded and MUST match exactly. `peak_bytes_median` is an
 * allocation measurement and should track closely. `cpu_ms_median` is
 * host-specific and is expected to differ — how much it differs is precisely
 * what tells a reader how far to trust this run's CPU-bound verdicts.
 */
const overlapFindings = async (cells: readonly ProbeCell[]): Promise<readonly string[]> => {
  let frozen: readonly FrozenCell[];
  try {
    const parsed: unknown = JSON.parse(await readFile(FROZEN_BASELINE, "utf8"));
    frozen = (parsed as { cells: readonly FrozenCell[] }).cells;
  } catch (error: unknown) {
    return [`overlap check SKIPPED: could not read ${FROZEN_BASELINE} (${String(error)}).`];
  }

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
  return [
    `overlap vs the frozen fold-cost baseline (${compared} shared cells): ${bytesVerdict}. ` +
      `peak_bytes_median ${span(peakRatios)} of frozen — allocation behaviour is unchanged. ` +
      `cpu_ms_median ${span(cpuRatios)} of frozen, so THIS HOST IS SLOWER than the host that ` +
      `produced the baseline. CPU-bound verdicts (the cf-free rows) are therefore conservative ` +
      `on this hardware and are NOT portable; the memory-bound verdicts (cf-paid) are.`,
  ];
};

const main = async (): Promise<number> => {
  // Re-derive the record from an existing run's cells instead of re-measuring.
  // The cells ARE the measurement; everything else in the record is a pure
  // function of them, so this reproduces a record exactly without spending
  // another multi-minute sweep on a possibly-contended machine.
  const reuse = process.env["BAERLY_FOLD_CEILING_CELLS"];
  let cells: readonly ProbeCell[];
  if (reuse === undefined || reuse === "") {
    // Progress as each cell lands, so a multi-minute run is not a blank screen.
    cells = await runProbeGrid((cell) => {
      console.error(
        `  ${cell.axis}/${cell.label}: ${cell.cpu_ms_median.toFixed(3)} ms, ` +
          `${(cell.peak_bytes_median / (1024 * 1024)).toFixed(2)} MB peak ` +
          `(${cell.iterations} iters)`,
      );
    });
  } else {
    const parsed: unknown = JSON.parse(await readFile(reuse, "utf8"));
    cells = (parsed as { cells: readonly ProbeCell[] }).cells;
    console.error(`  re-deriving from ${cells.length} recorded cells in ${reuse} (no measurement)`);
  }

  // snake_case on purpose — it matches the serialized record shape.
  const subject_commit = process.env["BAERLY_SUBJECT_COMMIT"] ?? "unknown";
  const rec = buildRecommendation({
    cells,
    subject_commit,
    extraFindings: await overlapFindings(cells),
  });
  console.log(renderTable(rec));
  console.log("");
  console.log(referenceLine());
  console.log("");
  console.log("findings");
  for (const finding of rec.findings) {
    console.log(`  - ${finding}`);
  }

  const outDir = "bench/results/fold-ceiling";
  await mkdir(outDir, { recursive: true });
  await writeFile(`${outDir}/latest.json`, JSON.stringify(rec, null, 2));
  console.log(`\nwrote ${outDir}/latest.json`);
  return 0;
};

process.exitCode = await main();
