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
  type FrozenBaselineCell,
  type ProbeCell,
  buildRecommendation,
  cellsOf,
  compareToFrozen,
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
 * 2026. Don't hand-maintain this count against the grid: {@link compareToFrozen}
 * matches on axis + rows + bytes_per_doc and prints the number it actually
 * compared.
 */
const FROZEN_BASELINE = "docs/spec/attachments/fold-cost-baseline.json";

/**
 * Read the frozen baseline and hand it to {@link compareToFrozen}. The read is
 * all that lives here; the derivation is pure and unit-tested next door.
 *
 * Degrades to a SKIP finding, never throws: this runs AFTER the multi-minute
 * sweep and BEFORE the result file is written, so anything that escapes here
 * discards every measured cell. The shape check belongs inside the try for
 * exactly that reason — a baseline that parses but carries no `cells` is a
 * skippable overlap check, not a lost run. The reuse path in `main` wants the
 * opposite decision from the same helper; see there.
 */
const overlapFindings = async (cells: readonly ProbeCell[]): Promise<readonly string[]> => {
  let frozen: readonly FrozenBaselineCell[];
  try {
    const parsed: unknown = JSON.parse(await readFile(FROZEN_BASELINE, "utf8"));
    frozen = cellsOf<FrozenBaselineCell>(parsed, FROZEN_BASELINE);
  } catch (error: unknown) {
    return [`overlap check SKIPPED: could not read ${FROZEN_BASELINE} (${String(error)}).`];
  }
  return compareToFrozen(cells, frozen);
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
    // malformed file has nothing to lose by throwing.
    //
    // The check is array-shaped only. It separates "wrong file" from "our
    // file"; it does NOT catch a bad cell inside our file — an element missing
    // `cpu_ms_median` still propagates NaN through the margin math into the
    // record. That is deliberate: a per-field schema here would be validating
    // this probe's own serializer against itself, and the operator staring at
    // the NaN is the one who produced the file a minute earlier.
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
