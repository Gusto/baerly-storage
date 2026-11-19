import { describe, expect, test } from "vitest";
import {
  CELL_BY_NAME,
  CELLS,
  FIXTURES,
  type TreeParams,
  treeCellName,
  treePathNodes,
} from "./src/cells.ts";
import { buildFixture } from "./src/common.ts";
import { runTreeStep } from "./src/tree-step.ts";

// `pnpm bench:cpu-factor:build` runs only on the owner's deploy path, so a
// seeding regression (a write the capacity check refuses) would otherwise
// surface there first.
describe("cpu-factor fixtures build under the current kernel", () => {
  for (const [name, spec] of Object.entries(FIXTURES)) {
    test(name, { timeout: 60_000 }, async () => {
      const fx = await buildFixture(spec);
      expect(fx.rows).toBe(spec.rows);
      expect(fx.bytes).toBeGreaterThan(spec.rows * spec.payload);
    });
  }
});

describe("tree fold-step path modes", () => {
  const params = (k: number, d: number, path?: "shared" | "distinct"): TreeParams => ({
    k,
    bKiB: 4,
    d,
    ...(path === undefined ? {} : { path }),
  });

  test("node-count formula: shared = d, distinct = sum of min(k, 64^level)", () => {
    expect(treePathNodes(params(8, 3))).toBe(3);
    expect(treePathNodes(params(8, 3, "shared"))).toBe(3);
    expect(treePathNodes(params(8, 3, "distinct"))).toBe(1 + 8 + 8);
    expect(treePathNodes(params(4, 2, "distinct"))).toBe(1 + 4);
    expect(treePathNodes(params(8, 1, "distinct"))).toBe(1);
    // Past the fanout the level below the root is capped at 64.
    expect(treePathNodes(params(100, 2, "distinct"))).toBe(1 + 64);
  });

  test("cell names: shared unchanged, distinct suffixed, both in the catalogue", () => {
    expect(treeCellName(params(4, 2))).toBe("tree-k4-b4-d2");
    expect(treeCellName(params(4, 2, "distinct"))).toBe("tree-k4-b4-d2-distinct");
    expect(CELL_BY_NAME["tree-k8-b64-d3"]!.tree!.path).toBeUndefined();
    expect(CELL_BY_NAME["tree-k8-b64-d3-distinct"]!.tree!.path).toBe("distinct");
    expect(new Set(CELLS.map((c) => c.name)).size).toBe(CELLS.length);
  });

  test("the step re-encodes and hashes the formula's node count, and the modes differ", async () => {
    const shared = await runTreeStep(params(4, 3, "shared"));
    const distinct = await runTreeStep(params(4, 3, "distinct"));
    expect(shared.pathNodes).toBe(3);
    expect(distinct.pathNodes).toBe(1 + 4 + 4);
    expect(distinct.bytesHashed).toBeGreaterThan(shared.bytesHashed);
    // Omitted path behaves as shared.
    const omitted = await runTreeStep(params(4, 3));
    expect(omitted.pathNodes).toBe(3);
  });
});
