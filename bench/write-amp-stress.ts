/* eslint-disable no-console -- bench script prints results */
/**
 * STRESS companion to bench/amortized-write-cost.ts. Drives pathological
 * workloads — extreme churn, insert bursts with large bodies, full-set
 * rewrites — through the in-band maintenance path to answer ONE question:
 *
 *   Can effective billable Class A ops/write ever approach the historic
 *   "> 6" graduation trigger under BOUNDED in-band maintenance + free
 *   DeleteObject, or is it capped near the ~3-4x steady-state baseline?
 *
 * Billable Class A = PUT + LIST (DeleteObject is $0 on R2/S3). MEASURES
 * ONLY — changes no constant. No infra (MemoryStorage). Feeds the `> 6`
 * trigger decision in docs/about/{cost-model,graduation}.md.
 */
import { writeFile } from "node:fs/promises";
import { CF_FREE, measure, NODE, type Workload } from "./lib/write-cost-measure.ts";

// Pathological shapes chosen to maximise each maintenance cost driver:
//  - extreme-churn:  tiny set, 100% updates  -> fold fires constantly
//  - insert-burst:   unbounded growth, 2KB   -> snapshot + /content/ LIST grow
//  - rewrite-all:    large set, 100% updates -> max stale-index churn + big fold
const WORKLOADS: Workload[] = [
  {
    label: "extreme-churn/10-docs/2KB",
    writes: 3000,
    workingSet: 10,
    bodyBytes: 2000,
    updateRatio: 1,
  },
  {
    label: "insert-burst/growing/2KB",
    writes: 3000,
    workingSet: 0,
    bodyBytes: 2000,
    // workingSet 0 ⇒ pure inserts; updateRatio is inert here (the isUpdate
    // guard requires workingSet > 0), set to 0 only to satisfy the type.
    updateRatio: 0,
  },
  {
    label: "rewrite-all/500-docs/2KB",
    writes: 4000,
    workingSet: 500,
    bodyBytes: 2000,
    updateRatio: 1,
  },
];

async function main() {
  const rows = [];
  let peak = 0;
  for (const [profile, opts] of [
    ["cf-free", CF_FREE],
    ["node", NODE],
  ] as const) {
    for (const wl of WORKLOADS) {
      const base = await measure(opts, wl, "stress-bench");
      // Preserve the original baseline JSON key order: the per-write
      // ratios sit before billableClassAPerWrite.
      const r = {
        writes: base.writes,
        puts: base.puts,
        lists: base.lists,
        deletesFree: base.deletesFree,
        putsPerWrite: Number((base.puts / wl.writes).toFixed(3)),
        listsPerWrite: Number((base.lists / wl.writes).toFixed(3)),
        billableClassAPerWrite: base.billableClassAPerWrite,
      };
      peak = Math.max(peak, r.billableClassAPerWrite);
      rows.push({ profile, workload: wl.label, ...r });
      console.log(
        `${profile} | ${wl.label} | billableA/write=${r.billableClassAPerWrite}` +
          ` (put=${r.putsPerWrite} list=${r.listsPerWrite})`,
      );
    }
  }
  console.log(
    `peak billable Class A/write under stress = ${peak.toFixed(3)} ` +
      `(historic ">6" trigger ${peak > 6 ? "REACHED" : "NOT reached"})`,
  );
  await writeFile(
    "docs/spec/attachments/amortized-write-cost-stress-baseline.json",
    JSON.stringify({ peak_billable_class_a_per_write: Number(peak.toFixed(3)), rows }, null, 2) +
      "\n",
  );
  console.log("wrote docs/spec/attachments/amortized-write-cost-stress-baseline.json");
}
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
