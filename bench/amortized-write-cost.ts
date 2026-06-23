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

async function measure(opts: BoundedMaintenanceOptions, wl: Workload) {
  const inner = new MemoryStorage();
  await bootstrap(inner, "amort-bench", Math.max(128, wl.bodyBytes));
  const counting = wrapCountingStorage(inner);
  const writer = new Writer({ storage: counting.storage, currentJsonKey: CURRENT_JSON_KEY });
  counting.reset();
  const blob = "x".repeat(wl.bodyBytes);
  await runWithContext(createObservabilityContext({ maintenance: { options: opts } }), async () => {
    for (let i = 0; i < wl.writes; i++) {
      const isUpdate = wl.workingSet > 0 && i >= wl.workingSet && i % 100 < wl.updateRatio * 100;
      const id = wl.workingSet > 0 ? `d${i % wl.workingSet}` : `d${i}`;
      // eslint-disable-next-line no-underscore-dangle
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
    billableClassAPerWrite: Number((counting.billableClassAOps / wl.writes).toFixed(3)),
  };
}

async function main() {
  const rows = [];
  for (const [profile, opts] of [
    ["cf-free", CF_FREE],
    ["node", NODE],
  ] as const) {
    for (const wl of WORKLOADS) {
      const r = await measure(opts, wl);
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
