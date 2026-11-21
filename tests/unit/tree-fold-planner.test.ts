/**
 * The prototype tree's incremental fold planner (`FoldPlanner` in
 * `packages/server/src/tree/plan.ts`): it adds a fold's changes one at
 * a time onto the tree of the changes accepted so far.
 *
 * - **Equivalence.** With an unbounded ledger it publishes the same
 *   canonical shape as the batch `planFold` and never more nodes. Shapes
 *   are compared, not root keys: the planner reuses a captured node a
 *   change rebuilt unchanged, which the batch plan republishes.
 * - **CPU bound.** The chunk hashes one change computes do not grow with
 *   the number of changes the tick has accepted.
 * - **Checkpoints.** A pinned look-ahead falls back to the pinned
 *   checkpoint, within the budget.
 * - **Prefix split.** One tick of ten changes and ticks of three, three
 *   and four land on the same shape.
 *
 * The batch planner and the change-by-change ledger rules are covered by
 * `tree-fold-plan.test.ts`; the harness is `tests/fixtures/tree-fold-harness.ts`.
 */
import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import { sealTree } from "../../packages/server/src/tree/build.ts";
import { chunkHash } from "../../packages/server/src/tree/chunk.ts";
import { TREE_RETRIED_CALL_CHARGE } from "../../packages/server/src/tree/constants.ts";
import {
  createTreeConfig,
  TREE_LAYOUT,
  type TreeConfig,
  type TreeLayout,
} from "../../packages/server/src/tree/layout.ts";
import { canonicalDocument } from "../../packages/server/src/tree/node-codec.ts";
import {
  FoldPlanner,
  planFold,
  publicationReserve,
  type TreeFoldPlan,
  type TreeMutation,
} from "../../packages/server/src/tree/plan.ts";
import {
  configOf,
  FOLD_PREFIX,
  FOLD_SPENT_BEFORE_PLANNING,
  FoldRun,
  NO_DEPTH_ZERO,
  publishedShape,
  type RowChange,
  shapeDigest,
  SMALL_LAYOUT,
  sizedRow,
} from "../fixtures/tree-fold-harness.ts";
import { testChunkKey } from "../fixtures/tree-chunk-salt.ts";

const UNBOUNDED = Number.MAX_SAFE_INTEGER;
const chunkKey = await testChunkKey();

/** The small-scope layout with a depth-0 rule of 5 rows and 200 bytes. */
const SMALL_DEPTH_ZERO: TreeLayout = {
  ...SMALL_LAYOUT,
  singleLeafMaxRows: 5,
  singleLeafMaxBytes: 200,
};

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

const smallIds = fc.stringMatching(/^[a-z0-9]{1,2}$/);

/** The shape digest of `run`'s published tree. */
const runShape = async (run: FoldRun, config: TreeConfig): Promise<string> => {
  const { shape } = await publishedShape(run.store, run.rootKey, run.floor, config);
  return shapeDigest(shape);
};

/** The shape digest of `plan`, sealed and published over a copy of `run`'s store. */
const planShape = async (run: FoldRun, plan: TreeFoldPlan, config: TreeConfig): Promise<string> => {
  const floor = run.floor + 1;
  const sealed = await sealTree(plan.tree, {
    prefix: FOLD_PREFIX,
    attempt: "f".repeat(32),
    floor,
  });
  const store = new Map(run.store);
  for (const node of sealed.levels.flat()) {
    store.set(node.key, node.bytes);
  }
  const { shape } = await publishedShape(store, sealed.root?.key ?? null, floor, config);
  return shapeDigest(shape);
};

/**
 * Fold `ticks` twice in lockstep, through `planFold` and through an
 * unbounded `FoldPlanner`, and return the first tick where the planner
 * publishes another shape, more nodes, or a charge that is not its GETs
 * plus the publication reserve of its plan.
 */
