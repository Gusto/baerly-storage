/* eslint-disable no-console -- bench script prints results */
/* eslint-disable no-underscore-dangle -- `_id` is the locked PK field */
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
import {
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_NODE,
  MemoryStorage,
} from "@baerly/protocol";
import { type BoundedMaintenanceOptions } from "@baerly/server/maintenance";
import { createObservabilityContext, runWithContext } from "@baerly/server/observability";
import { Writer } from "@baerly/server/_internal/testing";
import { wrapCountingStorage } from "../tests/fixtures/counting-storage.ts";
import { bootstrap, COLLECTION, CURRENT_JSON_KEY } from "../tests/fixtures/maintenance-harness.ts";

const CF_FREE: BoundedMaintenanceOptions = {
  profile: MAINTENANCE_PROFILE_CF_FREE,
  minEntriesToCompact: 50,
  phasesPerTick: "single",
  gcGraceMillis: 0,
};
const NODE: BoundedMaintenanceOptions = {
  profile: MAINTENANCE_PROFILE_NODE,
  minEntriesToCompact: 50,
  phasesPerTick: "both",
  gcGraceMillis: 0,
};

interface Workload {
  label: string;
  writes: number;
  workingSet: number;
  bodyBytes: number;
  updateRatio: number;
}

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

async function measure(opts: BoundedMaintenanceOptions, wl: Workload) {
  const inner = new MemoryStorage();
  await bootstrap(inner, "stress-bench", Math.max(128, wl.bodyBytes));
  const counting = wrapCountingStorage(inner);
  const writer = new Writer({ storage: counting.storage, currentJsonKey: CURRENT_JSON_KEY });
  counting.reset();
  const blob = "x".repeat(wl.bodyBytes);
  await runWithContext(createObservabilityContext({ maintenance: { options: opts } }), async () => {
    for (let i = 0; i < wl.writes; i++) {
      const isUpdate = wl.workingSet > 0 && i >= wl.workingSet && i % 100 < wl.updateRatio * 100;
      const id = wl.workingSet > 0 ? `d${i % wl.workingSet}` : `d${i}`;
      await writer.commit({
        op: isUpdate ? "U" : "I",
        collection: COLLECTION,
        docId: id,
        body: { _id: id, n: i, blob },
      });
    }
  });
  return {
    writes: wl.writes,
    puts: counting.puts,
    lists: counting.lists,
    deletesFree: counting.deletes,
    putsPerWrite: Number((counting.puts / wl.writes).toFixed(3)),
    listsPerWrite: Number((counting.lists / wl.writes).toFixed(3)),
    billableClassAPerWrite: Number((counting.billableClassAOps / wl.writes).toFixed(3)),
  };
}

async function main() {
  const rows = [];
  let peak = 0;
  for (const [profile, opts] of [
    ["cf-free", CF_FREE],
    ["node", NODE],
  ] as const) {
    for (const wl of WORKLOADS) {
      const r = await measure(opts, wl);
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
