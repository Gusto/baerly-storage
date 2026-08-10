/* eslint-disable no-underscore-dangle -- `_id` is the locked PK field */
/**
 * CI gate: amortized BILLABLE Class A ops (PUT + LIST; DeleteObject is
 * $0 on R2/S3) per logical write, INCLUDING in-band maintenance. This is
 * the steady-state number that drives the bill — the write-path
 * counterpart to writer.test.ts (which gates only the commit FLOOR of 1)
 * and maintenance-e2e.test.ts (which gates the idle READER at 0).
 *
 * Bands are grounded in docs/spec/attachments/amortized-write-cost-baseline.json
 * (cf-free ~1.8, node ~2.5). The bench runs the full workload matrix; this
 * gate runs one representative shape fast.
 *
 * Each lower bound sits a PROPORTIONAL distance below the baseline's measured
 * minimum for its profile (~25% cf-free, ~17% node), not at a fixed number.
 * `pnpm bench:amortized-write-cost` is deterministic on MemoryStorage, so the
 * margin absorbs workload drift rather than run-to-run variance — which is
 * why a re-measurement must re-anchor both bounds to the fresh minima instead
 * of leaving the old ones to pass by an ever-shrinking accident.
 */
import { describe, expect, test } from "vitest";
import {
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_NODE,
  MemoryStorage,
} from "@baerly/protocol";
import { type BoundedMaintenanceOptions } from "@baerly/server/maintenance";
import { createObservabilityContext, runWithContext } from "@baerly/server/observability";
import { Writer } from "@baerly/server/_internal/testing";
import { wrapCountingStorage } from "../fixtures/counting-storage.ts";
import { bootstrap, COLLECTION, CURRENT_JSON_KEY } from "../fixtures/maintenance-harness.ts";
import { ciTimeout } from "../setup/ci.ts";

const WRITES = 800;
const BODY = 2000;
const WORKING_SET = 50;

const measure = async (opts: BoundedMaintenanceOptions): Promise<number> => {
  const inner = new MemoryStorage();
  await bootstrap(inner, "write-amp-gate", BODY);
  const counting = wrapCountingStorage(inner);
  const writer = new Writer({ storage: counting.storage, currentJsonKey: CURRENT_JSON_KEY });
  counting.reset();
  const blob = "x".repeat(BODY);
  await runWithContext(createObservabilityContext({ maintenance: { options: opts } }), async () => {
    for (let i = 0; i < WRITES; i++) {
      const id = `d${i % WORKING_SET}`;
      await writer.commit({
        op: i % 2 === 0 ? "I" : "U",
        collection: COLLECTION,
        docId: id,
        body: { _id: id, n: i, blob },
      });
    }
  });
  return counting.billableClassAOps / WRITES;
};

describe("amortized billable Class A per write (cost-model gate)", () => {
  test("cf-free profile stays in the ~2x band", { timeout: ciTimeout(30_000) }, async () => {
    const amperWrite = await measure({
      profile: MAINTENANCE_PROFILE_CF_FREE,
      minEntriesToCompact: 50,
      phasesPerTick: "single",
      gcGraceMillis: 0,
    });
    // Commit floor is 1 (log create). A drop near that floor means
    // maintenance stopped ticking; a blowup past this band means an extra
    // PUT/LIST returned to the hot path. 1.3 is ~25% below the baseline's
    // 1.741 cf-free minimum — see the margin rule in the file header.
    expect(amperWrite).toBeGreaterThan(1.3);
    expect(amperWrite).toBeLessThan(3);
  });

  test("node profile stays in the ~2.5x band", { timeout: ciTimeout(30_000) }, async () => {
    const amperWrite = await measure({
      profile: MAINTENANCE_PROFILE_NODE,
      minEntriesToCompact: 50,
      phasesPerTick: "both",
      gcGraceMillis: 0,
    });
    // Node's more frequent GC adds LIST work above the commit floor. A
    // drop near the floor means maintenance stopped ticking; a blowup past
    // this band means an extra PUT/LIST returned to the hot path. 2.0 is
    // ~17% below the baseline's 2.404 node minimum — see the margin rule in
    // the file header.
    expect(amperWrite).toBeGreaterThan(2);
    expect(amperWrite).toBeLessThan(4);
  });
});
