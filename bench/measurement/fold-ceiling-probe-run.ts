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
 * makes it byte-for-byte immutable. SIX of this grid's cells also exist there
 * (bytes 256 / 512 / 2560 rows at 2048 B/doc, rows 2048 / 8192 / 16384 at
 * 64 B/doc), and comparing them is the only check that the fixture builder, the
 * seed, and the measurement definitions still mean what they meant in June
 * 2026. Don't hand-maintain this count against the grid: `overlapFindings`
 * matches on axis + rows + bytes_per_doc and prints the number it actually
 * compared.
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
 * Narrow a parsed JSON document to its `cells` array, THROWING when it is
 * absent rather than asserting the shape and letting `undefined` through.
 *
 * A bare `parsed as { cells: T[] }` succeeds on any valid JSON, so a file
 * without `cells` yields `undefined` typed as an array and defers the failure
 * to the first `.find` / `.length` — as an uncaught `TypeError`, at a call site
 * chosen by luck rather than by the caller. Both readers below want a decision
 * at the read, and they want DIFFERENT decisions: see each call site.
 */
const cellsOf = <T>(parsed: unknown, source: string): readonly T[] => {
  const cells = (parsed as { cells?: unknown } | null)?.cells;
  if (!Array.isArray(cells)) {
    throw new TypeError(`${source}: expected a "cells" array, got ${typeof cells}`);
  }
  return cells as readonly T[];
};

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
  // Degrade to a SKIP finding, never throw: this runs AFTER the multi-minute
  // sweep and BEFORE the result file is written, so anything that escapes here
  // discards every measured cell. The shape check belongs inside the try for
  // exactly that reason — a baseline that parses but carries no `cells` is a
  // skippable overlap check, not a lost run.
  let frozen: readonly FrozenCell[];
  try {
    const parsed: unknown = JSON.parse(await readFile(FROZEN_BASELINE, "utf8"));
    frozen = cellsOf<FrozenCell>(parsed, FROZEN_BASELINE);
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
  // DERIVED, never transcribed — same rule the probe module states for its own
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
    // Fail FAST here, the opposite of the frozen-baseline read above: this is
    // an operator-supplied path, it is read before any measurement runs, and a
    // malformed file has nothing to lose by throwing. Feeding an unvalidated
    // shape into buildRecommendation would instead produce a plausible-looking
    // record derived from garbage.
    const parsed: unknown = JSON.parse(await readFile(reuse, "utf8"));
    cells = cellsOf<ProbeCell>(parsed, reuse);
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

  // One timestamped file per run, matching `bench/fold-cost.ts` and
  // `bench/lsn-reverse-walk.ts`. A fixed `latest.json` would clobber the
  // previous sweep — and comparing consecutive runs is how you tell a clean
  // measurement from one taken on a contended machine, which is the failure
  // mode this probe is most exposed to.
  const outDir = "bench/results/fold-ceiling";
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = `${outDir}/fold-ceiling-${stamp}.json`;
  await writeFile(out, JSON.stringify(rec, null, 2));
  console.log(`\nwrote ${out}`);
  return 0;
};

process.exitCode = await main();
