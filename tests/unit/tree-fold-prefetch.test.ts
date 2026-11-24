/**
 * The fold planner's read-ahead (`FoldPlanner.prefetch` in
 * `packages/server/src/tree/plan.ts`): it reads the nodes a window of
 * changes routes to concurrently, before the changes are added.
 *
 * - **Same plan, same charges.** With a budget that accepts every
 *   change, a planner that prefetches each window accepts the same
 *   changes, reads the same nodes in the same order, issues the same
 *   GETs and charges the same as one that reads every node on demand,
 *   and its plan seals to the same node keys.
 * - **Exact charges under any budget.** Every GET the planner issues is
 *   one it charged, its charge never passes the budget, and the plan it
 *   stops at is the canonical plan of its accepted prefix.
 * - **Concurrency.** Prefetched GETs overlap, never more than
 *   `TREE_FOLD_PARALLEL_CALLS` at once; `parallelGets: 1` reads one node
 *   at a time.
 */
import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import type { DocumentData } from "@baerly/protocol";
import { sealTree } from "../../packages/server/src/tree/build.ts";
import {
  TREE_FOLD_PARALLEL_CALLS,
  TREE_RETRIED_CALL_CHARGE,
} from "../../packages/server/src/tree/constants.ts";
import type { TreeConfig } from "../../packages/server/src/tree/layout.ts";
import { canonicalDocument } from "../../packages/server/src/tree/node-codec.ts";
import { FoldPlanner, type TreeMutation } from "../../packages/server/src/tree/plan.ts";
import { testChunkKey } from "../fixtures/tree-chunk-salt.ts";
import {
  configOf,
  FOLD_PREFIX,
  FOLD_SPENT_BEFORE_PLANNING,
  FoldRun,
  type RowChange,
  SMALL_LAYOUT,
  sizedRow,
} from "../fixtures/tree-fold-harness.ts";

const UNBOUNDED = Number.MAX_SAFE_INTEGER;
const chunkKey = await testChunkKey();
const config = configOf(SMALL_LAYOUT);
/** The small-scope layout with a depth-0 rule of 5 rows and 200 bytes, so windows cross it. */
const depthZeroConfig = configOf({
  ...SMALL_LAYOUT,
  singleLeafMaxRows: 5,
  singleLeafMaxBytes: 200,
});
const configs = { small: config, "depth-0": depthZeroConfig } as const;

/** How one drive of a planner went. */
interface Drive {
  readonly planner: FoldPlanner;
  /** GETs that reached the store. */
  readonly calls: number;
  /** Most GETs in flight at once. */
  readonly maxInFlight: number;
  /** Keys the changes read on demand, after their window's prefetch. */
  readonly onDemand: readonly string[];
  /** The plan's node keys, sealed under a fixed attempt, root first. */
  readonly sealed: readonly string[];
}

const mutationsOf = (changes: readonly RowChange[]): TreeMutation[] =>
  changes.map(({ id, value }) => ({
    id,
    doc: value === null ? null : canonicalDocument(value, "row"),
  }));

/**
 * Add `mutations` to a planner over `run`'s tree in windows of
 * `window`, prefetching each window first, until one is rejected. With
 * `delay`, every GET resolves only after a macrotask, so concurrent
 * GETs overlap.
 */
