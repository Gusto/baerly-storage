import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { EvalReport } from "./types.ts";

export function writeReport(report: EvalReport, stampMs: number): string {
  const dir = fileURLToPath(new URL("results/", import.meta.url));
  const path = `${dir}${stampMs}.json`;
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
  return path;
}

export function printSummary(report: EvalReport): void {
  console.log(
    `\nmodel=${report.model}  cli=${report.cliVersion}  surface=${report.surfaceKind}  runs=${report.runs}`,
  );
  console.log(`surface_hash=${report.surfaceHash.slice(0, 12)}…`);
  for (const t of report.tasks) {
    const pct = Math.round(t.passRate * 100);
    const flag = t.passRate >= 0.8 ? "  " : "⚠ ";
    console.log(`  ${flag}${t.name.padEnd(22)} ${pct}%  (${t.failures.length} fail)`);
  }
  console.log(`  aggregate pass-rate: ${Math.round(report.aggregatePassRate * 100)}%`);
}
