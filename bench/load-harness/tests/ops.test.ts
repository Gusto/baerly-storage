import { describe, test, expect } from "vitest";
import { buildDataset } from "../generators/dataset.ts";
import { generateOpStream } from "../generators/ops.ts";
import { getPreset } from "../presets.ts";
import "../presets/recent-first-crud.ts";

// Bound record bodies to 16 bytes. The defaults' 5% tail allocates
// records up to 1 MB each; the assertions in this file are about op
// shape, not body bytes, so a tight cap keeps the tests finite.
const tinyBodies = [{ cumulativeFraction: 1.0, maxBytes: 16 }];

describe("op-stream determinism", () => {
  test("same seed + dataset + mix → identical Op[]", () => {
    const ds = buildDataset({
      seed: 9,
      tenantCount: 100,
      schema: { collection: "notes" },
      recordSizeBuckets: tinyBodies,
    });
    const preset = getPreset("recent-first-crud");
    const a = generateOpStream({ seed: 9, dataset: ds, mix: preset.opMix, opCount: 5000 });
    const b = generateOpStream({ seed: 9, dataset: ds, mix: preset.opMix, opCount: 5000 });
    expect(a).toEqual(b);
  });

  test("op mix matches preset weights within ±5%", () => {
    const ds = buildDataset({
      seed: 1,
      tenantCount: 100,
      schema: { collection: "notes" },
      recordSizeBuckets: tinyBodies,
    });
    const preset = getPreset("recent-first-crud");
    const ops = generateOpStream({ seed: 1, dataset: ds, mix: preset.opMix, opCount: 20_000 });
    const counts: Record<string, number> = {};
    for (const op of ops) counts[op.kind] = (counts[op.kind] ?? 0) + 1;
    for (const [kind, expectedWeight] of Object.entries(preset.opMix.weights)) {
      const got = (counts[kind] ?? 0) / 20_000;
      expect(got).toBeGreaterThan(expectedWeight - 0.05);
      expect(got).toBeLessThan(expectedWeight + 0.05);
    }
  });

  test("top 1% of tenants get >= 40% of traffic", () => {
    const ds = buildDataset({
      seed: 2,
      tenantCount: 1000,
      schema: { collection: "notes" },
      recordSizeBuckets: tinyBodies,
    });
    const preset = getPreset("recent-first-crud");
    const ops = generateOpStream({ seed: 2, dataset: ds, mix: preset.opMix, opCount: 50_000 });
    const byTenant = new Map<string, number>();
    for (const op of ops) byTenant.set(op.tenantId, (byTenant.get(op.tenantId) ?? 0) + 1);
    const ranked = [...byTenant.entries()].toSorted((a, b) => b[1] - a[1]);
    const top1pct = Math.max(1, Math.floor(1000 * 0.01));
    const topTraffic = ranked.slice(0, top1pct).reduce((acc, [, n]) => acc + n, 0);
    expect(topTraffic / 50_000).toBeGreaterThan(0.4); // target 50%, ±10%
  });
});