const drive = async (
  run: FoldRun,
  cfg: TreeConfig,
  mutations: readonly TreeMutation[],
  options: {
    readonly budget: number;
    readonly parallelGets?: number;
    readonly window?: number;
    readonly delay?: boolean;
    /** The error a GET of `key` throws, if any. */
    readonly fail?: (key: string) => Error | undefined;
  },
): Promise<Drive> => {
  let calls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  let adding = false;
  const onDemand: string[] = [];
  const planner = new FoldPlanner({
    prefix: FOLD_PREFIX,
    root: await run.captured(),
    chunkKey,
    get: async (key) => {
      calls += 1;
      if (adding) {
        onDemand.push(key);
      }
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      if (options.delay === true) {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      inFlight -= 1;
      const error = options.fail?.(key);
      if (error !== undefined) {
        throw error;
      }
      return run.store.get(key) ?? null;
    },
    config: cfg,
    budget: options.budget,
    spent: FOLD_SPENT_BEFORE_PLANNING,
    ...(options.parallelGets !== undefined && { parallelGets: options.parallelGets }),
  });
  const window = options.window ?? 16;
  windows: for (let start = 0; start < mutations.length; start += window) {
    const slice = mutations.slice(start, start + window);
    await planner.prefetch(slice);
    adding = true;
    for (const mutation of slice) {
      if (!(await planner.add(mutation))) {
        break windows;
      }
    }
    adding = false;
  }
  const plan = planner.plan;
  const tree =
    plan === null
      ? null
      : await sealTree(plan.tree, {
          prefix: FOLD_PREFIX,
          attempt: "f".repeat(32),
          floor: run.floor + planner.accepted,
        });
  const sealed =
    tree === null ? [] : [tree.root?.key ?? "", ...tree.levels.flat().map((n) => n.key)];
  return { planner, calls, maxInFlight, onDemand, sealed };
};

/** Everything a serial and a prefetching drive must agree on. */
const observed = (d: Drive) => ({
  accepted: d.planner.accepted,
  gets: d.planner.gets,
  calls: d.calls,
  charge: d.planner.charge,
  read: d.planner.plan?.read.map((n) => n.key) ?? null,
  sealed: d.sealed,
});

/** A run with `base` folded, then `extra` folded in a second tick, so nodes span two attempts. */
const runOver = async (
  base: readonly RowChange[],
  extra: readonly RowChange[],
  cfg: TreeConfig = config,
): Promise<FoldRun> => {
  const run = await FoldRun.open(cfg);
  await run.fold(base);
  if (extra.length > 0) {
    await run.fold(extra);
  }
  return run;
};

const rowsOf = (ids: readonly string[], size: number, fill = "x"): RowChange[] =>
  ids.map((id) => ({ id, value: sizedRow(id, size, fill) }));

const ids = fc.stringMatching(/^[a-z0-9]{1,2}$/);
const changeArb = fc
  .record({ id: ids, size: fc.option(fc.integer({ min: 11, max: 60 }), { freq: 4 }) })
  .map(({ id, size }): RowChange => ({
    id,
    value: size === null ? null : (sizedRow(id, size, "y") as DocumentData),
  }));
const scenario = {
  base: fc.uniqueArray(ids, { minLength: 1, maxLength: 120 }),
  extra: fc.array(changeArb, { maxLength: 20 }),
  changes: fc.array(changeArb, { minLength: 1, maxLength: 60 }),
  window: fc.integer({ min: 1, max: 20 }),
  layout: fc.constantFrom("small", "depth-0"),
};

describe("a prefetching planner plans as one that reads on demand", () => {
  fcTest.prop(scenario, { numRuns: 60 })(
    "with an unbounded budget: same changes, reads, GETs, charge and sealed keys",
    async ({ base, extra, changes, window, layout }) => {
      const cfg = configs[layout as keyof typeof configs];
      const run = await runOver(rowsOf(base, 30), extra, cfg);
      const mutations = mutationsOf(changes);
      const serial = await drive(run, cfg, mutations, { budget: UNBOUNDED, parallelGets: 1 });
      const parallel = await drive(run, cfg, mutations, { budget: UNBOUNDED, window });
      expect(serial.planner.accepted).toBe(mutations.length);
      expect(observed(parallel)).toEqual(observed(serial));
    },
  );

  fcTest.prop({ ...scenario, budget: fc.integer({ min: 0, max: 400 }) }, { numRuns: 60 })(
    "under any budget: every GET charged, the charge within it, the plan canonical for its prefix",
    async ({ base, extra, changes, window, layout, budget }) => {
      const cfg = configs[layout as keyof typeof configs];
      const run = await runOver(rowsOf(base, 30), extra, cfg);
      const mutations = mutationsOf(changes);
      const parallel = await drive(run, cfg, mutations, { budget, window });
      const { planner } = parallel;
      expect(parallel.calls).toBe(planner.gets);
      if (planner.accepted > 0) {
        expect(planner.charge).toBeLessThanOrEqual(budget);
      }
      expect(
        FOLD_SPENT_BEFORE_PLANNING + planner.gets * TREE_RETRIED_CALL_CHARGE,
      ).toBeLessThanOrEqual(Math.max(budget, FOLD_SPENT_BEFORE_PLANNING));
      const prefix = await drive(run, cfg, mutations.slice(0, planner.accepted), {
        budget: UNBOUNDED,
        parallelGets: 1,
      });
      expect(parallel.sealed).toEqual(prefix.sealed);
    },
  );
});

describe("prefetched GETs run concurrently, within the width", () => {
  /** 400 rows at 30 bytes: a small-layout tree of many leaves, at depth 2 or more. */
  const base = Array.from({ length: 400 }, (_, i) => `r${String(i).padStart(3, "0")}`);
  /** 48 updates scattered over the rows. */
  const scattered = Array.from({ length: 48 }, (_, i) => base[(i * 97) % base.length]!);

  test("the reads of a window overlap, at most TREE_FOLD_PARALLEL_CALLS at once", async () => {
    const run = await runOver(rowsOf(base, 30), []);
    expect((await run.captured())!.node.level).toBeGreaterThanOrEqual(2);
    const mutations = mutationsOf(rowsOf(scattered, 31, "z"));
    const parallel = await drive(run, config, mutations, { budget: UNBOUNDED, delay: true });
    expect(parallel.maxInFlight).toBeGreaterThan(1);
    expect(parallel.maxInFlight).toBeLessThanOrEqual(TREE_FOLD_PARALLEL_CALLS);
    const serial = await drive(run, config, mutations, {
      budget: UNBOUNDED,
      parallelGets: 1,
      delay: true,
    });
    expect(serial.maxInFlight).toBe(1);
    expect(observed(parallel)).toEqual(observed(serial));
  });

  test("a narrower width bounds the reads in flight", async () => {
    const run = await runOver(rowsOf(base, 30), []);
    const mutations = mutationsOf(rowsOf(scattered, 31, "z"));
    const narrow = await drive(run, config, mutations, {
      budget: UNBOUNDED,
      parallelGets: 2,
      delay: true,
    });
    expect(narrow.maxInFlight).toBe(2);
  });
});

describe("prefetch coverage and failures", () => {
  const base = Array.from({ length: 400 }, (_, i) => `r${String(i).padStart(3, "0")}`);

  /** The key of the leaf that holds row `id`: the one stored body that holds its document. */
  const leafOf = (run: FoldRun, id: string): string => {
    const text = new TextDecoder();
    const keys = [...run.store]
      .filter(([, bytes]) => text.decode(bytes).includes(`{"_id":"${id}"`))
      .map(([key]) => key);
    expect(keys).toHaveLength(1);
    return keys[0]!;
  };

  test("an accepted window reads every leaf on its paths ahead: no leaf GET on demand", async () => {
    const run = await runOver(rowsOf(base, 30), []);
    expect((await run.captured())!.node.level).toBeGreaterThanOrEqual(2);
    // Same-size updates re-chunk only their own leaf; on demand, a change
    // still reads the branch neighbours its upper levels resync over.
    const updates = Array.from({ length: 48 }, (_, i) => base[(i * 97) % base.length]!);
    const parallel = await drive(run, config, mutationsOf(rowsOf(updates, 30, "z")), {
      budget: UNBOUNDED,
    });
    expect(parallel.planner.accepted).toBe(updates.length);
    expect(parallel.planner.gets).toBeGreaterThan(updates.length / 2);
    expect(parallel.onDemand.length).toBeLessThan(parallel.planner.gets);
    const text = new TextDecoder();
    const levels = parallel.onDemand.map(
      (key) => (JSON.parse(text.decode(run.store.get(key)!)) as { level: number }).level,
    );
    expect(levels.filter((level) => level === 0)).toEqual([]);
  });

  test("a prefetched GET that failed throws its own error only when a change needs the node, with no second GET", async () => {
    const run = await runOver(rowsOf(base, 30), []);
    const broken = leafOf(run, "r200");
    const failure = new Error("injected GET failure");
    let brokenGets = 0;
    const fail = (key: string) => {
      if (key === broken) {
        brokenGets += 1;
        return failure;
      }
      return undefined;
    };
    const mutations = mutationsOf(rowsOf(["r010", "r200", "r390"], 30, "z"));

    // The window reads r200's leaf ahead; the change before it is unaffected.
    const serial = await drive(run, config, mutations.slice(0, 1), {
      budget: UNBOUNDED,
      parallelGets: 1,
    });
    const planner = new FoldPlanner({
      prefix: FOLD_PREFIX,
      root: await run.captured(),
      chunkKey,
      get: async (key) => {
        const error = fail(key);
        if (error !== undefined) {
          throw error;
        }
        return run.store.get(key) ?? null;
      },
      config,
      budget: UNBOUNDED,
      spent: FOLD_SPENT_BEFORE_PLANNING,
    });
    await planner.prefetch(mutations);
    expect(brokenGets).toBe(1);
    await expect(planner.add(mutations[0]!)).resolves.toBe(true);
    const gets = planner.gets;
    expect(planner.plan!.read.map((n) => n.key)).toEqual(
      serial.planner.plan!.read.map((n) => n.key),
    );
    await expect(planner.add(mutations[1]!)).rejects.toBe(failure);
    expect(brokenGets).toBe(1);
    expect(planner.gets).toBe(gets);
  });

  test("a prefetched GET that failed for a node no change needs never surfaces", async () => {
    const run = await runOver(rowsOf(base, 30), []);
    const broken = leafOf(run, "r390");
    const mutations = mutationsOf(rowsOf(["r010", "r390"], 30, "z"));
    const parallel = await drive(run, config, mutations.slice(0, 1), { budget: UNBOUNDED });
    const failing = await drive(run, config, mutations, {
      budget: UNBOUNDED,
      window: 2,
      fail: (key) => (key === broken ? new Error("injected GET failure") : undefined),
    }).catch((error: unknown) => error);
    // The window holds both changes, so the second one's leaf is read and fails...
    expect(failing).toMatchObject({ message: "injected GET failure" });
    // ...but a planner that prefetched it and adds only the first change plans as without it.
    const planner = new FoldPlanner({
      prefix: FOLD_PREFIX,
      root: await run.captured(),
      chunkKey,
      get: async (key) => {
        if (key === broken) {
          throw new Error("injected GET failure");
        }
        return run.store.get(key) ?? null;
      },
      config,
      budget: UNBOUNDED,
      spent: FOLD_SPENT_BEFORE_PLANNING,
    });
    await planner.prefetch(mutations);
    await expect(planner.add(mutations[0]!)).resolves.toBe(true);
    expect(planner.plan!.read.map((n) => n.key)).toEqual(
      parallel.planner.plan!.read.map((n) => n.key),
    );
  });
});
