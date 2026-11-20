/**
 * Acceptance for the prototype tree reader
 * (`packages/server/src/tree/read.ts`): point, range, count and
 * complete-scan reads over the base a head names plus the unfolded log
 * tail.
 *
 * - The reader equals the logical oracle (`tree-oracle-logical.ts`)
 *   after any sequence of commits, folds, crashed folds and stale tail
 *   hints, and leaves the bucket unchanged.
 * - A tail delete hides a row a base leaf still holds and a later insert
 *   brings it back, for every read shape, with the row's leaf in every
 *   fold state.
 * - Routing: a point miss fetches at most the leaf whose range contains
 *   the `_id`, a range fetches exactly the nodes it intersects, and a
 *   miss outside every range or an empty tree fetches no leaf.
 * - Scan admission: a range, count or scan whose base bound, every
 *   attempt charged, is over the ledger left refuses with
 *   `CapacityExceeded` before its first base GET; a point read is served
 *   at any depth on the Free ledger.
 *
 * Buckets are written by `tests/fixtures/tree-bucket.ts`. The `mutation`
 * block shows each check goes red under its mutant from
 * `tests/fixtures/tree-mutants.ts`.
 */
import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import {
  BaerlyError,
  CF_FREE_EXTERNAL_REQUEST_LIMIT,
  CF_FREE_INTERNAL_REQUEST_LIMIT,
  CF_PAID_REQUEST_LIMIT,
  type DocumentData,
  RequestLedger,
  type Storage,
} from "@baerly/protocol";
import {
  createObservabilityContext,
  runWithContext,
} from "../../packages/server/src/observability/context.ts";
import { TREE_LAYOUT, type TreeConfig } from "../../packages/server/src/tree/layout.ts";
import {
  countTree,
  readTreePoint,
  readTreeRange,
  readTreeScan,
  type TreeRange,
  type TreeReadTarget,
  treePointReadBound,
  treeScanBaseCalls,
} from "../../packages/server/src/tree/read.ts";
import { TREE_RETRIED_CALL_CHARGE } from "../../packages/server/src/tree/constants.ts";
import { wrapCountingStorage } from "../fixtures/counting-storage.ts";
import { ledgeredStorage } from "../fixtures/ledgered-storage.ts";
import { type BucketChange, TreeBucket } from "../fixtures/tree-bucket.ts";
import { configOf, NO_DEPTH_ZERO, SMALL_LAYOUT, sizedRow } from "../fixtures/tree-fold-harness.ts";
import {
  READ_DESCENDS_EVERY_CHILD,
  READ_IGNORES_TAIL_DELETES,
  READ_REFRESHES_TAIL_HINT,
  SCAN_SKIPS_ADMISSION,
  type TreeMutant,
} from "../fixtures/tree-mutants.ts";
import {
  type LogicalRange,
  type LogicalView,
  compareUtf8,
  readPoint,
  readRange,
  readScan,
} from "../fixtures/tree-oracle-logical.ts";

const SMALL = configOf(SMALL_LAYOUT);
const PRODUCTION = configOf(TREE_LAYOUT);

// ---------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------

const isNodeKey = (key: string): boolean => key.includes("/_v99/n/");

/** `bucket`'s storage behind a recorder of GET keys and op counters. */
const instrument = (bucket: TreeBucket, config: TreeConfig) => {
  const counting = wrapCountingStorage(bucket.storage);
  const gets: string[] = [];
  const recorded: Storage = {
    get: (key, opts) => {
      gets.push(key);
      return counting.storage.get(key, opts);
    },
    put: (key, body, opts) => counting.storage.put(key, body, opts),
    delete: (key, opts) => counting.storage.delete(key, opts),
    list: (prefix, opts) => counting.storage.list(prefix, opts),
  };
  const target = (storage: Storage = recorded): TreeReadTarget => ({
    storage,
    prefix: bucket.prefix,
    config,
  });
  return {
    counting,
    gets,
    target,
    /** The node keys GET since the last reset. */
    nodeGets: () => gets.filter(isNodeKey),
    reset: () => {
      gets.length = 0;
      counting.reset();
    },
  };
};

/** Run `fn` with a request ledger of `limit` storage calls on both pools. */
const underLedger = <T>(limits: { internal: number; external: number }, fn: () => Promise<T>) =>
  runWithContext(
    createObservabilityContext({
      ledger: new RequestLedger(limits),
      readEnvelope: { requestPool: "internal" },
    }),
    fn,
  );

