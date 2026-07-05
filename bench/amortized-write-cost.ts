/* eslint-disable no-console -- bench script prints results */
/**
 * Amortized billable Class A storage ops per logical write, INCLUDING
 * in-band maintenance (folds + GC), across workload shapes × maintenance
 * profiles (cf-free / node). Billable Class A = PUT + LIST (DeleteObject
 * is $0 on R2/S3). MEASURES ONLY — changes no constant. No infra
 * (MemoryStorage). Source of truth for the write-amp constants in
 * packages/cli/src/cost/provider.ts and the docs/about/cost-model.md
 * effective-write-amp claim.
 */
import { writeFile } from "node:fs/promises";
import { CF_FREE, measure, NODE, type Workload } from "./lib/write-cost-measure.ts";

const WORKLOADS: Workload[] = [
  {
    label: "update-heavy/50-docs/2KB",
    writes: 2000,
    workingSet: 50,
    bodyBytes: 2000,
    updateRatio: 0.5,
  },
  {
    label: "update-heavy/50-docs/200B",
    writes: 2000,
    workingSet: 50,
    bodyBytes: 200,
    updateRatio: 0.5,
  },
  {
    label: "insert-only/growing/200B",
    writes: 1500,
    workingSet: 0,
    bodyBytes: 200,
    updateRatio: 0,
  },
];

async function main() {
  const rows = [];
  for (const [profile, opts] of [
    ["cf-free", CF_FREE],
    ["node", NODE],
  ] as const) {
    for (const wl of WORKLOADS) {
      const r = await measure(opts, wl, "amort-bench");
      rows.push({ profile, workload: wl.label, ...r });
      console.log(`${profile} | ${wl.label} | billableA/write=${r.billableClassAPerWrite}`);
    }
  }
  await writeFile(
    "docs/spec/attachments/amortized-write-cost-baseline.json",
    JSON.stringify(rows, null, 2) + "\n",
  );
  console.log("wrote docs/spec/attachments/amortized-write-cost-baseline.json");
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
