/**
 * Canonical-root acceptance for the prototype tree's fold planner: a
 * planned fold publishes exactly the canonical tree of the folded rows,
 * whatever the captured tree, the changes and how they are split into
 * ticks (`packages/server/src/tree/plan.ts`).
 *
 * - Property-based at the small-scope and production layouts, across
 *   the depth-0 limits and the root rule.
 * - Targeted: appends past the last node of every level, deletes that
 *   shrink the tree, a depth-2 tree at production leaf and fanout
 *   parameters, and locality (an in-place update rewrites one node per
 *   level).
 *
 * The exhaustive small-scope suite is `tree-fold-plan-exhaustive.test.ts`;
 * the incremental planner's equivalence with the batch plan, its
 * per-change work and its checkpoints are in `tree-fold-planner.test.ts`.
 *
 * The expected rows come from the logical oracle, and the published tree
 * is strictly decoded entry by entry (`tests/fixtures/tree-fold-harness.ts`).
 * The locality check catches `PLANNER_NEVER_RESYNCS`
 * (`tests/fixtures/tree-mutants.ts`).
 */
import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import { encodeJsonBytes, sha256Hex } from "@baerly/protocol";
import { parseTreeNodeKey, treeNodeKey } from "../../packages/server/src/tree/key.ts";
import {
  TREE_LAYOUT,
  type TreeConfig,
  type TreeLayout,
} from "../../packages/server/src/tree/layout.ts";
import { buildTree } from "../../packages/server/src/tree/build.ts";
import { canonicalDocument, decodeNode } from "../../packages/server/src/tree/node-codec.ts";
import {
  FoldPlanner,
  levelCountsMismatch,
  planFold,
  publicationReserve,
  type TreeMutation,
} from "../../packages/server/src/tree/plan.ts";
import { TREE_RETRIED_CALL_CHARGE } from "../../packages/server/src/tree/constants.ts";
import {
  configOf,
  FOLD_PREFIX,
  FOLD_SPENT_BEFORE_PLANNING,
  FoldRun,
  NO_DEPTH_ZERO,
  type RowChange,
  runTicks,
  SMALL_LAYOUT,
  sizedRow,
} from "../fixtures/tree-fold-harness.ts";
import { TREE_TEST_CHUNK_SALT, testChunkKey } from "../fixtures/tree-chunk-salt.ts";
import { PLANNER_NEVER_RESYNCS } from "../fixtures/tree-mutants.ts";
import {
  checkTreeImage,
  headKey,
  imageObject,
  treeHead,
} from "../fixtures/tree-oracle-physical.ts";

// ---------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------

/** Ticks of changes over IDs drawn from `ids`, each upserting at a size from `sizes` or deleting. */
const ticksOver = (
  ids: fc.Arbitrary<string>,
  sizes: fc.Arbitrary<number>,
  options: { readonly ticks: number; readonly perTick: number },
): fc.Arbitrary<RowChange[][]> =>
  fc
    .array(
      fc.array(
        fc.record({
          id: ids,
          size: fc.option(sizes, { freq: 4 }),
          fill: fc.constantFrom("a", "b"),
        }),
        { minLength: 1, maxLength: options.perTick },
      ),
      { minLength: 1, maxLength: options.ticks },
    )
    .map((ticks) =>
      ticks.map((tick) =>
        tick.map(({ id, size, fill }) => ({
          id,
          value: size === null ? null : sizedRow(id, size, fill),
        })),
      ),
    );

const chunkKey = await testChunkKey();

/**
 * Every violation the physical oracle (`tests/fixtures/tree-oracle-physical.ts`)
 * finds in `run`'s published tree under a tree head for its root, with
 * the logical oracle's rows as the expected rows.
 */
