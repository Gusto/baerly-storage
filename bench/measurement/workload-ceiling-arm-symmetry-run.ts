/** Runnable entrypoint for the workload-ceiling arm-symmetry probe. */
import { mkdir, writeFile } from "node:fs/promises";
import {
  ARM_SYMMETRY_MEASURE_ITERATIONS,
  buildArmSymmetryRecord,
  renderArmSymmetryTables,
  runArmSymmetryGrid,
} from "./workload-ceiling-arm-symmetry.ts";

/** `BAERLY_ARM_SYMMETRY_N` raises N when the default is too noisy to separate the arms. */
const measureIterations = (): number => {
  const raw = process.env["BAERLY_ARM_SYMMETRY_N"];
  if (raw === undefined || raw === "") {
    return ARM_SYMMETRY_MEASURE_ITERATIONS;
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`BAERLY_ARM_SYMMETRY_N must be a positive integer, got ${raw}`);
  }
  return parsed;
};

const main = async (): Promise<number> => {
  const iterations = measureIterations();
  const rows = await runArmSymmetryGrid(iterations, ([control, candidate]) => {
    console.error(
      `  ${candidate.locality}/${candidate.cell}: ` +
        `control=${control.invocation.median_ms.toFixed(2)}ms ` +
        `candidate=${candidate.invocation.median_ms.toFixed(2)}ms ` +
        `fold-read=${candidate.fold_read.chunk_fanout.median}/${candidate.total_chunks} chunks ` +
        `net=${candidate.net_vs_control_node.median_ms.toFixed(2)}ms`,
    );
  });
  const record = buildArmSymmetryRecord({
    rows,
    subject_commit: process.env["BAERLY_SUBJECT_COMMIT"] ?? "unknown",
    measure_iterations: iterations,
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
