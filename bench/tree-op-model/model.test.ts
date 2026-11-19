import { describe, expect, test } from "vitest";
import {
  GC_MARK_LIST_PAGE_KEYS,
  MAINTENANCE_FOLD_BASE_REQUESTS,
  MAINTENANCE_RETIRE_PRE_FLOOR_REQUESTS,
  STORAGE_RETRY_MAX_ATTEMPTS,
  WRITE_TICK_FOLD_ENTRIES_PER_PASS,
  WRITE_TICK_GC_MAX_SWEEPS,
} from "@baerly/protocol";
import { loadRequestCountSnapshot, parseCell } from "../../scripts/request-counts.ts";
import {
  ALL_ATTEMPTS,
  byKind,
  chargedRequests,
  collectionShape,
  DEFAULT_ASSUMPTIONS,
  findLogTailGets,
  foldTickCalls,
  GC_WORST_STATE,
  gcTickCalls,
  type GcTickState,
  HAPPY_PATH,
  maxFittingChangedLeaves,
  pathUnionInternalNodes,
  pointReadCalls,
  scanCalls,
  sumCalls,
  type Scenario,
  type TreeShape,
  writeRouteCalls,
} from "./model.ts";

const DEPTH_0: TreeShape = { depth: 0, fanout: 1, leaves: 1 };

/** A `request-counts.json` cell, by kind. */
const recorded = (cell: string) => {
  const text = loadRequestCountSnapshot().cells[cell];
  if (text === undefined) {
    throw new Error(`request-counts.json has no cell "${cell}"`);
  }
  return parseCell(cell, text);
};

describe("depth 0 reproduces main's recorded request counts", () => {
  // The grid's states: tail 50 / 200, snapshot of 0 or 100 docs. Depth 0
  // is one leaf whatever the snapshot's size, so 100 docs stand in for the
  // floor collection: the count does not depend on the snapshot's size.
  const states = [50, 200].flatMap((tail) => [0, 100].map((snap) => ({ tail, snap })));

  test.each(states)("point read and scan, tail=$tail snap=$snap", ({ tail, snap }) => {
    const read = { shape: DEPTH_0, tailEntries: tail, emptyBase: snap === 0 };
    expect(byKind(pointReadCalls(read))).toEqual(recorded(`get tail=${tail} idx=0 snap=${snap}`));
    expect(byKind(scanCalls(read))).toEqual(recorded(`scan tail=${tail} idx=0 snap=${snap}`));
  });

  test.each(states)("cf-free fold tick, tail=$tail snap=$snap", ({ tail, snap }) => {
    const tick = foldTickCalls({
      shape: DEPTH_0,
      changedLeaves: 1,
      sharing: "distinct",
      entriesFolded: Math.min(tail, WRITE_TICK_FOLD_ENTRIES_PER_PASS),
      emptyBase: snap === 0,
      concurrentCommits: 0,
      headCasLost: false,
      assumptions: DEFAULT_ASSUMPTIONS,
    });
    expect(byKind(tick)).toEqual(recorded(`tick:fold tail=${tail} idx=0 snap=${snap}`));
  });

  test.each(states)("write route plus commit, tail=$tail snap=$snap", ({ tail, snap }) => {
    // The insert cell is the route plus the commit's create and its
    // delete-floor GET, which the model keeps inside the commit hold.
    const route = writeRouteCalls({
      read: { shape: DEPTH_0, tailEntries: tail, emptyBase: snap === 0 },
      writeStateRead: "point",
      tailHintLag: 0,
    });
    const withCommit = sumCalls(route, { creates: 1, gets: 1 });
    expect(byKind(withCommit)).toEqual(recorded(`insert tail=${tail} idx=0 snap=${snap}`));
  });

  test("the fold tick past the runner's GET is MAINTENANCE_FOLD_BASE_REQUESTS + e", () => {
    const e = WRITE_TICK_FOLD_ENTRIES_PER_PASS;
    const tick = foldTickCalls({
      shape: DEPTH_0,
      changedLeaves: 1,
      sharing: "distinct",
      entriesFolded: e,
      emptyBase: false,
      concurrentCommits: 0,
      headCasLost: false,
      assumptions: DEFAULT_ASSUMPTIONS,
    });
    expect(chargedRequests(tick, HAPPY_PATH)).toBe(1 + MAINTENANCE_FOLD_BASE_REQUESTS + e);
  });
});