const physicalViolations = async (run: FoldRun, layout: TreeLayout): Promise<string[]> => {
  const root = await run.captured();
  const totals = root?.node.root ?? { rows: 0, bytes: 0 };
  const image = new Map([...run.store].map(([key, bytes]) => [key, imageObject(bytes)]));
  const head = treeHead({
    root: run.rootKey,
    floor: run.floor,
    rows: totals.rows,
    bytes: totals.bytes,
    attempt:
      run.rootKey === null ? "0".repeat(32) : parseTreeNodeKey(FOLD_PREFIX, run.rootKey)!.attempt,
    chunkSalt: TREE_TEST_CHUNK_SALT,
  });
  image.set(headKey(FOLD_PREFIX), imageObject(encodeJsonBytes(head)));
  const report = checkTreeImage({
    image,
    prefix: FOLD_PREFIX,
    layout,
    expectedRows: run.expectedRows(),
    expectedFloor: run.floor,
  });
  return report.violations.map((v) => `[${v.kind}] ${v.message}`);
};

const smallIds = fc.stringMatching(/^[a-z0-9]{1,2}$/);

describe("fold equals a fresh canonical build", () => {
  fcTest.prop({
    ticks: ticksOver(smallIds, fc.integer({ min: 11, max: 60 }), { ticks: 6, perTick: 12 }),
  })("at the small-scope layout, over any tick sequence", async ({ ticks }) => {
    await expect(runTicks(configOf(SMALL_LAYOUT), ticks)).resolves.toBeUndefined();
  });

  fcTest.prop({
    ticks: ticksOver(smallIds, fc.integer({ min: 11, max: 60 }), { ticks: 4, perTick: 12 }),
  })("at the small-scope layout, every fold passes the physical oracle", async ({ ticks }) => {
    const run = await FoldRun.open(configOf(SMALL_LAYOUT));
    for (const tick of ticks) {
      await run.fold(tick);
      await expect(physicalViolations(run, SMALL_LAYOUT)).resolves.toEqual([]);
    }
  });

  fcTest.prop({
    ticks: ticksOver(
      fc.stringMatching(/^[a-z]{1,2}$/),
      fc.oneof(fc.integer({ min: 11, max: 4000 }), fc.integer({ min: 20_000, max: 30_000 })),
      { ticks: 5, perTick: 40 },
    ),
  })("at production leaf and fanout parameters with the depth-0 rule off", async ({ ticks }) => {
    await expect(runTicks(configOf(NO_DEPTH_ZERO), ticks)).resolves.toBeUndefined();
  });

  /** 2,040 base rows of 15 bytes, so changes cross the depth-0 row limit both ways. */
  const rowLimitBase: RowChange[] = Array.from({ length: 2040 }, (_, i) => {
    const id = `r${String(i).padStart(4, "0")}`;
    return { id, value: { _id: id } };
  });
  const nearRowLimit = fc
    .integer({ min: 2000, max: 2060 })
    .map((n) => `r${String(n).padStart(4, "0")}`);

  fcTest.prop(
    { ticks: ticksOver(nearRowLimit, fc.constant(15), { ticks: 4, perTick: 20 }) },
    { numRuns: 20 },
  )("at the production layout, across the depth-0 row limit", async ({ ticks }) => {
    await expect(
      runTicks(configOf(TREE_LAYOUT), [rowLimitBase, ...ticks]),
    ).resolves.toBeUndefined();
  });

  /** 64 base rows of 8,192 bytes: exactly the depth-0 byte limit. */
  const byteLimitBase: RowChange[] = Array.from({ length: 64 }, (_, i) => {
    const id = `d${String(i).padStart(2, "0")}`;
    return { id, value: sizedRow(id, 8192) };
  });
  const nearByteLimit = fc
    .integer({ min: 0, max: 70 })
    .map((n) => `d${String(n).padStart(2, "0")}`);

  fcTest.prop(
    {
      ticks: ticksOver(nearByteLimit, fc.integer({ min: 8100, max: 8300 }), {
        ticks: 4,
        perTick: 4,
      }),
    },
    { numRuns: 20 },
  )("at the production layout, across the depth-0 byte limit", async ({ ticks }) => {
    await expect(
      runTicks(configOf(TREE_LAYOUT), [byteLimitBase, ...ticks]),
    ).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Targeted cases
// ---------------------------------------------------------------------

describe("whole-level crossings at the small-scope layout", () => {
  const k = (i: number) => `k${String(i).padStart(2, "0")}`;
  const base: RowChange[] = Array.from({ length: 40 }, (_, i) => ({
    id: k(i),
    value: { _id: k(i) },
  }));

  test("appends past the last node of every level", async () => {
    const appends = Array.from({ length: 30 }, (_, i) => ({
      id: `z${i}`,
      value: { _id: `z${i}` },
    }));
    await expect(
      runTicks(configOf(SMALL_LAYOUT), [base, ...appends.map((a) => [a])]),
    ).resolves.toBeUndefined();
    await expect(runTicks(configOf(SMALL_LAYOUT), [base, appends])).resolves.toBeUndefined();
  });

  test("deletes that shrink the tree by one or more levels, down to one leaf and to empty", async () => {
    const config = configOf(SMALL_LAYOUT);
    for (const keep of [0, 1, 2, 3, 5, 8, 13]) {
      const deletes = base.slice(keep).map((r) => ({ id: r.id, value: null }));
      await expect(runTicks(config, [base, deletes])).resolves.toBeUndefined();
      await expect(
        runTicks(config, [
          base,
          deletes.slice(0, deletes.length >> 1),
          deletes.slice(deletes.length >> 1),
        ]),
      ).resolves.toBeUndefined();
    }
  });

  test("a plan with no change rebuilds only the root, reusing its children", async () => {
    const config = configOf(SMALL_LAYOUT);
    const run = await FoldRun.open(config);
    await run.fold(base);
    const root = await run.captured();
    const plan = await planFold({
      prefix: FOLD_PREFIX,
      root,
      chunkKey,
      mutations: [],
      get: () => Promise.reject(new Error("no node should be read")),
      config,
    });
    expect(plan.read).toEqual([]);
    expect(plan.base).toBe(root!.key);
    expect(plan.chunkKey).toBe(chunkKey);
    expect(plan.tree!.root.kind).toBe("branch");
    const children = root!.node.kind === "branch" ? root!.node.children : [];
    expect(plan.tree!.root.kind === "branch" && plan.tree!.root.children).toEqual(
      children.map((entry) => ({ kind: "reused", entry })),
    );
    expect(plan.tree!.levelNodes).toEqual(
      root!.node.kind === "branch" ? root!.node.root!.levelNodes : [],
    );
  });

  test("a tick with no new log entry publishes nothing", async () => {
    const run = await FoldRun.open(configOf(SMALL_LAYOUT));
    await run.fold(base);
    const rootKey = run.rootKey;
    await expect(run.fold([])).resolves.toMatchObject({ plan: null, written: 0, folded: 0 });
    expect(run.rootKey).toBe(rootKey);
  });

  test("deleting an absent row rewrites at most its path", async () => {
    const run = await FoldRun.open(configOf(SMALL_LAYOUT));
    await run.fold(base);
    const depth = (await run.captured())!.node.level;
    const { written } = await run.fold([{ id: "k055", value: null }]);
    expect(written).toBeLessThanOrEqual(depth + 1);
    await expect(run.check()).resolves.toBeUndefined();
  });
});

describe("depth 2 at production leaf and fanout parameters", () => {
  // 2,400 rows of 1,000 bytes: over 128 leaves, so the leaves' parents are chunked.
  const id = (i: number) => `row${String(i).padStart(5, "0")}`;
  const base: RowChange[] = Array.from({ length: 2400 }, (_, i) => ({
    id: id(i),
    value: sizedRow(id(i), 1000),
  }));

  const deepRun = async (config: TreeConfig) => {
    const run = await FoldRun.open(config);
    await run.fold(base);
    const root = await run.captured();
    expect(root!.node.level).toBe(2);
    return run;
  };

  test("an in-place update rewrites one node per level", async () => {
    for (const mutant of [undefined, PLANNER_NEVER_RESYNCS]) {
      const run = await deepRun(configOf(NO_DEPTH_ZERO, mutant));
      const { written } = await run.fold([{ id: id(700), value: sizedRow(id(700), 1000, "y") }]);
      await expect(run.check()).resolves.toBeUndefined();
      if (mutant === undefined) {
        expect(written).toBe(3);
      } else {
        // The mutant's tree is canonical, but it rewrites everything after the change.
        expect(written).toBeGreaterThan(3);
      }
    }
  }, 30_000);

  test("node GETs and rewrites stay within the per-tick allowance", async () => {
    // The allowance for k folded entries at depth d is k(d + 1) path
    // nodes plus a resync allowance of k(d + 1). It bounds the mean over
    // a run, not each tick, since a resync's length is geometric.
    const run = await deepRun(configOf(NO_DEPTH_ZERO));
    const depth = (await run.captured())!.node.level;
    const allowance = (k: number) => 2 * k * (depth + 1);
    const ticks: RowChange[][] = Array.from({ length: 24 }, (_, t) => {
      const target = id((t * 977) % 2400);
      switch (t % 4) {
        case 0: {
          return [{ id: target, value: sizedRow(target, 1000, "y") }];
        }
        case 1: {
          return [{ id: `${target}a`, value: sizedRow(`${target}a`, 900) }];
        }
        case 2: {
          return [{ id: target, value: null }];
        }
        default: {
          return [{ id: target, value: sizedRow(target, 1400, "z") }];
        }
      }
    });
    ticks.push(
      [0, 600, 1200, 1800].map((i) => ({ id: id(i + 3), value: sizedRow(id(i + 3), 1000, "w") })),
    );
    let reads = 0;
    let written = 0;
    let entries = 0;
    for (const tick of ticks) {
      const result = await run.fold(tick);
      reads += result.plan!.read.length;
      written += result.written;
      entries += tick.length;
    }
    expect(reads / ticks.length).toBeLessThanOrEqual(allowance(entries / ticks.length));
    expect(written / ticks.length).toBeLessThanOrEqual(allowance(entries / ticks.length));
    await expect(run.check()).resolves.toBeUndefined();
  }, 60_000);

  test("inserts, deletes and appends anywhere fold to the canonical root", async () => {
    const run = await deepRun(configOf(NO_DEPTH_ZERO));
    const ticks: RowChange[][] = [
      [
        { id: id(5), value: null },
        { id: "row00005a", value: sizedRow("row00005a", 3000) },
      ],
      [
        { id: "zz", value: sizedRow("zz", 26_000) },
        { id: "a", value: sizedRow("a", 12) },
      ],
      Array.from({ length: 300 }, (_, i) => ({ id: id(1000 + i), value: null })),
      [
        { id: id(2399), value: null },
        { id: "zz", value: null },
      ],
    ];
    for (const tick of ticks) {
      await run.fold(tick);
      await expect(run.check()).resolves.toBeUndefined();
    }
  }, 30_000);

  test("deleting most rows regroups the leaves under one root", async () => {
    const run = await deepRun(configOf(NO_DEPTH_ZERO));
    await run.fold(base.slice(300).map((r) => ({ id: r.id, value: null })));
    await expect(run.check()).resolves.toBeUndefined();
    expect((await run.captured())!.node.level).toBe(1);
  }, 30_000);
});

describe("charged, change-by-change planning", () => {
  const config = configOf(SMALL_LAYOUT);
  const base: RowChange[] = Array.from({ length: 20 }, (_, i) => ({
    id: `k${i}`,
    value: { _id: `k${i}` },
  }));
  const UNBOUNDED = Number.MAX_SAFE_INTEGER;

  fcTest.prop({
    ticks: fc.array(
      fc.tuple(
        ticksOver(smallIds, fc.integer({ min: 11, max: 60 }), { ticks: 1, perTick: 10 }),
        fc.integer({ min: 0, max: 120 }),
      ),
      { minLength: 1, maxLength: 6 },
    ),
  })(
    "under any ledger it folds a seq prefix within budget, onto the canonical tree",
    async ({ ticks }) => {
      const run = await FoldRun.open(config);
      await run.fold(base);
      for (const [[changes], budget] of ticks) {
        const floor = run.floor;
        const { folded, planner } = await run.fold(changes!, budget);
        expect(planner!.charge).toBeLessThanOrEqual(Math.max(budget, FOLD_SPENT_BEFORE_PLANNING));
        expect(run.floor).toBe(floor + folded);
        await expect(run.check()).resolves.toBeUndefined();
      }
      // A generous tick then folds whatever is left.
      await run.fold([], UNBOUNDED);
      await expect(run.check()).resolves.toBeUndefined();
    },
  );

  test("a rejected change keeps its GETs charged, and the last accepted plan is published", async () => {
    const probe = await FoldRun.open(config);
    await probe.fold(base);
    const first = await probe.fold([{ id: "k0", value: null }], UNBOUNDED);
    const afterFirst = first.planner!.charge;
    const getsAfterFirst = first.planner!.gets;

    // Room for the first change and exactly one more node GET.
    const run = await FoldRun.open(config);
    await run.fold(base);
    const { folded, planner } = await run.fold(
      [
        { id: "k0", value: null },
        { id: "k9", value: null },
      ],
      afterFirst + TREE_RETRIED_CALL_CHARGE,
    );
    expect(folded).toBe(1);
    expect(planner!.gets).toBe(getsAfterFirst + 1);
    expect(planner!.charge).toBe(afterFirst + TREE_RETRIED_CALL_CHARGE);
    expect(planner!.plan).toEqual(first.planner!.plan);
    // The published tree is the one-change fold; k9 waits for the next tick.
    expect(run.rootKey).toBe(probe.rootKey);
    await expect(run.check()).resolves.toBeUndefined();
    await run.fold([], UNBOUNDED);
    await expect(run.check()).resolves.toBeUndefined();
  });

  test("a change whose charge is exactly the budget is accepted", async () => {
    const change = { id: "k5", value: { _id: "k5", p: "y" } };
    const probe = await FoldRun.open(config);
    await probe.fold(base);
    const { planner: probed } = await probe.fold([change], UNBOUNDED);
    const exact = probed!.charge;
    for (const [budget, folded] of [
      [exact, 1],
      [exact - 1, 0],
    ] as const) {
      const run = await FoldRun.open(config);
      await run.fold(base);
      const result = await run.fold([change], budget);
      expect(result.folded).toBe(folded);
      expect(result.planner!.charge).toBeLessThanOrEqual(budget);
    }
  });

  test("after a rejection every later change is refused, so the accepted changes stay a seq prefix", async () => {
    const run = await FoldRun.open(config);
    await run.fold(base);
    const input = {
      prefix: FOLD_PREFIX,
      root: await run.captured(),
      chunkKey,
      get: (key: string) => Promise.resolve(run.store.get(key) ?? null),
      config,
      spent: FOLD_SPENT_BEFORE_PLANNING,
    };
    const row = (id: string, p: string) => canonicalDocument({ _id: id, p }, "row");
    // Later changes repeat or sit beside earlier ones, so each would fit
    // the nodes and the reserve an earlier accepted plan already paid for.
    const changes: TreeMutation[] = [
      { id: "k0", doc: null },
      { id: "k9", doc: null },
      { id: "k15", doc: row("k15", "u") },
      { id: "k0", doc: null },
      { id: "k1", doc: row("k1", "v") },
      { id: "k0", doc: null },
    ];
    let refusedAfterRejection = 0;
    for (let budget = FOLD_SPENT_BEFORE_PLANNING; budget <= 120; budget++) {
      const planner = new FoldPlanner({ ...input, budget });
      let rejected = false;
      for (const [i, change] of changes.entries()) {
        const { plan, gets, charge } = planner;
        const accepted = await planner.add(change);
        if (rejected) {
          expect(accepted, `budget ${budget}, change ${i}`).toBe(false);
          expect(planner.plan).toBe(plan);
          expect(planner.gets).toBe(gets);
          expect(planner.charge).toBe(charge);
          refusedAfterRejection += 1;
        }
        rejected ||= !accepted;
      }
    }
    expect(refusedAfterRejection).toBeGreaterThan(0);
  });

  test("a change that throws is a rejection: every later change is refused", async () => {
    const run = await FoldRun.open(config);
    await run.fold(base);
    const planner = new FoldPlanner({
      prefix: FOLD_PREFIX,
      root: await run.captured(),
      chunkKey,
      get: (key: string) => Promise.resolve(run.store.get(key) ?? null),
      config,
      budget: UNBOUNDED,
      spent: FOLD_SPENT_BEFORE_PLANNING,
    });
    await expect(planner.add({ id: "k0", doc: null })).resolves.toBe(true);
    const accepted = planner.plan;
    await expect(
      planner.add({ id: "k3", doc: canonicalDocument({ _id: "k4" }, "row") }),
    ).rejects.toMatchObject({ code: "Internal" });
    await expect(planner.add({ id: "k5", doc: null })).resolves.toBe(false);
    expect(planner.plan).toBe(accepted);
  });

  test("a first change that does not fit folds nothing and keeps the floor", async () => {
    const run = await FoldRun.open(config);
    await run.fold(base);
    const { rootKey, floor } = run;
    const { folded, planner } = await run.fold(
      [{ id: "k5", value: { _id: "k5", p: "y" } }],
      FOLD_SPENT_BEFORE_PLANNING + TREE_RETRIED_CALL_CHARGE,
    );
    expect(folded).toBe(0);
    expect(planner!.plan).toBeNull();
    expect(planner!.charge).toBeLessThanOrEqual(
      FOLD_SPENT_BEFORE_PLANNING + TREE_RETRIED_CALL_CHARGE,
    );
    expect(run.rootKey).toBe(rootKey);
    expect(run.floor).toBe(floor);
  });

  test("the publication reserve is a PUT and an adoption GET per fresh node, the head CAS and its fate re-read", async () => {
    expect(publicationReserve(null)).toBe(1 + TREE_RETRIED_CALL_CHARGE);
    const tree = await buildTree(
      base.map((r) => canonicalDocument(r.value, "row")),
      chunkKey,
      config,
    );
    // 7 leaves, 3 level-1 nodes and the root.
    expect(publicationReserve(tree)).toBe(
      11 * 2 * TREE_RETRIED_CALL_CHARGE + 1 + TREE_RETRIED_CALL_CHARGE,
    );
  });
});

describe("planner input", () => {
  const config = configOf(SMALL_LAYOUT);
  const get = () => Promise.resolve(null);
  const row = (id: string) => canonicalDocument({ _id: id }, "row");

  test("repeated or mismatched mutations are Internal errors", async () => {
    for (const mutations of [
      [
        { id: "a", doc: row("a") },
        { id: "a", doc: null },
      ],
      [{ id: "a", doc: row("b") }],
    ]) {
      await expect(
        planFold({ prefix: FOLD_PREFIX, root: null, chunkKey, mutations, get, config }),
      ).rejects.toMatchObject({ code: "Internal" });
    }
  });

  test("a delete whose _id is outside the document-ID domain is dropped", async () => {
    const run = await FoldRun.open(config);
    await run.fold(
      Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, value: { _id: `k${i}` } })),
    );
    const input = {
      prefix: FOLD_PREFIX,
      root: await run.captured(),
      chunkKey,
      get: (key: string) => Promise.resolve(run.store.get(key) ?? null),
      config,
    };
    const valid = { id: "k3", doc: null };
    const none = await planFold({ ...input, mutations: [] });
    const one = await planFold({ ...input, mutations: [valid] });
    for (const id of ["", "_hidden", "a/b", "..", "\uD800"]) {
      const bad = { id, doc: null };
      await expect(planFold({ ...input, mutations: [bad] })).resolves.toEqual(none);
      await expect(planFold({ ...input, mutations: [valid, bad] })).resolves.toEqual(one);
      await expect(planFold({ ...input, root: null, mutations: [bad] })).resolves.toEqual({
        tree: null,
        read: [],
        base: null,
        chunkKey,
      });
      const planner = new FoldPlanner({ ...input, budget: Number.MAX_SAFE_INTEGER, spent: 0 });
      await expect(planner.add(valid)).resolves.toBe(true);
      await expect(planner.add(bad)).resolves.toBe(true);
      expect(planner.plan).toEqual(one);
    }
  });

  test("captured level_nodes that disagree with a regrouped level are InvalidResponse; the planner's own are Internal", async () => {
    const run = await FoldRun.open(config);
    await run.fold(
      Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, value: { _id: `k${i}` } })),
    );
    const root = (await run.captured())!;
    expect(root.node.kind === "branch" && root.node.root!.levelNodes).toEqual([7, 3]);
    // Store a root recording 3 leaves: the decoder accepts the counts, but
    // the leaf level would then be regrouped, and it holds 7 nodes.
    const body = JSON.parse(new TextDecoder().decode(run.store.get(run.rootKey!))) as {
      attempt: string;
      level_nodes: number[];
    };
    body.level_nodes = [3, 3];
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    const key = treeNodeKey(FOLD_PREFIX, body.attempt, await sha256Hex(bytes));
    const corrupt = await decodeNode(
      key,
      bytes,
      { prefix: FOLD_PREFIX, root: true, floor: run.floor },
      config,
    );
    const read = (k: string) => Promise.resolve(run.store.get(k) ?? null);
    await expect(
      planFold({
        prefix: FOLD_PREFIX,
        root: corrupt,
        chunkKey,
        mutations: [],
        get: read,
        config,
      }),
    ).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringContaining("level_nodes [3,3]"),
    });
    // The incremental planner carries the stored counts the same way.
    const planner = new FoldPlanner({
      prefix: FOLD_PREFIX,
      root: corrupt,
      chunkKey,
      get: read,
      config,
      budget: Number.MAX_SAFE_INTEGER,
      spent: 0,
    });
    await expect(
      planner.add({ id: "k3", doc: canonicalDocument({ _id: "k3", p: "y" }, "row") }),
    ).rejects.toMatchObject({ code: "InvalidResponse" });
    // Counts the planner listed or built itself can disagree only through
    // a planner bug.
    expect(levelCountsMismatch(corrupt, 0, 7, 3).code).toBe("InvalidResponse");
    expect(levelCountsMismatch(null, 0, 7, 3).code).toBe("Internal");
  });

  test("a non-root captured node is an Internal error, and a missing node is InvalidResponse", async () => {
    const run = await FoldRun.open(config);
    await run.fold(
      Array.from({ length: 20 }, (_, i) => ({ id: `k${i}`, value: { _id: `k${i}` } })),
    );
    const root = (await run.captured())!;
    await expect(
      planFold({
        prefix: FOLD_PREFIX,
        root,
        chunkKey,
        mutations: [{ id: "k3", doc: null }],
        get,
        config,
      }),
    ).rejects.toMatchObject({
      code: "InvalidResponse",
      message: expect.stringContaining("present check failed"),
    });

    const notRoot = { ...root, node: { ...root.node, root: null } };
    await expect(
      planFold({ prefix: FOLD_PREFIX, root: notRoot, chunkKey, mutations: [], get, config }),
    ).rejects.toMatchObject({ code: "Internal" });
  });
});
