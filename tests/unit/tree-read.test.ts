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
 * - The read envelope: the head check on the log, staged tail charging,
 *   materialization (base rows for a range, count or scan only) and the
 *   output bound (not for a count).
 * - Stored data: the tail skips what the read path's fold skips, refuses
 *   a surviving post-image whose `_id` is outside the document-ID domain,
 *   and each fetched node is decoded against the entry that named it.
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
  encodeJsonBytes,
  logObjectKey,
  RequestLedger,
  type RequestPool,
  sha256Hex,
  type Storage,
} from "@baerly/protocol";
import {
  createObservabilityContext,
  runWithContext,
} from "../../packages/server/src/observability/context.ts";
import type { ReadEnvelope } from "../../packages/server/src/read-admission.ts";
import { treeHeadKey } from "../../packages/server/src/tree/head.ts";
import { treeNodeKey } from "../../packages/server/src/tree/key.ts";
import {
  TREE_LAYOUT,
  type TreeConfig,
  type TreeLayout,
} from "../../packages/server/src/tree/layout.ts";
import {
  countTree,
  openTreeView,
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

/** Run `fn` with a request ledger of `limits` storage calls per pool, reads charged to `pool`. */
const underLedger = <T>(
  limits: { internal: number; external: number },
  fn: () => Promise<T>,
  pool: RequestPool = "internal",
) =>
  runWithContext(
    createObservabilityContext({
      ledger: new RequestLedger(limits),
      readEnvelope: { requestPool: pool },
    }),
    fn,
  );

/** Run `fn` under the read envelope `envelope`, with no request ledger. */
const underEnvelope = <T>(envelope: ReadEnvelope, fn: () => Promise<T>) =>
  runWithContext(createObservabilityContext({ readEnvelope: envelope }), fn);

/** What `read` threw, or `undefined` when it resolved. */
const thrown = async (read: () => unknown): Promise<unknown> => {
  try {
    await read();
  } catch (error) {
    return error;
  }
  return undefined;
};

/** The `cause.bound` of a `CapacityExceeded` refusal, or a description of what else happened. */
const refusalBound = (caught: unknown): string => {
  if (!(caught instanceof BaerlyError)) {
    return `no refusal (${String(caught)})`;
  }
  if (caught.code !== "CapacityExceeded") {
    return `${caught.code}: ${caught.message}`;
  }
  const cause = caught.cause as { bound?: string; refused?: boolean } | undefined;
  return cause?.bound ?? (cause?.refused === true ? "ledger" : json(cause));
};

/** The `{ internal, external }` limits with `pool` at `limit` and the other pool at `other`. */
const poolLimits = (pool: RequestPool, limit: number, other: number) =>
  pool === "internal" ? { internal: limit, external: other } : { internal: other, external: limit };

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
  // The other pool's limit is far from this one's, so admission sized
  // against the wrong pool decides the other way: a refusal with the other
  // pool far above, and service with the internal pool's other pool at 0.
  // An external call also needs room in the internal pool, so that one
  // stays far above.
  for (const pool of ["internal", "external"] as const) {
    for (const [name, read] of shapes) {
      probe.reset();
      const ledgered = ledgeredStorage(probe.target().storage, pool);
      const caught = await thrown(() =>
        underLedger(
          poolLimits(pool, limit - 1, 100 * limit),
          () => read(probe.target(ledgered)),
          pool,
        ),
      );
      const belowRoot = probe.nodeGets().filter((key) => key !== bucket.tree!.root!.key).length;
      if (belowRoot > 0) {
        return `${pool} ${name}: issued ${belowRoot} base GETs before ${caught === undefined ? "being served" : "refusing"}`;
      }
      if (refusalBound(caught) !== "scanStorageCalls") {
        return `${pool} ${name}: expected the scan admission refusal, got ${refusalBound(caught)}`;
      }
      if (probe.counting.puts !== 0 || probe.counting.deletes !== 0) {
        return `${pool} ${name}: a refusal wrote`;
      }
    }
    probe.reset();
    const served = await underLedger(
      poolLimits(pool, limit, pool === "internal" ? 0 : 100 * limit),
      () => readTreeScan(probe.target(ledgeredStorage(probe.target().storage, pool))),
      pool,
    );
    if (!sameRows(served, readScan(bucket.view()))) {
      return `${pool}: the scan at exactly its charge was not served correctly`;
    }
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
// The read envelope
// ---------------------------------------------------------------------

/** Every read shape, each reading rows the deep fixture holds. */
const READ_SHAPES: readonly [string, (t: TreeReadTarget) => Promise<unknown>][] = [
  ["point", (t) => readTreePoint(t, "n20")],
  ["range", (t) => readTreeRange(t, { gte: "n10" })],
  ["count", (t) => countTree(t)],
  ["scan", (t) => readTreeScan(t)],
];

/** The log keys GET since the last reset. */
const logGets = (probe: ReturnType<typeof instrument>): string[] =>
  probe.gets.filter((key) => key.includes("/log/"));

/** Stored bytes of the log entries `bucket` has not folded. */
const tailBytes = (bucket: TreeBucket): number =>
  bucket.log.slice(bucket.floor).reduce((sum, entry) => sum + encodeJsonBytes(entry).byteLength, 0);

/**
 * A deep bucket with three unfolded entries, all in the strict range
 * `[log_seq_start, tail_hint)` when `strict`, else all past `tail_hint`.
 */
const tailBucket = async (strict: boolean): Promise<TreeBucket> => {
  const bucket = await deepBucket();
  await bucket.commit([
    { id: "n03", value: null },
    { id: "n12", value: { _id: "n12", v: 2 } },
    { id: "n40", value: { _id: "n40" } },
  ]);
  if (strict) {
    await bucket.setTailHint(bucket.tail);
  }
  return bucket;
};

/** Every read shape of `bucket` under `envelope` refuses on `bound`, after `check` passes. */
const refusesEvery = async (
  bucket: TreeBucket,
  envelope: ReadEnvelope,
  bound: string,
  shapes = READ_SHAPES,
  check: (probe: ReturnType<typeof instrument>) => string | undefined = () => undefined,
): Promise<string | undefined> => {
  const probe = instrument(bucket, SMALL);
  for (const [name, read] of shapes) {
    probe.reset();
    const caught = await thrown(() => underEnvelope(envelope, () => read(probe.target())));
    if (refusalBound(caught) !== bound) {
      return `${name} under ${json(envelope)}: expected ${bound}, got ${refusalBound(caught)}`;
    }
    const failure = check(probe);
    if (failure !== undefined) {
      return `${name}: ${failure}`;
    }
    if (probe.counting.puts !== 0 || probe.counting.deletes !== 0) {
      return `${name}: a refusal wrote`;
    }
  }
  return undefined;
};

/** Every read shape of `bucket` under `envelope` equals the oracle. */
const servesEvery = async (
  bucket: TreeBucket,
  envelope: ReadEnvelope,
): Promise<string | undefined> => {
  const target = instrument(bucket, SMALL).target();
  for (const [name, read] of READ_SHAPES) {
    const caught = await thrown(() => underEnvelope(envelope, () => read(target)));
    if (caught !== undefined) {
      return `${name} under ${json(envelope)}: refused (${String(caught)})`;
    }
  }
  return underEnvelope(envelope, () => compareReads(target, bucket.view(), ["n03", "n12"], [{}]));
};

const noLogGet = (probe: ReturnType<typeof instrument>): string | undefined =>
  logGets(probe).length === 0 ? undefined : `GET ${logGets(probe).length} log entries first`;

const noBaseGet =
  (bucket: TreeBucket) =>
  (probe: ReturnType<typeof instrument>): string | undefined => {
    const below = probe.nodeGets().filter((key) => key !== bucket.tree!.root!.key);
    return below.length === 0 ? undefined : `GET ${below.length} nodes below the root first`;
  };

describe("the read envelope", () => {
  test("a strict range over the tail-entry bound refuses every shape before any log GET", async () => {
    const bucket = await tailBucket(true);
    await expect(
      refusesEvery(bucket, { maxTailEntries: 2 }, "tailEntries", READ_SHAPES, noLogGet),
    ).resolves.toBeUndefined();
    await expect(servesEvery(bucket, { maxTailEntries: 3 })).resolves.toBeUndefined();
  });

  test("a strict range the ledger cannot walk refuses every shape before any log GET", async () => {
    const bucket = await tailBucket(true);
    const probe = instrument(bucket, SMALL);
    // The head, the root and the strict range, but not the probe's closing slot.
    const limit = 2 + (bucket.tail - bucket.floor);
    for (const [name, read] of READ_SHAPES) {
      probe.reset();
      const ledgered = ledgeredStorage(probe.target().storage, "internal");
      const caught = await thrown(() =>
        underLedger({ internal: limit, external: limit }, () => read(probe.target(ledgered))),
      );
      expect({ name, bound: refusalBound(caught), logGets: logGets(probe) }).toEqual({
        name,
        bound: "headStorageCalls",
        logGets: [],
      });
    }
    // A point read the tail decides fetches nothing more.
    await expect(
      underLedger({ internal: limit + 1, external: limit + 1 }, () =>
        readTreePoint(probe.target(ledgeredStorage(probe.target().storage, "internal")), "n12"),
      ),
    ).resolves.toEqual({ _id: "n12", v: 2 });
  });

  test("every tail body is charged: entries past tail_hint and bytes in the strict range", async () => {
    const probed = await tailBucket(false);
    const entries = probed.tail - probed.floor;
    await expect(
      refusesEvery(probed, { maxTailEntries: entries - 1 }, "tailEntries"),
    ).resolves.toBeUndefined();
    await expect(servesEvery(probed, { maxTailEntries: entries })).resolves.toBeUndefined();
    for (const bucket of [probed, await tailBucket(true)]) {
      const bytes = tailBytes(bucket);
      await expect(
        refusesEvery(bucket, { maxTailBytes: bytes - 1 }, "tailBytes"),
      ).resolves.toBeUndefined();
      await expect(servesEvery(bucket, { maxTailBytes: bytes })).resolves.toBeUndefined();
    }
  });

  test("a range, count or scan charges the base rows toward materialization before its first base GET; a point read does not", async () => {
    const bucket = await tailBucket(false);
    const materialized = bucket.rowsAt(bucket.floor).rows.size + (bucket.tail - bucket.floor);
    const scans = READ_SHAPES.filter(([name]) => name !== "point");
    await expect(
      refusesEvery(
        bucket,
        { maxMaterializedRows: materialized - 1 },
        "materializedRows",
        scans,
        noBaseGet(bucket),
      ),
    ).resolves.toBeUndefined();
    const target = instrument(bucket, SMALL).target();
    for (const id of ["n03", "n12", "n20", "n40"]) {
      await expect(
        underEnvelope({ maxMaterializedRows: materialized - 1 }, () => readTreePoint(target, id)),
      ).resolves.toEqual(readPoint(bucket.view(), id));
    }
    await expect(
      servesEvery(bucket, { maxMaterializedRows: materialized }),
    ).resolves.toBeUndefined();
  });

  test("a range or scan over the output bound is refused whole; a count is not output-bounded", async () => {
    const bucket = await tailBucket(false);
    const rows = bucket.view().rows.size;
    const envelope = { maxOutputRows: rows - 1 };
    await expect(
      refusesEvery(bucket, envelope, "outputRows", [
        ["range", (t) => readTreeRange(t, {})],
        ["scan", (t) => readTreeScan(t)],
      ]),
    ).resolves.toBeUndefined();
    const target = instrument(bucket, SMALL).target();
    await expect(underEnvelope(envelope, () => countTree(target))).resolves.toBe(rows);
    await expect(
      underEnvelope(envelope, () => readTreeRange(target, { gt: "n00" })),
    ).resolves.toHaveLength(rows - 1);
    await expect(servesEvery(bucket, { maxOutputRows: rows })).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Stored data
// ---------------------------------------------------------------------

/** Put a raw log entry at `seq`, outside the bucket's own log. */
const putRawEntry = async (
  bucket: TreeBucket,
  seq: number,
  fields: Record<string, unknown>,
): Promise<void> => {
  const entry = {
    lsn: `raw-${seq}`,
    commit_ts: "2026-01-01T00:00:00.000Z",
    collection: bucket.collection,
    session: "ssn001",
    seq,
    ...fields,
  };
  await bucket.storage.put(logObjectKey(bucket.prefix, seq), encodeJsonBytes(entry), {
    ifNoneMatch: "*",
  });
};

describe("stored data", () => {
  test("the tail skips another collection's entries, an I or U without after, and an entry without doc_id", async () => {
    const bucket = await deepBucket();
    const before = readScan(bucket.view());
    const raw: readonly Record<string, unknown>[] = [
      { op: "D", collection: "other", doc_id: "n05" },
      { op: "I", collection: "other", doc_id: "n05a", after: { _id: "n05a" } },
      { op: "U", doc_id: "n06" },
      { op: "I", doc_id: "n06a" },
      { op: "I", after: { _id: "n07a" } },
    ];
    for (const [i, fields] of raw.entries()) {
      await putRawEntry(bucket, bucket.tail + i, fields);
    }
    const target = instrument(bucket, SMALL).target();
    await expect(readTreeScan(target)).resolves.toEqual(before);
    await expect(countTree(target)).resolves.toBe(before.length);
    await expect(readTreePoint(target, "n05")).resolves.toEqual({ _id: "n05" });
    await expect(readTreePoint(target, "n06")).resolves.toEqual({ _id: "n06" });
    for (const id of ["n05a", "n06a", "n07a"]) {
      await expect(readTreePoint(target, id)).resolves.toBeUndefined();
    }
  });

  test("a surviving tail post-image whose _id is outside the domain refuses every read; a delete of one is ignored", async () => {
    const bad = "\uD800";
    const deleted = await deepBucket();
    await putRawEntry(deleted, deleted.tail, { op: "D", doc_id: bad });
    await expect(readTreeScan(instrument(deleted, SMALL).target())).resolves.toEqual(
      readScan(deleted.view()),
    );

    const bucket = await deepBucket();
    const seq = bucket.tail;
    await putRawEntry(bucket, seq, { op: "I", doc_id: bad, after: { _id: bad } });
    const target = instrument(bucket, SMALL).target();
    for (const [name, read] of [
      ...READ_SHAPES,
      ["range from the empty string", (t: TreeReadTarget) => readTreeRange(t, { gte: "" })],
    ] as const) {
      const caught = await thrown(() => read(target));
      expect(caught).toBeInstanceOf(BaerlyError);
      const { code, message } = caught as BaerlyError;
      expect({ name, code, names: message.includes(`log seq ${seq}`) }).toEqual({
        name,
        code: "InvalidResponse",
        names: true,
      });
    }
  });

  test("a child is decoded against the entry that named it", async () => {
    const bucket = await deepBucket();
    const root = bucket.tree!.root!;
    const body = JSON.parse(new TextDecoder().decode(root.bytes)) as {
      attempt: string;
      children: { attempt: string; sha256: string }[];
    };
    // Entry 0 keeps its range and totals but names entry 1's node, a
    // valid node of the right level whose body fails only against it.
    const [first, second] = body.children;
    first!.attempt = second!.attempt;
    first!.sha256 = second!.sha256;
    const bytes = encodeJsonBytes(body);
    const key = treeNodeKey(bucket.prefix, body.attempt, await sha256Hex(bytes));
    await bucket.storage.put(key, bytes, { ifNoneMatch: "*" });
    const headKey = treeHeadKey(bucket.prefix);
    const head = JSON.parse(
      new TextDecoder().decode((await bucket.storage.get(headKey))!.body),
    ) as { proto_tree: { root: string } };
    head.proto_tree.root = key;
    await bucket.storage.put(headKey, encodeJsonBytes(head));

    const target = instrument(bucket, SMALL).target();
    for (const read of [() => readTreeScan(target), () => readTreePoint(target, "n00")]) {
      const caught = await thrown(read);
      expect(caught).toBeInstanceOf(BaerlyError);
      expect((caught as BaerlyError).code).toBe("InvalidResponse");
      expect((caught as BaerlyError).message).toContain("context check failed");
    }
  });
});

// ---------------------------------------------------------------------
// Caller input
// ---------------------------------------------------------------------

describe("caller input", () => {
  test("a point read of an _id outside the domain is InvalidConfig, before any GET", async () => {
    const bucket = await deepBucket();
    const probe = instrument(bucket, SMALL);
    for (const id of ["\uD800", "", "a/b", "_x"]) {
      probe.reset();
      await expect(readTreePoint(probe.target(), id)).rejects.toMatchObject({
        code: "InvalidConfig",
      });
      expect(probe.gets).toEqual([]);
      const view = await openTreeView(probe.target());
      await expect(view.get(id)).rejects.toMatchObject({ code: "InvalidConfig" });
    }
  });

  test("a malformed range is InvalidConfig for range and count, before any GET", async () => {
    const bucket = await deepBucket();
    const probe = instrument(bucket, SMALL);
    const view = await openTreeView(probe.target());
    const malformed: readonly TreeRange[] = [
      { gt: "a", gte: "a" },
      { lt: "z", lte: "z" },
      { gte: "\uDC00" },
      { lt: 3 as unknown as string },
    ];
    for (const range of malformed) {
      probe.reset();
      const codes: string[] = [];
      const record = async (read: () => unknown): Promise<void> => {
        const caught = await thrown(read);
        codes.push(caught instanceof BaerlyError ? caught.code : String(caught));
      };
      await record(() => readTreeRange(probe.target(), range));
      await record(() => countTree(probe.target(), range));
      const gets = [...probe.gets];
      await record(() => view.range(range));
      await record(() => view.count(range));
      expect({ range, codes, gets }).toEqual({
        range,
        codes: ["InvalidConfig", "InvalidConfig", "InvalidConfig", "InvalidConfig"],
        gets: [],
      });
    }
  });
});

// ---------------------------------------------------------------------
// Concurrency and non-canonical trees
// ---------------------------------------------------------------------

describe("a fold landing mid-read", () => {
  test("the read keeps the root and floor it captured and sees the tail through its own probe", async () => {
    const bucket = await TreeBucket.open(SMALL);
    await bucket.commit(names("n", 30).map((id) => ({ id, value: { _id: id } })));
    await bucket.fold({ through: 20 });
    await bucket.commit([
      { id: "n03", value: null },
      { id: "n25", value: { _id: "n25", v: 2 } },
    ]);
    const capturedRoot = bucket.tree!.root!.key;
    let folded = false;
    const storage: Storage = {
      ...bucket.storage,
      get: async (key, opts) => {
        if (!folded && key.includes("/log/")) {
          folded = true;
          await bucket.fold();
          await bucket.commit([{ id: "n04", value: null }]);
        }
        return bucket.storage.get(key, opts);
      },
      put: (key, body, opts) => bucket.storage.put(key, body, opts),
      delete: (key, opts) => bucket.storage.delete(key, opts),
      list: (prefix, opts) => bucket.storage.list(prefix, opts),
    };
    const view = await openTreeView({ storage, prefix: bucket.prefix, config: SMALL });
    expect(folded).toBe(true);
    expect(bucket.tree!.root!.key).not.toBe(capturedRoot);
    expect(view.head!.root).toBe(capturedRoot);
    expect(view.tail.tail).toBe(bucket.tail);
    await expect(view.scan()).resolves.toEqual(readScan(bucket.view()));
    await expect(view.get("n04")).resolves.toBeUndefined();
    await expect(view.get("n25")).resolves.toEqual({ _id: "n25", v: 2 });
  });
});

/**
 * A layout whose minimum fills are far above the small layout's: read
 * under it, a small-layout tree has many more nodes per level than the
 * scan bound allows, as a non-canonical tree may.
 */
const WIDE_LAYOUT: TreeLayout = {
  leafTargetBytes: 512,
  leafMinBytes: 256,
  leafMaxBytes: 768,
  leafIsolationDocumentBytes: 768,
  branchFanoutMin: 128,
  branchFanoutTarget: 128,
  branchFanoutMax: 256,
  singleLeafMaxBytes: 0,
  singleLeafMaxRows: 0,
};

describe("a non-canonical tree against the scan bound", () => {
  test("an admitted scan of underfilled leaves runs out of ledger partway and returns no rows", async () => {
    const wide = configOf(WIDE_LAYOUT);
    const bucket = await deepBucket(SMALL, 300);
    const tree = bucket.tree!;
    const depth = tree.levels.length - 1;
    const charge =
      treeScanBaseCalls(tree.root!.summary.bytes, depth, WIDE_LAYOUT) * TREE_RETRIED_CALL_CHARGE;
    const belowRoot = tree.levels.slice(0, -1).flat().length;
    expect(belowRoot).toBeGreaterThan(charge);
    const limit = spentBeforeAdmission(bucket) + charge;
    const probe = instrument(bucket, wide);
    const caught = await thrown(() =>
      underLedger({ internal: limit, external: limit }, () =>
        readTreeScan(probe.target(ledgeredStorage(probe.target().storage, "internal"))),
      ),
    );
    expect(refusalBound(caught)).toBe("ledger");
    expect(probe.nodeGets().length).toBeGreaterThan(1);
    expect(probe.counting.puts + probe.counting.deletes).toBe(0);
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
