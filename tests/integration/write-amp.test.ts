/* eslint-disable no-underscore-dangle -- `_id` is the locked PK field */
/**
 * CI gate: amortized BILLABLE Class A ops (PUT + LIST; DeleteObject is
 * $0 on R2/S3) per logical write, INCLUDING in-band maintenance. This is
 * the steady-state number that drives the bill — the write-path
 * counterpart to writer.test.ts (which gates only the commit FLOOR of 2)
 * and phase5-end-to-end.test.ts (which gates the idle READER at 0).
 *
 * Bands are grounded in docs/spec/attachments/amortized-write-cost-baseline.json
 * (measured 2026-06-22): cf-free ~3.0, node ~3.9. The bench runs the full
 * workload matrix; this gate runs one representative shape fast.
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
  test("cf-free profile stays in the ~3x band", { timeout: 30_000 }, async () => {
    const amperWrite = await measure({
      profile: MAINTENANCE_PROFILE_CF_FREE,
      minEntriesToCompact: 50,
      phasesPerTick: "single",
      gcGraceMillis: 0,
    });
    // Commit floor is 2 (content PUT + log create). Maintenance adds ~1
    // on cf-free. A regression to ~2 means maintenance stopped ticking;
    // a blowup past 4 means an extra PUT/LIST crept into the hot path.
    expect(amperWrite).toBeGreaterThan(2.5);
    expect(amperWrite).toBeLessThan(4);
  });

  test("node profile stays in the ~4x band", { timeout: 30_000 }, async () => {
    const amperWrite = await measure({
      profile: MAINTENANCE_PROFILE_NODE,
      minEntriesToCompact: 50,
      phasesPerTick: "both",
      gcGraceMillis: 0,
    });
    // Node gcInterval=2 (vs cf 4) ⇒ ~2x GC LISTs ⇒ ~+2 over the floor.
    expect(amperWrite).toBeGreaterThan(3.4);
    expect(amperWrite).toBeLessThan(5);
  });
});