const lockstep = async (
  config: TreeConfig,
  ticks: readonly (readonly RowChange[])[],
): Promise<string | undefined> => {
  const batch = await FoldRun.open(config);
  const incremental = await FoldRun.open(config);
  for (const [i, tick] of ticks.entries()) {
    const expected = await batch.fold(tick);
    const got = await incremental.fold(tick, UNBOUNDED);
    if (got.folded !== tick.length) {
      return `tick ${i}: folded ${got.folded} of ${tick.length}`;
    }
    const [left, right] = await Promise.all([
      runShape(incremental, config),
      runShape(batch, config),
    ]);
    if (left !== right) {
      return `tick ${i}: the planner's shape differs from the batch plan's`;
    }
    if (got.written > expected.written) {
      return `tick ${i}: the planner wrote ${got.written} nodes, the batch plan ${expected.written}`;
    }
    const { planner } = got;
    if (planner!.plan !== null) {
      const charge =
        FOLD_SPENT_BEFORE_PLANNING +
        planner!.gets * TREE_RETRIED_CALL_CHARGE +
        publicationReserve(planner!.plan.tree);
      if (planner!.charge !== charge) {
        return `tick ${i}: charge ${planner!.charge}, but GETs and reserve give ${charge}`;
      }
    }
  }
  return incremental.check();
};

