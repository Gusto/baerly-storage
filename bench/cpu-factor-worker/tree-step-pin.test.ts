import { expect, test } from "vitest";
import { CELL_BY_NAME } from "./src/cells.ts";
import { runTreeStep } from "./src/tree-step.ts";

// Captured from the pre-distinct-path tree-step.ts (origin/main 5148d3ff) on
// a fresh module, calling these cells in this order. The step counter is
// module state and feeds the encoded bytes, so this file must stay alone in
// its module instance and keep the order.
const PINNED = [
  ["tree-k1-b4-d1", 1, 11245, "77771a09c3e8e9a7bfc10ca5b1f7adf3306aa09c7f6363da04a4a2a82e692b12"],
  ["tree-k4-b16-d2", 2, 80345, "b9e1c99cda3d3175bde1527672efb086fe48a1e4ff8f5429216490d678213547"],
  ["tree-k8-b64-d3", 3, 552567, "d202110883dd2f452d12cd878eb5ac7625fadce4cc0cd870691edb5ea482527b"],
  ["tree-k2-b16-d3", 3, 54215, "f9884009516d37379cd1812abc63e30ec6a371e41d641515faaa192b4e86fd27"],
] as const;

test("shared-path tree steps keep their pre-distinct-path output", async () => {
  for (const [name, pathNodes, bytesHashed, root] of PINNED) {
    const r = await runTreeStep(CELL_BY_NAME[name]!.tree!);
    expect(r).toEqual({
      cold: true,
      leaves: CELL_BY_NAME[name]!.tree!.k,
      pathNodes,
      bytesHashed,
      root,
    });
  }
});
