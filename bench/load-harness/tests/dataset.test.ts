import { describe, test, expect } from "vitest";
import { buildDataset } from "../generators/dataset.ts";

// Bound record bodies to 16 bytes. The defaults' 5% tail allocates
// records up to 1 MB each; the assertions here are about counts and
// distribution shape, not body bytes, so a tight cap keeps the tests
// finite.
const tinyBodies = [{ cumulativeFraction: 1.0, maxBytes: 16 }];

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
    expect(a.totalRecords).toBe(b.totalRecords);
    expect(a.totalBytes).toBe(b.totalBytes);
    for (let i = 0; i < a.tenants.length; i++) {
      const ta = a.tenants[i]!;
      const tb = b.tenants[i]!;
      expect(ta.tenantId).toBe(tb.tenantId);
      expect(ta.records.length).toBe(tb.records.length);
      for (let j = 0; j < ta.records.length; j++) {
        expect(ta.records[j]!.recordId).toBe(tb.records[j]!.recordId);
        expect(ta.records[j]!.bytes).toBe(tb.records[j]!.bytes);
        // Byte-level body comparison
        expect([...ta.records[j]!.bodyBytes]).toEqual([...tb.records[j]!.bodyBytes]);
      }
    }
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
