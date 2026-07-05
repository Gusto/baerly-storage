/**
 * Shared write-cost measurement harness for the amortized + stress
 * write-cost benches (bench/amortized-write-cost.ts,
 * bench/write-amp-stress.ts). Both drive logical writes through the
 * in-band maintenance path over MemoryStorage and tally billable
 * Class A ops (PUT + LIST; DeleteObject is $0 on R2/S3). MEASURES
 * ONLY — changes no constant, does no I/O beyond the in-memory store.
 *
 * The two scripts differ solely in their WORKLOADS data and which
 * ratios they print, so the constants / interface / measure() body
 * live here and each script imports them.
 */
import {
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_NODE,
  MemoryStorage,
} from "@baerly/protocol";
import { type BoundedMaintenanceOptions } from "@baerly/server/maintenance";
import { createObservabilityContext, runWithContext } from "@baerly/server/observability";
import { Writer } from "@baerly/server/_internal/testing";
import { wrapCountingStorage } from "../../tests/fixtures/counting-storage.ts";
import {
  bootstrap,
  COLLECTION,
  CURRENT_JSON_KEY,
} from "../../tests/fixtures/maintenance-harness.ts";

export const CF_FREE: BoundedMaintenanceOptions = {
  profile: MAINTENANCE_PROFILE_CF_FREE,
  minEntriesToCompact: 50,
  phasesPerTick: "single",
  gcGraceMillis: 0,
};
export const NODE: BoundedMaintenanceOptions = {
  profile: MAINTENANCE_PROFILE_NODE,
  minEntriesToCompact: 50,
  phasesPerTick: "both",
  gcGraceMillis: 0,
};

export interface Workload {
  label: string;
  writes: number;
  workingSet: number;
  bodyBytes: number;
  updateRatio: number;
}

export interface MeasureResult {
  writes: number;
  puts: number;
  lists: number;
  deletesFree: number;
  billableClassAPerWrite: number;
}

export async function measure(
  opts: BoundedMaintenanceOptions,
  wl: Workload,
  owner: string,
): Promise<MeasureResult> {
  const inner = new MemoryStorage();
  await bootstrap(inner, owner, Math.max(128, wl.bodyBytes));
  const counting = wrapCountingStorage(inner);
  const writer = new Writer({ storage: counting.storage, currentJsonKey: CURRENT_JSON_KEY });
  counting.reset();
  const blob = "x".repeat(wl.bodyBytes);
  await runWithContext(createObservabilityContext({ maintenance: { options: opts } }), async () => {
    for (let i = 0; i < wl.writes; i++) {
      const isUpdate = wl.workingSet > 0 && i >= wl.workingSet && i % 100 < wl.updateRatio * 100;
      const id = wl.workingSet > 0 ? `d${i % wl.workingSet}` : `d${i}`;
      // eslint-disable-next-line no-underscore-dangle -- `_id` is the locked PK field
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