describe("with an unbounded ledger the planner matches the batch plan", () => {
  fcTest.prop({
    ticks: ticksOver(smallIds, fc.integer({ min: 11, max: 60 }), { ticks: 5, perTick: 14 }),
  })(
    "at the small-scope layout: root-rule level changes, isolated leaves, deletes and no-ops",
    async ({ ticks }) => {
      await expect(lockstep(configOf(SMALL_LAYOUT), ticks)).resolves.toBeUndefined();
    },
  );

  fcTest.prop({
    ticks: ticksOver(fc.stringMatching(/^[a-h]$/), fc.integer({ min: 11, max: 60 }), {
      ticks: 6,
      perTick: 10,
    }),
  })("with a depth-0 rule, across its limits both ways", async ({ ticks }) => {
    await expect(lockstep(configOf(SMALL_DEPTH_ZERO), ticks)).resolves.toBeUndefined();
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
    { ticks: ticksOver(nearRowLimit, fc.constant(15), { ticks: 3, perTick: 20 }) },
    { numRuns: 10 },
  )("at the production layout, across the depth-0 row limit", async ({ ticks }) => {
    await expect(
      lockstep(configOf(TREE_LAYOUT), [rowLimitBase, ...ticks]),
    ).resolves.toBeUndefined();
  });

  test("one tick that crosses the depth-0 limit down and back up, and changes depth", async () => {
    const config = configOf(SMALL_DEPTH_ZERO);
    const k = (i: number) => `k${String(i).padStart(2, "0")}`;
    const base: RowChange[] = Array.from({ length: 30 }, (_, i) => ({
      id: k(i),
      value: { _id: k(i) },
    }));
    const deletes = base.slice(3).map((r) => ({ id: r.id, value: null }));
    const run = await FoldRun.open(config);
    await run.fold(base);
    const depth = (await run.captured())!.node.level;
    expect(depth).toBeGreaterThanOrEqual(2);
    // Down to 3 rows (one root leaf), then back to every row, in one tick.
    await expect(lockstep(config, [base, [...deletes, ...base.slice(3)]])).resolves.toBeUndefined();
    // Down to one root leaf, and down to empty, in one tick each.
    await expect(lockstep(config, [base, deletes])).resolves.toBeUndefined();
    await expect(
      lockstep(config, [base, base.map((r) => ({ id: r.id, value: null }))]),
    ).resolves.toBeUndefined();
  });

  test("a change that is undone, and a no-op, publish only the root", async () => {
    const config = configOf(SMALL_LAYOUT);
    const base: RowChange[] = Array.from({ length: 20 }, (_, i) => ({
      id: `k${i}`,
      value: { _id: `k${i}` },
    }));
    const run = await FoldRun.open(config);
    await run.fold(base);
    const { written } = await run.fold(
      [
        { id: "k5", value: sizedRow("k5", 30, "y") },
        { id: "k12a", value: { _id: "k12a" } },
        { id: "k5", value: { _id: "k5" } },
        { id: "k12a", value: null },
        { id: "zz", value: null },
        { id: "k7", value: { _id: "k7" } },
      ],
      UNBOUNDED,
    );
    expect(written).toBe(1);
    await expect(run.check()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// CPU bound
// ---------------------------------------------------------------------

describe("per-change work", () => {
  test("the chunk hashes of the n-th change do not grow with n", async () => {
    let hashes = 0;
    const config = createTreeConfig({
      layout: NO_DEPTH_ZERO,
      steps: {
        chunkHash: (key, level, id) => {
          hashes += 1;
          return chunkHash(key, level, id);
        },
      },
    });
    // 2,400 rows of 1,000 bytes: a depth-2 tree.
    const id = (i: number) => `row${String(i).padStart(5, "0")}`;
    const run = await FoldRun.open(config);
    await run.fold(
      Array.from({ length: 2400 }, (_, i) => ({ id: id(i), value: sizedRow(id(i), 1000) })),
    );
    const root = await run.captured();
    expect(root!.node.level).toBe(2);
    const planner = new FoldPlanner({
      prefix: FOLD_PREFIX,
      root,
      chunkKey,
      get: (key) => Promise.resolve(run.store.get(key) ?? null),
      config,
      budget: UNBOUNDED,
      spent: FOLD_SPENT_BEFORE_PLANNING,
    });
    const perChange: number[] = [];
    for (let t = 0; t < 240; t++) {
      const target = id((t * 977) % 2400);
      const before = hashes;
      await expect(
        planner.add({
          id: target,
          doc: canonicalDocument(sizedRow(target, 1000, "y"), "row"),
        }),
      ).resolves.toBe(true);
      perChange.push(hashes - before);
    }
    const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const first = mean(perChange.slice(0, 40));
    const last = mean(perChange.slice(-40));
    expect(first).toBeGreaterThan(0);
    expect(last).toBeLessThanOrEqual(2 * first);
  }, 60_000);
});

// ---------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------

describe("checkpoints and the look-ahead fallback", () => {
  const config = configOf(SMALL_LAYOUT);
  const base: RowChange[] = Array.from({ length: 20 }, (_, i) => ({
    id: `k${i}`,
    value: { _id: `k${i}` },
  }));
  const row = (id: string, p?: string) =>
    canonicalDocument(p === undefined ? { _id: id } : { _id: id, p }, "row");

  const open = async () => {
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
    return { run, input };
  };

  // k5 changes, the fold pins there (an entry after it is not publishable
  // yet), k5 is changed back, so the current reserve falls below the
  // pinned one, and later changes need GETs.
  const first: TreeMutation = { id: "k5", doc: row("k5", "changed") };
  const lookAhead: TreeMutation[] = [
    { id: "k5", doc: row("k5") },
    { id: "k17", doc: row("k17", "u") },
    { id: "k9", doc: null },
    { id: "k0", doc: row("k0", "v") },
    { id: "k13", doc: null },
  ];

  test("a rejection during the look-ahead rolls back to the pinned checkpoint, within the budget", async () => {
    const { run, input } = await open();
    const batch = await planFold({ ...input, mutations: [first] });
    const expected = await planShape(run, batch, config);
    let fellBack = 0;
    let pinnedAboveCurrent = 0;
    for (let budget = FOLD_SPENT_BEFORE_PLANNING; budget <= 200; budget++) {
      const planner = new FoldPlanner({ ...input, budget });
      if (!(await planner.add(first))) {
        continue;
      }
      const reserve = () =>
        planner.charge - FOLD_SPENT_BEFORE_PLANNING - planner.gets * TREE_RETRIED_CALL_CHARGE;
      const pinnedReserve = reserve();
      expect(planner.pin()).toBe(1);
      let rejected = false;
      for (const change of lookAhead) {
        if (!(await planner.add(change))) {
          rejected = true;
          break;
        }
        if (reserve() < pinnedReserve) {
          pinnedAboveCurrent += 1;
        }
      }
      if (!rejected) {
        planner.unpin();
        continue;
      }
      planner.rollback();
      fellBack += 1;
      expect(planner.accepted, `budget ${budget}`).toBe(1);
      expect(planner.charge, `budget ${budget}`).toBeLessThanOrEqual(budget);
      await expect(planShape(run, planner.plan!, config)).resolves.toBe(expected);
      // The fold ends at the pinned checkpoint.
      await expect(planner.add({ id: "k1", doc: null })).resolves.toBe(false);
    }
    expect(fellBack).toBeGreaterThan(0);
    expect(pinnedAboveCurrent).toBeGreaterThan(0);
  });

  test("a pin before any change falls back to folding nothing", async () => {
    const { input } = await open();
    const planner = new FoldPlanner({ ...input, budget: UNBOUNDED });
    expect(planner.pin()).toBe(0);
    await expect(planner.add(first)).resolves.toBe(true);
    // A second pin keeps the first.
    expect(planner.pin()).toBe(0);
    planner.rollback();
    expect(planner.accepted).toBe(0);
    expect(planner.plan).toBeNull();
    expect(() => planner.rollback()).toThrow(expect.objectContaining({ code: "Internal" }));
  });

  test("a resolved look-ahead keeps every change accepted past the pin", async () => {
    const { run, input } = await open();
    const planner = new FoldPlanner({ ...input, budget: UNBOUNDED });
    await planner.add(first);
    planner.pin();
    for (const change of lookAhead) {
      await expect(planner.add(change)).resolves.toBe(true);
    }
    planner.unpin();
    expect(planner.accepted).toBe(1 + lookAhead.length);
    const survivors = new Map([first, ...lookAhead].map((m) => [m.id, m]));
    const batch = await planFold({ ...input, mutations: [...survivors.values()] });
    await expect(planShape(run, planner.plan!, config)).resolves.toBe(
      await planShape(run, batch, config),
    );
  });

  test("calls the fold spends between changes count against the same budget", async () => {
    const { input } = await open();
    const probe = new FoldPlanner({ ...input, budget: UNBOUNDED });
    await probe.add(first);
    const budget = probe.charge + 5;

    const planner = new FoldPlanner({ ...input, budget });
    await expect(planner.add(first)).resolves.toBe(true);
    expect(planner.spend(5)).toBe(true);
    expect(planner.charge).toBe(budget);
    // Nothing is left for the next change's GETs, nor for another call.
    await expect(planner.add({ id: "k17", doc: null })).resolves.toBe(false);
    expect(planner.charge).toBe(budget);

    const refused = new FoldPlanner({ ...input, budget });
    await refused.add(first);
    expect(refused.spend(6)).toBe(false);
    expect(refused.charge).toBe(probe.charge);
    await expect(refused.add({ id: "k5", doc: row("k5") })).resolves.toBe(false);
    expect(refused.accepted).toBe(1);
    expect(() => refused.spend(-1)).toThrow(expect.objectContaining({ code: "Internal" }));
  });
});

// ---------------------------------------------------------------------
// Prefix split
// ---------------------------------------------------------------------

describe("prefix split", () => {
  for (const [name, layout] of [
    ["small-scope", SMALL_LAYOUT],
    ["small-scope with a depth-0 rule", SMALL_DEPTH_ZERO],
  ] as const) {
    fcTest.prop({
      base: ticksOver(smallIds, fc.integer({ min: 11, max: 60 }), { ticks: 1, perTick: 30 }),
      changes: fc
        .array(
          fc.record({
            id: smallIds,
            size: fc.option(fc.integer({ min: 11, max: 60 }), { freq: 4 }),
          }),
          { minLength: 10, maxLength: 10 },
        )
        .map((changes) =>
          changes.map(({ id, size }) => ({
            id,
            value: size === null ? null : sizedRow(id, size, "c"),
          })),
        ),
    })(
      `at the ${name} layout, one tick of 10 changes lands on the shape of ticks of 3, 3 and 4`,
      async ({ base, changes }) => {
        const config = configOf(layout);
        const one = await FoldRun.open(config);
        await one.fold(base[0]!);
        const split = one.fork();
        await one.fold(changes, UNBOUNDED);
        for (const part of [changes.slice(0, 3), changes.slice(3, 6), changes.slice(6)]) {
          await split.fold(part, UNBOUNDED);
        }
        expect(one.floor).toBe(split.floor);
        await expect(runShape(one, config)).resolves.toBe(await runShape(split, config));
        await expect(one.check()).resolves.toBeUndefined();
        await expect(split.check()).resolves.toBeUndefined();
      },
    );
  }
});
