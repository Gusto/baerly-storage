/** Runnable entrypoint for the workload-ceiling arm-symmetry probe. */
import { mkdir, writeFile } from "node:fs/promises";
import {
  buildArmSymmetryRecord,
  renderArmSymmetryTables,
  runArmSymmetryGrid,
} from "./workload-ceiling-arm-symmetry.ts";

const main = async (): Promise<number> => {
  const rows = await runArmSymmetryGrid(([control, candidate]) => {
    console.error(
      `  ${candidate.locality}/${candidate.cell}: ` +
        `control=${control.invocation.median_ms.toFixed(2)}ms ` +
        `candidate=${candidate.invocation.median_ms.toFixed(2)}ms ` +
        `net=${candidate.net_vs_control_node.median_ms.toFixed(2)}ms`,
    );
  });
  const record = buildArmSymmetryRecord({
    rows,
    subject_commit: process.env["BAERLY_SUBJECT_COMMIT"] ?? "unknown",
  });

  console.log(renderArmSymmetryTables(record.rows));
  console.log("\nfindings");
  for (const finding of record.findings) {
    console.log(`  - ${finding}`);
  }

  const outDir = "bench/results/workload-ceiling";
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const out = `${outDir}/arm-symmetry-${stamp}.json`;
  await writeFile(out, JSON.stringify(record, null, 2));
  console.log(`\nwrote ${out}`);
  return 0;
};

process.exitCode = await main();