describe("GC tick at depth 0 reproduces main", () => {
  const gc = (over: Partial<Parameters<typeof gcTickCalls>[0]>) =>
    gcTickCalls({
      shape: DEPTH_0,
      sweeps: 0,
      retirementDeletes: 0,
      listPageKeys: GC_MARK_LIST_PAGE_KEYS,
      state: UNCONTENDED,
      assumptions: DEFAULT_ASSUMPTIONS,
      ...over,
    });
  // The grid's GC ticks: a fresh pending ledger (bootstrap create, one CAS),
  // nothing to retire, `tail_hint` already at the tail.
  const UNCONTENDED: GcTickState = {
    pendingBootstrap: true,
    pendingBootstrapConflict: false,
    pendingCasAttempts: 1,
    freshCurrentGet: false,
    tailHintRefresh: false,
  };

  test.each([0, 50, 200].flatMap((tail) => [0, 100].map((snap) => ({ tail, snap }))))(
    "tick:gc, tail=$tail snap=$snap",
    ({ tail, snap }) => {
      expect(byKind(gc({}))).toEqual(recorded(`tick:gc tail=${tail} idx=0 snap=${snap}`));
    },
  );

  test.each([50, 200])("tick:gc-sweep, tail=%i snap=100: one due snapshot swept", (tail) => {
    const calls = gc({ sweeps: 1, state: { ...UNCONTENDED, freshCurrentGet: true } });
    expect(byKind(calls)).toEqual(recorded(`tick:gc-sweep tail=${tail} idx=0 snap=100`));
  });

  test("the worst state is maintenance-budget.test.ts's contended GC tick", () => {
    // Pinned in packages/server/src/maintenance-budget.test.ts, test
    // "maximally contended write-tick GC refreshes tail_hint at 26 storage
    // operations": `counted.report()` equals
    // { get: 10, put: 5, delete: 10, listPage: 1 } (26 calls) for a tick
    // with a bootstrap conflict, three final CAS attempts, the refresh, a
    // due sweep of WRITE_TICK_GC_MAX_SWEEPS and nothing to retire. Not
    // importable (a test file), so restated here.
    const calls = gc({ sweeps: WRITE_TICK_GC_MAX_SWEEPS, state: GC_WORST_STATE });
    expect(byKind(calls)).toEqual({ get: 10, put: 5, delete: 10, listPage: 1 });
  });

  test("retirement's pre-floor calls are MAINTENANCE_RETIRE_PRE_FLOOR_REQUESTS at all attempts", () => {
    const without = chargedRequests(gc({}), ALL_ATTEMPTS);
    const withOne = chargedRequests(gc({ retirementDeletes: 1 }), ALL_ATTEMPTS);
    // Pre-floor = the gate GET (already in `without`) + the floor CAS GET +
    // PUT; the one DELETE is past the floor.
    const gateGet = STORAGE_RETRY_MAX_ATTEMPTS;
    const oneDelete = STORAGE_RETRY_MAX_ATTEMPTS;
    expect(withOne - without - oneDelete + gateGet).toBe(MAINTENANCE_RETIRE_PRE_FLOOR_REQUESTS);
  });

  test("the LIST pages over the node namespace", () => {
    const shape: TreeShape = { depth: 1, fanout: 600, leaves: 600 };
    // 601 live nodes, twice that listed: 2 pages.
    expect(gc({ shape }).listPages).toBe(2);
  });
});