const FREE = { internal: CF_FREE_INTERNAL_REQUEST_LIMIT, external: CF_FREE_EXTERNAL_REQUEST_LIMIT };
const PAID = { internal: CF_PAID_REQUEST_LIMIT, external: CF_PAID_REQUEST_LIMIT };

const json = (value: unknown): string => JSON.stringify(value);

const sameRows = (left: readonly DocumentData[], right: readonly DocumentData[]): boolean => {
  try {
    expect(left).toEqual(right);
    return true;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------------
// Reads against the oracle
// ---------------------------------------------------------------------

/** Compare every read shape on `target` against `view`; return the first difference. */
const compareReads = async (
  target: TreeReadTarget,
  view: LogicalView,
  points: readonly string[],
  ranges: readonly LogicalRange[],
): Promise<string | undefined> => {
  const scan = await readTreeScan(target);
  if (!sameRows(scan, readScan(view))) {
    return `scan ${json(scan)}, oracle ${json(readScan(view))}`;
  }
  const count = await countTree(target);
  if (count !== view.rows.size) {
    return `count ${count}, oracle ${view.rows.size}`;
  }
  for (const id of points) {
    const got = await readTreePoint(target, id);
    const want = readPoint(view, id);
    if (!sameRows(got === undefined ? [] : [got], want === undefined ? [] : [want])) {
      return `point ${json(id)}: ${json(got)}, oracle ${json(want)}`;
    }
  }
  for (const range of ranges) {
    const got = await readTreeRange(target, range as TreeRange);
    const want = readRange(view, range);
    if (!sameRows(got, want)) {
      return `range ${json(range)}: ${json(got)}, oracle ${json(want)}`;
    }
    const counted = await countTree(target, range as TreeRange);
    if (counted !== want.length) {
      return `count ${json(range)}: ${counted}, oracle ${want.length}`;
    }
  }
  return undefined;
};

/**
 * Reads must not write: no PUT or DELETE reaches storage and the bucket
 * image is byte-identical afterwards.
 */
const pureReads = async (
  bucket: TreeBucket,
  config: TreeConfig,
  reads: (target: TreeReadTarget) => Promise<string | undefined>,
): Promise<string | undefined> => {
  const probe = instrument(bucket, config);
  const before = await bucket.image();
  const failure = await reads(probe.target());
  if (failure !== undefined) {
    return failure;
  }
  if (probe.counting.puts !== 0 || probe.counting.deletes !== 0) {
    return `reads issued ${probe.counting.puts} PUTs and ${probe.counting.deletes} DELETEs`;
  }
  const after = await bucket.image();
  if (json([...before]) !== json([...after])) {
    return "the bucket image changed across reads";
  }
  return undefined;
};

// ---------------------------------------------------------------------
// Property: equals the logical oracle
// ---------------------------------------------------------------------

const IDS = [
  "a",
  "b",
  "k1",
  "k10",
  "k2",
  "n",
  "z",
  "é",
  "é",
  "�",
  "\u{10000}",
  "\u{1F600}x",
] as const;
const idArb = fc.constantFrom(...IDS);
const boundArb = fc.constantFrom(...IDS, "", "k", "m", "\u{10FFFF}");

type Op =
  | { readonly kind: "commit"; readonly changes: readonly BucketChange[] }
  | { readonly kind: "fold"; readonly crash: boolean; readonly part: number }
  | { readonly kind: "hint"; readonly part: number };

const changeArb: fc.Arbitrary<BucketChange> = fc
  .record({
    id: idArb,
    size: fc.option(fc.integer({ min: 11, max: 60 }), { freq: 3 }),
    fill: fc.constantFrom("a", "b"),
  })
  .map(({ id, size, fill }) => ({ id, value: size === null ? null : sizedRow(id, size, fill) }));

/**
 * How much of the pending tail a fold or a hint covers, in quarters. A
 * biased `fc.double` would pick values near 0 so often that folds would
 * rarely fold anything.
 */
const QUARTERS = fc.integer({ min: 0, max: 4 }).map((n) => n / 4);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc
      .array(changeArb, { minLength: 1, maxLength: 6 })
      .map((changes) => ({ kind: "commit" as const, changes })),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      kind: fc.constant("fold" as const),
      crash: fc.constantFrom(false, false, true),
      part: QUARTERS,
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant("hint" as const),
      part: QUARTERS,
    }),
  },
);

