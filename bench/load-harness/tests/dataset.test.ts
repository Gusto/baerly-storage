import { describe, test, expect } from "vitest";
import { buildDataset } from "../generators/dataset.ts";

// Bound record bodies to 16 bytes. The defaults' 5% tail allocates
// records up to 1 MB each; the assertions here are about counts and
// distribution shape, not body bytes, so a tight cap keeps the tests
// finite.
const tinyBodies = [{ cumulativeFraction: 1, maxBytes: 16 }];

describe("dataset determinism", () => {
  test("same seed → byte-identical dataset", () => {
    const a = buildDataset({
      seed: 12345,
      tenantCount: 50,
      schema: { collection: "notes" },
      recordSizeBuckets: tinyBodies,
    });
    const b = buildDataset({
      seed: 12345,
      tenantCount: 50,
      schema: { collection: "notes" },
      recordSizeBuckets: tinyBodies,
    });
    // Whole-dataset deep equality covers every field (tenantId, record
    // counts and IDs, bytes, bodyBytes, timestamps, popularity rank,
    // traffic share, totals) in one comparison. Vitest compares
    // Uint8Array values byte-for-byte, so this is still an exact
    // byte-identical check — just without per-record assertion/spread
    // overhead that dominated this test's wall-clock under load.
    expect(a).toEqual(b);
  });

  test("tenant-size distribution roughly matches the buckets", () => {
    const d = buildDataset({
      seed: 1,
      tenantCount: 1000,
      schema: { collection: "notes" },
      recordSizeBuckets: tinyBodies,
    });
    const small = d.tenants.filter((t) => t.records.length <= 100).length;
    const med = d.tenants.filter((t) => t.records.length > 100 && t.records.length <= 1000).length;
    expect(small / 1000).toBeGreaterThan(0.6); // target 70%
    expect(small / 1000).toBeLessThan(0.8);
    expect(med / 1000).toBeGreaterThan(0.1); // target 20%
    expect(med / 1000).toBeLessThan(0.3);
  });

  test("trafficShare sums to ~1", () => {
    const d = buildDataset({
      seed: 1,
      tenantCount: 100,
      schema: { collection: "notes" },
      recordSizeBuckets: tinyBodies,
    });
    const sum = d.tenants.reduce((acc, t) => acc + t.trafficShare, 0);
    expect(sum).toBeGreaterThan(0.99);
    expect(sum).toBeLessThan(1.01);
  });
});
