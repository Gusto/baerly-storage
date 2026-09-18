/**
 * Runnable entrypoint for the workload-ceiling win model.
 *
 * Thin by design: the grid, the ratio math, and the record shape all live
 * in `./workload-ceiling-win-model.ts`, which the test imports and which
 * has no module-scope side effects. This file is the only place that
 * executes the sweep, prints, and writes to disk.
 *
 *   BAERLY_SUBJECT_COMMIT=$(git rev-parse HEAD) \
 *     pnpm bench:workload-ceiling:win-model
 *
 * MEASURES ONLY. Changes no constant, no planner, no production behaviour.
 *
 * Must run under `workload-ceiling-win-model-hooks.mjs` so the encode
 * counters exist. `pnpm bench:workload-ceiling:win-model` wires that.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { buildWinModelRecord, renderTable, runWinModelGrid } from "./workload-ceiling-win-model.ts";

const main = async (): Promise<number> => {
  const { rows, skips } = await runWinModelGrid((row) => {
    if ("reason" in row) {
      console.error(`  ${row.cell}/${row.policy}: SKIP ${row.reason}`);
      return;
    }
    console.error(
      `  ${row.cell}/${row.policy}/${row.locality}: ` +
        `planner ${row.plannerWinMedian.toFixed(2)}x [${row.plannerWinRange}] ` +
        `prefix ${row.prefixWinMedian.toFixed(2)}x [${row.prefixWinRange}] ` +
        `K=${row.kMedian} h=${row.plannerHashMedian}/${row.prefixHashMedian}`,
    );
  });

  const rec = buildWinModelRecord({
    rows,
    skips,
    subject_commit: process.env["BAERLY_SUBJECT_COMMIT"] ?? "unknown",
  });
  console.log(renderTable(rec.rows, rec.skips));
  console.log("");
  console.log("findings");
  for (const finding of rec.findings) {
    console.log(`  - ${finding}`);
  }

  const outDir = "bench/results/workload-ceiling";
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = `${outDir}/win-model-${stamp}.json`;
  await writeFile(out, JSON.stringify(rec, null, 2));
  console.log(`\nwrote ${out}`);
  return 0;
};

process.exitCode = await main();