const rangeArb: fc.Arbitrary<LogicalRange> = fc
  .record({
    lower: fc.option(fc.record({ strict: fc.boolean(), id: boundArb })),
    upper: fc.option(fc.record({ strict: fc.boolean(), id: boundArb })),
  })
  .map(({ lower, upper }) => {
    const range: { gt?: string; gte?: string; lt?: string; lte?: string } = {};
    if (lower !== null) {
      range[lower.strict ? "gt" : "gte"] = lower.id;
    }
    if (upper !== null) {
      range[upper.strict ? "lt" : "lte"] = upper.id;
    }
    return range;
  });

const scheduleArb = fc.record({
  config: fc.constantFrom(SMALL, PRODUCTION),
  ops: fc.array(opArb, { minLength: 1, maxLength: 10 }),
  ranges: fc.array(rangeArb, { minLength: 1, maxLength: 3 }),
});

/** Run `ops` on a fresh bucket and compare every read after every op; the first difference. */
const oracleMismatch = async (
  schedule: {
    readonly config: TreeConfig;
    readonly ops: readonly Op[];
    readonly ranges: readonly LogicalRange[];
  },
  readConfig: TreeConfig = schedule.config,
): Promise<string | undefined> => {
  const bucket = await TreeBucket.open(schedule.config);
  for (const [index, op] of schedule.ops.entries()) {
    if (op.kind === "commit") {
      await bucket.commit(op.changes);
    } else if (op.kind === "fold") {
      const through = bucket.floor + Math.round(op.part * (bucket.tail - bucket.floor));
      await bucket.fold({ through, crash: op.crash });
    } else {
      await bucket.setTailHint(bucket.floor + Math.round(op.part * (bucket.tail - bucket.floor)));
    }
    const failure = await pureReads(bucket, readConfig, (target) =>
      compareReads(target, bucket.view(), IDS, schedule.ranges),
    );
    if (failure !== undefined) {
      return `after op ${index} (${op.kind}): ${failure}`;
    }
  }
  return undefined;
};