describe("path sharing", () => {
  // Depth 2, 256 leaves under 16 parents of 16.
  const shape: TreeShape = { depth: 2, fanout: 16, leaves: 256 };

  test("distinct paths pay one parent per leaf, shared paths one parent in all", () => {
    expect(pathUnionInternalNodes(shape, 4, "distinct")).toBe(1 + 4);
    expect(pathUnionInternalNodes(shape, 4, "shared")).toBe(1 + 1);
    // Past one parent's span, shared paths need a second parent.
    expect(pathUnionInternalNodes(shape, 17, "shared")).toBe(1 + 2);
    // Distinct paths saturate at the level's node count.
    expect(pathUnionInternalNodes(shape, 40, "distinct")).toBe(1 + 16);
  });

  test("the fold tick charges the difference, GET and create alike", () => {
    const tick = (sharing: "distinct" | "shared") =>
      foldTickCalls({
        shape,
        changedLeaves: 4,
        sharing,
        entriesFolded: 20,
        emptyBase: false,
        concurrentCommits: 0,
        headCasLost: false,
        assumptions: {
          ...DEFAULT_ASSUMPTIONS,
          neighborLeavesPerChangedLeaf: 0,
          splitCreatesPerRewrittenNode: 0,
        },
      });
    // Runner + compact head GETs, tail probe, 20 entries, path, 4 leaves.
    expect(tick("distinct")).toMatchObject({ gets: 3 + 20 + 5 + 4, creates: 5 + 4, casPuts: 1 });
    expect(tick("shared")).toMatchObject({ gets: 3 + 20 + 2 + 4, creates: 2 + 4, casPuts: 1 });
  });

  test("boundary neighbors and splits add leaves and creates at depth >= 1", () => {
    const calls = foldTickCalls({
      shape,
      changedLeaves: 4,
      sharing: "distinct",
      entriesFolded: 20,
      emptyBase: false,
      concurrentCommits: 0,
      headCasLost: false,
      assumptions: DEFAULT_ASSUMPTIONS,
    });
    // 4 changed + 4 neighbors = 8 leaves under 8 parents + the root.
    expect(calls.gets).toBe(3 + 20 + 9 + 8);
    expect(calls.creates).toBe(2 * (9 + 8));
  });
});

describe("retry charging", () => {
  test("retried calls pay every attempt, CAS PUTs and the hint refresh pay one", () => {
    const calls = sumCalls({ gets: 2, creates: 1, casPuts: 1, unretriedGets: 1 });
    expect(chargedRequests(calls, HAPPY_PATH)).toBe(5);
    // 2 GETs x 3, 1 create x 3 x (1 + 1 readback), 1 CAS, 1 unretried GET.
    expect(chargedRequests(calls, ALL_ATTEMPTS)).toBe(6 + 6 + 1 + 1);
  });
});

describe("findLogTailGets", () => {
  test("replays the gallop and binary search", () => {
    expect(findLogTailGets(0)).toBe(1);
    expect(findLogTailGets(1)).toBe(2);
    // Gallop probes offsets 1, 3, 7 (miss), then bisects (3, 7].
    expect(findLogTailGets(5)).toBe(1 + 3 + 2);
  });
});

describe("floor shapes", () => {
  const sizing = { leafTargetBytes: 4096, leafMinFill: 0.5, maxFanout: Infinity };

  test("the floor collection at 4 KiB leaves, half full, is 256 leaves", () => {
    expect(collectionShape(1, sizing)).toEqual({ depth: 1, fanout: 256, leaves: 256 });
    expect(collectionShape(2, sizing)).toEqual({ depth: 2, fanout: 16, leaves: 256 });
  });

  test("a depth the floor cannot take is null", () => {
    // One 512 KiB leaf has no depth-1 tree.
    expect(
      collectionShape(1, { leafTargetBytes: 1024 * 1024, leafMinFill: 1, maxFanout: Infinity }),
    ).toBeNull();
    expect(collectionShape(1, { ...sizing, maxFanout: 64 })).toBeNull();
  });

  test("the fold tick's budget shrinks with distinct paths", () => {
    const shape = collectionShape(2, sizing)!;
    const scenario: Scenario = {
      sizing,
      sharing: "distinct",
      tailEntries: 50,
      tailHintLag: 0,
      concurrentCommits: 0,
      writeStateRead: "point",
      policy: ALL_ATTEMPTS,
      assumptions: DEFAULT_ASSUMPTIONS,
    };
    const distinct = maxFittingChangedLeaves(shape, scenario);
    const shared = maxFittingChangedLeaves(shape, { ...scenario, sharing: "shared" });
    expect(distinct).toBeGreaterThan(0);
    expect(shared).toBeGreaterThan(distinct);
  });
});