describe("equals the logical oracle", () => {
  fcTest.prop({ schedule: scheduleArb })(
    "after any commits, folds, crashed folds and tail hints, every read shape matches and writes nothing",
    async ({ schedule }) => {
      await expect(oracleMismatch(schedule)).resolves.toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------
// Tail delete hides, later insert restores, in every fold state
// ---------------------------------------------------------------------

interface HideScenario {
  readonly name: string;
  readonly config: TreeConfig;
  readonly neighbors: readonly DocumentData[];
  readonly id: string;
  readonly size: number;
}

/** `n` IDs `<prefix><i>`, zero-padded to one width so byte order is index order. */
const names = (prefix: string, n: number): string[] => {
  const width = String(n - 1).length;
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(width, "0")}`);
};

const HIDE_SCENARIOS: readonly HideScenario[] = [
  {
    name: "the root leaf of a depth-0 tree",
    config: PRODUCTION,
    neighbors: names("n", 5).map((id) => ({ _id: id })),
    id: "n02a",
    size: 40,
  },
  {
    name: "the first leaf of a deep tree",
    config: SMALL,
    neighbors: names("n", 40).map((id) => ({ _id: id })),
    id: "a",
    size: 13,
  },
  {
    name: "a middle leaf of a deep tree",
    config: SMALL,
    neighbors: names("n", 40).map((id) => ({ _id: id })),
    id: "n20a",
    size: 14,
  },
  {
    name: "the last leaf of a deep tree",
    config: SMALL,
    neighbors: names("n", 40).map((id) => ({ _id: id })),
    id: "z",
    size: 13,
  },
  {
    name: "an isolated leaf",
    config: configOf(NO_DEPTH_ZERO),
    neighbors: names("n", 40).map((id) => sizedRow(id, 1024)),
    id: "n20a",
    size: TREE_LAYOUT.leafIsolationDocumentBytes,
  },
];

type FoldMode = "none" | "fold" | "crash";
const FOLD_MODES: readonly FoldMode[] = ["none", "fold", "crash"];

/** Every assignment of a fold mode after each of `n` steps. */
const foldSchedules = (n: number): FoldMode[][] => {
  let schedules: FoldMode[][] = [[]];
  for (let step = 0; step < n; step++) {
    const longer: FoldMode[][] = [];
    for (const schedule of schedules) {
      for (const mode of FOLD_MODES) {
        longer.push(schedule.concat(mode));
      }
    }
    schedules = longer;
  }
  return schedules;
};

/**
 * Insert `id`, delete it, insert it again with a new body, folding (or
 * crashing a fold) after each step per `modes`. After each step every
 * read shape must match the oracle and say whether `id` is visible.
 * Records each state it reached: whether the base holds `id`, and the
 * tail's last write to it.
 */
const hideAndRestore = async (
  scenario: HideScenario,
  modes: readonly FoldMode[],
  readConfig: TreeConfig,
  states: Set<string>,
): Promise<string | undefined> => {
  const bucket = await TreeBucket.open(scenario.config);
  await bucket.commit(scenario.neighbors.map((row) => ({ id: row["_id"] as string, value: row })));
  await bucket.fold();
  const first = sizedRow(scenario.id, scenario.size, "a");
  const second = sizedRow(scenario.id, scenario.size, "b");
  const steps: readonly [BucketChange, DocumentData | undefined][] = [
    [{ id: scenario.id, value: first }, first],
    [{ id: scenario.id, value: null }, undefined],
    [{ id: scenario.id, value: second }, second],
  ];
  const ranges: LogicalRange[] = [{ gte: scenario.id, lte: scenario.id }, { lte: scenario.id }];
  for (const [index, [change, visible]] of steps.entries()) {
    await bucket.commit([change]);
    if (modes[index] !== "none") {
      await bucket.fold({ crash: modes[index] === "crash" });
    }
    const baseHolds = bucket.rowsAt(bucket.floor).rows.has(scenario.id);
    const last = bucket.log.slice(bucket.floor).findLast((e) => e.doc_id === scenario.id);
    let tail = "none";
    if (last !== undefined) {
      tail = last.op === "D" ? "delete" : "write";
    }
    states.add(json({ baseHolds, tail }));
    const where = `step ${index} (${modes.slice(0, index + 1).join(", ")})`;
    const probe = instrument(bucket, readConfig);
    const target = probe.target();
    const got = await readTreePoint(target, scenario.id);
    if (!sameRows(got === undefined ? [] : [got], visible === undefined ? [] : [visible])) {
      return `${where}: point read ${json(got)}, expected ${json(visible)}`;
    }
    const [inRange] = await readTreeRange(target, { gte: scenario.id, lte: scenario.id });
    if (!sameRows(inRange === undefined ? [] : [inRange], visible === undefined ? [] : [visible])) {
      return `${where}: range read ${json(inRange)}, expected ${json(visible)}`;
    }
    const expectedCount = scenario.neighbors.length + (visible === undefined ? 0 : 1);
    const count = await countTree(target);
    if (count !== expectedCount) {
      return `${where}: count ${count}, expected ${expectedCount}`;
    }
    const scan = await readTreeScan(target);
    const scanned = scan.some((row) => row["_id"] === scenario.id);
    if (scanned !== (visible !== undefined)) {
      return `${where}: scan ${scanned ? "shows" : "hides"} ${scenario.id}`;
    }
    const failure = await compareReads(target, bucket.view(), [scenario.id], ranges);
    if (failure !== undefined) {
      return `${where}: ${failure}`;
    }
  }
  return undefined;
};

/** Every row state a scenario must reach: whether the base holds the row, and the tail's last write to it. */
const HIDE_STATES = [true, false].flatMap((baseHolds) =>
  ["none", "write", "delete"].map((tail) => json({ baseHolds, tail })),
);

/** Run every fold schedule of `scenario`; the first failure, or a state it never reached. */
const hideAndRestoreScenario = async (
  scenario: HideScenario,
  mutant?: TreeMutant,
): Promise<string | undefined> => {
  const states = new Set<string>();
  const readConfig = configOf(scenario.config.layout, mutant);
  for (const modes of foldSchedules(3)) {
    const failure = await hideAndRestore(scenario, modes, readConfig, states);
    if (failure !== undefined) {
      return `${scenario.name}: ${failure}`;
    }
  }
  const missing = HIDE_STATES.filter((state) => !states.has(state));
  return missing.length === 0 ? undefined : `${scenario.name}: never reached ${missing.join(", ")}`;
};

const hideAndRestoreAll = async (mutant?: TreeMutant): Promise<string | undefined> => {
  for (const scenario of HIDE_SCENARIOS) {
    const failure = await hideAndRestoreScenario(scenario, mutant);
    if (failure !== undefined) {
      return failure;
    }
  }
  return undefined;
};

describe("a tail delete hides a base row and a later insert restores it", () => {
  test.each(HIDE_SCENARIOS.map((scenario) => [scenario.name, scenario] as const))(
    "in %s, for point, range, count and scan, in every fold state",
    { timeout: 30_000 },
    async (_name, scenario) => {
      await expect(hideAndRestoreScenario(scenario)).resolves.toBeUndefined();
    },
  );
});

// ---------------------------------------------------------------------
// Routing: which nodes a read fetches
// ---------------------------------------------------------------------

/** A deep bucket of rows `n00..n39`, folded, with no tail. */
const deepBucket = async (config: TreeConfig = SMALL, rows = 40): Promise<TreeBucket> => {
  const bucket = await TreeBucket.open(config);
  await bucket.commit(names("n", rows).map((id) => ({ id, value: { _id: id } })));
  await bucket.fold();
  return bucket;
};

/** Probe IDs for `bucket`'s tree: every row, the gaps inside and between leaves, and both ends. */
const probeIds = (bucket: TreeBucket): string[] => {
  const ids = new Set<string>(["a", "z"]);
  for (const leaf of bucket.tree!.levels[0]!) {
    ids.add(leaf.summary.lo);
    ids.add(leaf.summary.hi);
    ids.add(`${leaf.summary.lo}a`);
  }
  return [...ids].toSorted(compareUtf8);
};

/**
 * Point reads of every probe ID fetch at most the leaf whose `[lo, hi]`
 * contains it, and no more than `2 + depth` head and node GETs; a live
 * row's read fetches exactly that leaf.
 */
const pointRouting = async (mutant?: TreeMutant): Promise<string | undefined> => {
  const readConfig = configOf(SMALL_LAYOUT, mutant);
  const bucket = await deepBucket();
  const tree = bucket.tree!;
  const depth = tree.levels.length - 1;
  const leaves = tree.levels[0]!;
  const probe = instrument(bucket, readConfig);
  for (const id of probeIds(bucket)) {
    probe.reset();
    const got = await readTreePoint(probe.target(), id);
    const containing = leaves
      .filter(
        (leaf) => compareUtf8(leaf.summary.lo, id) <= 0 && compareUtf8(id, leaf.summary.hi) <= 0,
      )
      .map((leaf) => leaf.key);
    const leafKeys = new Set(leaves.map((leaf) => leaf.key));
    const fetchedLeaves = probe.nodeGets().filter((key) => leafKeys.has(key));
    if (json(fetchedLeaves) !== json(containing)) {
      return `point ${id}: fetched leaves ${json(fetchedLeaves)}, containing ${json(containing)}`;
    }
    const headAndNodes = probe.nodeGets().length + 1;
    if (headAndNodes > treePointReadBound(depth)) {
      return `point ${id}: ${headAndNodes} head and node GETs, over the bound ${treePointReadBound(depth)}`;
    }
    if (got !== undefined && fetchedLeaves.length !== 1) {
      return `point ${id}: a hit fetched ${fetchedLeaves.length} leaves`;
    }
  }
  return undefined;
};

/** Range reads fetch exactly the nodes, at every level below the root, whose `[lo, hi]` intersects them. */
const rangeRouting = async (mutant?: TreeMutant): Promise<string | undefined> => {
  const readConfig = configOf(SMALL_LAYOUT, mutant);
  const bucket = await deepBucket();
  const tree = bucket.tree!;
  const ids = probeIds(bucket);
  const probe = instrument(bucket, readConfig);
  const below = tree.levels.slice(0, -1).flat();
  const ranges: TreeRange[] = [];
  for (const a of ids) {
    ranges.push({ gte: a }, { lt: a });
    for (const b of ids) {
      ranges.push({ gte: a, lte: b }, { gt: a, lt: b });
    }
  }
  for (const range of ranges) {
    probe.reset();
    await readTreeRange(probe.target(), range);
    const intersects = (lo: string, hi: string): boolean =>
      (range.gt === undefined || compareUtf8(hi, range.gt) > 0) &&
      (range.gte === undefined || compareUtf8(hi, range.gte) >= 0) &&
      (range.lt === undefined || compareUtf8(lo, range.lt) < 0) &&
      (range.lte === undefined || compareUtf8(lo, range.lte) <= 0);
    const expected = below
      .filter((node) => intersects(node.summary.lo, node.summary.hi))
      .map((node) => node.key)
      .toSorted();
    const fetched = probe
      .nodeGets()
      .filter((key) => key !== tree.root!.key)
      .toSorted();
    if (json(fetched) !== json(expected)) {
      return `range ${json(range)}: fetched ${fetched.length} nodes, ${expected.length} intersect`;
    }
  }
  return undefined;
};

describe("routing", () => {
  test("the deep fixture has depth 3 or more and several leaves", async () => {
    const bucket = await deepBucket();
    const tree = bucket.tree!;
    expect(tree.levels.length - 1).toBeGreaterThanOrEqual(3);
    expect(tree.levels[0]!.length).toBeGreaterThan(8);
  });

  test("a point read fetches at most the leaf whose range contains the _id, within 2 + depth GETs", async () => {
    await expect(pointRouting()).resolves.toBeUndefined();
  });

  test("a range fetches exactly the nodes it intersects", async () => {
    await expect(rangeRouting()).resolves.toBeUndefined();
  });

  test("an empty root and a fresh head fetch no node", async () => {
    const fresh = await TreeBucket.open(SMALL);
    const emptied = await deepBucket(SMALL, 4);
    await emptied.commit(names("n", 4).map((id) => ({ id, value: null })));
    await emptied.fold();
    expect(emptied.tree?.root).toBeNull();
    for (const bucket of [fresh, emptied]) {
      const probe = instrument(bucket, SMALL);
      await expect(readTreePoint(probe.target(), "n01")).resolves.toBeUndefined();
      await expect(readTreeRange(probe.target(), { gte: "a" })).resolves.toEqual([]);
      await expect(readTreeScan(probe.target())).resolves.toEqual([]);
      await expect(countTree(probe.target())).resolves.toBe(0);
      expect(probe.nodeGets()).toEqual([]);
    }
  });

  test("a point read the tail decides fetches no node below the root", async () => {
    const bucket = await deepBucket();
    await bucket.commit([
      { id: "n05", value: null },
      { id: "n06", value: { _id: "n06", v: 2 } },
    ]);
    const probe = instrument(bucket, SMALL);
    await expect(readTreePoint(probe.target(), "n05")).resolves.toBeUndefined();
    await expect(readTreePoint(probe.target(), "n06")).resolves.toEqual({ _id: "n06", v: 2 });
    expect(probe.nodeGets()).toEqual([bucket.tree!.root!.key, bucket.tree!.root!.key]);
  });
});

// ---------------------------------------------------------------------
// Reads are pure
// ---------------------------------------------------------------------

/** Every read shape on a deep tree with a tail issues no write and leaves the bucket unchanged. */
const readsArePure = async (mutant?: TreeMutant): Promise<string | undefined> => {
  const readConfig = configOf(SMALL_LAYOUT, mutant);
  const bucket = await deepBucket();
  await bucket.commit([
    { id: "n03", value: null },
    { id: "n31a", value: { _id: "n31a" } },
  ]);
  await bucket.setTailHint(bucket.floor + 1);
  return pureReads(bucket, readConfig, async (target) => {
    await readTreePoint(target, "n10");
    await readTreePoint(target, "n03");
    await readTreeRange(target, { gte: "n10", lt: "n20" });
    await countTree(target);
    await readTreeScan(target);
    return undefined;
  });
};

describe("reads are pure", () => {
  test("no read shape issues a PUT or DELETE, and the bucket is unchanged", async () => {
    await expect(readsArePure()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Scan admission
// ---------------------------------------------------------------------

/** Storage calls a cold read spends before admission on a bucket with no tail past `tail_hint`. */
const spentBeforeAdmission = (bucket: TreeBucket): number =>
  // head + root + the strict walk + the probe's entries and closing empty slot.
  2 + (bucket.tail - bucket.floor) + 1;

const scanCharge = (bucket: TreeBucket): number => {
  const root = bucket.tree!.root!;
  return (
    treeScanBaseCalls(root.summary.bytes, bucket.tree!.levels.length - 1, bucket.config.layout) *
    TREE_RETRIED_CALL_CHARGE
  );
};

/**
 * Under a ledger one call short of the scan's charge (after the head,
 * root and tail), a range, count and scan each refuse with
 * `CapacityExceeded`, fetch nothing below the root and write nothing;
 * with that one call more the scan is served.
 */
const admissionBoundary = async (mutant?: TreeMutant): Promise<string | undefined> => {
  const readConfig = configOf(SMALL_LAYOUT, mutant);
  const bucket = await deepBucket();
  await bucket.commit([
    { id: "n07", value: null },
    { id: "n40", value: { _id: "n40" } },
  ]);
  const limit = spentBeforeAdmission(bucket) + scanCharge(bucket);
  const probe = instrument(bucket, readConfig);
  const shapes: readonly [string, (t: TreeReadTarget) => Promise<unknown>][] = [
    ["scan", (t) => readTreeScan(t)],
    ["range", (t) => readTreeRange(t, { gte: "n10" })],
    ["count", (t) => countTree(t)],
  ];
  for (const [name, read] of shapes) {
    probe.reset();
    const ledgered = ledgeredStorage(probe.target().storage, "internal");
    let caught: unknown;
    try {
      await underLedger({ internal: limit - 1, external: limit - 1 }, () =>
        read(probe.target(ledgered)),
      );
    } catch (error) {
      caught = error;
    }
    const belowRoot = probe.nodeGets().filter((key) => key !== bucket.tree!.root!.key).length;
    if (belowRoot > 0) {
      return `${name}: issued ${belowRoot} base GETs before ${caught === undefined ? "being served" : "refusing"}`;
    }
    if (!(caught instanceof BaerlyError) || caught.code !== "CapacityExceeded") {
      return `${name}: expected CapacityExceeded, got ${String(caught)}`;
    }
    if ((caught.cause as { bound?: string } | undefined)?.bound !== "scanStorageCalls") {
      return `${name}: refused by ${json(caught.cause)}, not the scan admission check`;
    }
    if (probe.counting.puts !== 0 || probe.counting.deletes !== 0) {
      return `${name}: a refusal wrote`;
    }
  }
  probe.reset();
  const served = await underLedger({ internal: limit, external: limit }, () =>
    readTreeScan(probe.target(ledgeredStorage(probe.target().storage, "internal"))),
  );
  if (!sameRows(served, readScan(bucket.view()))) {
    return "the scan at exactly its charge was not served correctly";
  }
  return undefined;
};

/**
 * Under a ledger too small for even the nodes the scan would really
 * fetch, the scan refuses through the admission check with no base GET,
 * rather than being cut off by the ledger partway through its base.
 */
const overLedgerScan = async (mutant?: TreeMutant): Promise<string | undefined> => {
  const bucket = await deepBucket();
  const tree = bucket.tree!;
  const belowRoot = tree.levels.slice(0, -1).flat().length;
  const limit = spentBeforeAdmission(bucket) + belowRoot - 1;
  const probe = instrument(bucket, configOf(SMALL_LAYOUT, mutant));
  let caught: unknown;
  try {
    await underLedger({ internal: limit, external: limit }, () =>
      readTreeScan(probe.target(ledgeredStorage(probe.target().storage, "internal"))),
    );
  } catch (error) {
    caught = error;
  }
  const issued = probe.nodeGets().filter((key) => key !== tree.root!.key).length;
  if (issued > 0) {
    return `issued ${issued} base GETs before ${caught === undefined ? "being served" : `refusing (${String(caught)})`}`;
  }
  if (
    !(caught instanceof BaerlyError) ||
    (caught.cause as { bound?: string } | undefined)?.bound !== "scanStorageCalls"
  ) {
    return `expected the scan admission refusal, got ${String(caught)}`;
  }
  return undefined;
};

describe("scan admission", () => {
  test("a scan the ledger cannot finish refuses before its first base GET", async () => {
    await expect(overLedgerScan()).resolves.toBeUndefined();
  });

  test("a range, count or scan one call over the ledger refuses before its first base GET; at the ledger it is served", async () => {
    await expect(admissionBoundary()).resolves.toBeUndefined();
  });

  test("a point read is served one call over the scan charge", async () => {
    const bucket = await deepBucket();
    const limit = spentBeforeAdmission(bucket) + scanCharge(bucket);
    const probe = instrument(bucket, SMALL);
    await expect(
      underLedger({ internal: limit - 1, external: limit - 1 }, () =>
        readTreePoint(probe.target(ledgeredStorage(probe.target().storage, "internal")), "n20"),
      ),
    ).resolves.toEqual({ _id: "n20" });
  });

  test("on the Free ledger a deep tree's scan refuses and every point read is served", async () => {
    const bucket = await deepBucket(SMALL, 300);
    const depth = bucket.tree!.levels.length - 1;
    expect(depth).toBeGreaterThanOrEqual(4);
    expect(scanCharge(bucket)).toBeGreaterThan(FREE.internal);
    const probe = instrument(bucket, SMALL);
    const ledgered = () => probe.target(ledgeredStorage(probe.target().storage, "internal"));
    probe.reset();
    await expect(underLedger(FREE, () => readTreeScan(ledgered()))).rejects.toMatchObject({
      code: "CapacityExceeded",
      cause: { bound: "scanStorageCalls" },
    });
    expect(probe.nodeGets()).toEqual([bucket.tree!.root!.key]);
    for (const id of [...names("n", 300).filter((_, i) => i % 7 === 0), "a", "n15a", "z"]) {
      const want = readPoint(bucket.view(), id);
      await expect(underLedger(FREE, () => readTreePoint(ledgered(), id))).resolves.toEqual(want);
    }
  });

  test("a Paid-size tree at the production layout: Free refuses its scan and serves point reads, Paid serves the scan", async () => {
    const bucket = await TreeBucket.open(PRODUCTION);
    const rows = names("p", 2048).map((id) => ({ id, value: sizedRow(id, 4096) }));
    await bucket.commit(rows);
    await bucket.fold();
    const root = bucket.tree!.root!;
    expect(root.summary.bytes).toBe(8 * 1024 * 1024);
    const depth = bucket.tree!.levels.length - 1;
    expect(depth).toBeGreaterThanOrEqual(1);
    const probe = instrument(bucket, PRODUCTION);
    const ledgered = () => probe.target(ledgeredStorage(probe.target().storage, "internal"));
    probe.reset();
    await expect(underLedger(FREE, () => readTreeScan(ledgered()))).rejects.toMatchObject({
      code: "CapacityExceeded",
      cause: { bound: "scanStorageCalls" },
    });
    expect(probe.nodeGets()).toEqual([root.key]);
    for (const id of ["p0000", "p1024", "p2047", "p1024a", "a", "z"]) {
      probe.reset();
      const got = await underLedger(FREE, () => readTreePoint(ledgered(), id));
      expect(got?.["_id"]).toBe(readPoint(bucket.view(), id)?.["_id"]);
      expect(probe.nodeGets().length + 1).toBeLessThanOrEqual(treePointReadBound(depth));
    }
    const scanned = await underLedger(PAID, () => readTreeScan(ledgered()));
    expect(scanned.map((row) => row["_id"])).toEqual(rows.map((row) => row.id));
  });
});

// ---------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------

describe("mutation", () => {
  const checks: readonly (readonly [
    string,
    (mutant?: TreeMutant) => Promise<string | undefined>,
    TreeMutant,
  ])[] = [
    ["reads are pure", readsArePure, READ_REFRESHES_TAIL_HINT],
    ["point routing", pointRouting, READ_DESCENDS_EVERY_CHILD],
    ["range routing", rangeRouting, READ_DESCENDS_EVERY_CHILD],
    ["scan admission at the boundary", admissionBoundary, SCAN_SKIPS_ADMISSION],
    ["the over-ledger scan", overLedgerScan, SCAN_SKIPS_ADMISSION],
    ["hide and restore", hideAndRestoreAll, READ_IGNORES_TAIL_DELETES],
  ];

  test.each(checks.map(([name, check, mutant]) => [mutant.name, name, check, mutant] as const))(
    "%s turns %s red",
    async (_mutant, _check, check, mutant) => {
      await expect(check(mutant)).resolves.toBeDefined();
    },
  );

  test.each([READ_IGNORES_TAIL_DELETES, READ_REFRESHES_TAIL_HINT].map((m) => [m.name, m] as const))(
    "%s turns the oracle property red",
    async (_name, mutant) => {
      const result = await fc.check(
        fc.asyncProperty(scheduleArb, async (schedule) => {
          const mutated = configOf(schedule.config.layout, mutant);
          const mismatch = await oracleMismatch(schedule, mutated);
          return mismatch === undefined;
        }),
        { seed: 20_261_120, numRuns: 200 },
      );
      expect(result.failed).toBe(true);
    },
  );
});
