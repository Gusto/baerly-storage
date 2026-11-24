/**
 * Tree GC (`./gc.ts`): the record path (losers at once, winners after
 * the server-clock delay), the leak sweep, the membership check every
 * DELETE rests on, the state's binding and malformed-state rules, the
 * probe clock, the per-tick budget and crashes inside a tick.
 *
 * Buckets come from `tests/fixtures/tree-gc-harness.ts`: real folds at
 * the small-scope layout, hand-moved local and server clocks, folds
 * paused before their head CAS, and the physical oracle judging the
 * current tree. `MarginWatch` flags a deletion of a node the root
 * reaches, or one sooner than the superseded delay after the node
 * became unreachable. The `mutation` block requires each GC mutant in
 * `tests/fixtures/tree-mutants.ts` to turn its checks red.
 */
import { describe, expect, test } from "vitest";
import { BaerlyError, encodeJsonBytes, RequestLedger, type Storage } from "@baerly/protocol";
import { ledgeredStorage } from "../../../../tests/fixtures/ledgered-storage.ts";
import {
  freshGcHead,
  GC_HEAD,
  GC_NODES,
  GC_PREFIX,
  GC_RECORDS,
  GC_SEED,
  GC_STATE,
  gcAttemptOf,
  GcBucket,
  type GcChange,
  gcConfig,
  MarginWatch,
} from "../../../../tests/fixtures/tree-gc-harness.ts";
import {
  GC_CORRUPT_NO_RETRY,
  GC_DELETES_CORRUPT_CANDIDATE,
  GC_DELETES_UNPARSEABLE_KEY,
  GC_IGNORES_DUE_AT,
  GC_IGNORES_DUPLICATE_IDENTITY,
  GC_IGNORES_GENERATION,
  GC_IGNORES_LIVE_ROOT,
  GC_KEY_ONLY_MEMBERSHIP_AT_DEPTH_2,
  GC_LOCAL_CLOCK,
  GC_LOSER_AS_WINNER,
  GC_MEMBER_ATTEMPT_ONLY,
  GC_MEMBER_WRONG_LEVEL,
  GC_MUTANTS,
  GC_PATH_MISS_AS_NONMEMBER,
  GC_PROCESSES_OPEN_FLOOR,
  GC_SKIPS_MEMBERSHIP_CHECK,
  GC_WINNER_AS_LOSER,
  GC_WINNER_BY_KEY_ORDER,
  PUBLISH_REUSES_ATTEMPT,
  RECORD_NAMES_REUSED_NODE,
  SWEEP_AGE_FROM_NOTE,
  SWEEP_FLOOR_BEFORE_LIST,
  SWEEP_MEMBER_AGAINST_MARK_ROOT,
  SWEEP_NO_FLOOR_GATE,
  type TreeMutant,
} from "../../../../tests/fixtures/tree-mutants.ts";
import { createObservabilityContext, runWithContext } from "../observability/context.ts";
import {
  TREE_GC_SUPERSEDED_DELAY_MINUTES,
  TREE_GC_SWEEP_AGE_MINUTES,
  TREE_GC_TICK_CANDIDATES,
  TREE_GC_TICK_MAX_CANDIDATES,
  TREE_GC_TICK_RESERVED_CALLS,
} from "./constants.ts";
import { runTreeGcTick, treeGcCandidateCharge, treeGcCandidates } from "./gc.ts";
import { createTreeGcRootView, type TreeGcMembership, treeGcMembership } from "./gc-member.ts";
import { emptyTreeGcState, encodeTreeGcState } from "./gc-state.ts";
import { readTreeHead, readTreeRoot } from "./head.ts";
import { openTreeView } from "./read.ts";

const MIXED: readonly GcChange[] = [
  ["k03", 103],
  ["k10a", 7],
  ["k16", null],
];

const DELAY = TREE_GC_SUPERSEDED_DELAY_MINUTES;
const AGE = TREE_GC_SWEEP_AGE_MINUTES;
const LONG = 60_000;

/** Run `check`, turning a throw into a failure message. */
const guarded = async (check: () => Promise<string | undefined>): Promise<string | undefined> => {
  try {
    return await check();
  } catch (error) {
    return `threw ${String(error)}`;
  }
};

const joined = (problems: readonly string[]): string | undefined =>
  problems.length === 0 ? undefined : problems.join("; ");

/** Resolve, wait out the delay, and tick until the records are drained. */
const reclaim = async (bucket: GcBucket, config = gcConfig()): Promise<string[]> => {
  const deleted: string[] = [];
  for (const minutes of [0, DELAY + 1, 1, 1]) {
    bucket.advance(minutes);
    const { result } = await bucket.tick(config);
    deleted.push(...result.deleted);
  }
  return deleted;
};

/** What is wrong with the bucket once GC should have reclaimed everything recorded. */
const reclaimedProblems = async (bucket: GcBucket): Promise<string | undefined> => {
  const problems = [...(await bucket.violations())];
  const unreachable = await bucket.unreachable();
  if (unreachable.length > 0) {
    problems.push(`unreachable nodes remain: ${unreachable.join(", ")}`);
  }
  const records = await bucket.keys(GC_RECORDS);
  if (records.length > 0) {
    problems.push(`records remain: ${records.join(", ")}`);
  }
  return joined(problems);
};

/** The nodes the last fold of `bucket` superseded, given the reachable set before it. */
const supersededSince = async (
  bucket: GcBucket,
  before: ReadonlySet<string>,
): Promise<string[]> => {
  const live = await bucket.reachable();
  return [...before].filter((key) => !live.has(key));
};

// ---------------------------------------------------------------------
// Checks shared with the mutation block. Each returns the first
// failure, or `undefined`.
// ---------------------------------------------------------------------

/** A fold's superseded nodes and its record are all reclaimed, and nothing live is lost. */
const reclaimFailure = (...mutants: (TreeMutant | undefined)[]) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    await bucket.fold(MIXED, { config: gcConfig(...mutants) });
    await reclaim(bucket, gcConfig(...mutants));
    return reclaimedProblems(bucket);
  });

/**
 * Every node of the current depth-3 root is a member, every node the
 * last fold superseded is not, and a deep node whose path from the root
 * cannot be read is path-unreadable.
 */
const membershipFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const before = await bucket.reachable();
    await bucket.fold(MIXED);
    const live = await bucket.reachable();
    const superseded = [...before].filter((key) => !live.has(key));
    const config = gcConfig(mutant);
    const head = (await readTreeHead(bucket.storage, GC_PREFIX))!;
    const root = (await readTreeRoot(bucket.storage, head, config))!;
    const check = config.steps.gcIsMember ?? treeGcMembership;
    const ask = (x: string, storage: Storage = bucket.storage): Promise<TreeGcMembership> =>
      check(x, createTreeGcRootView(storage, GC_PREFIX, root, config));
    const problems: string[] = [];
    for (const key of live) {
      const found = await ask(key);
      if (found !== "member") {
        problems.push(`live ${key}: ${found}`);
      }
    }
    for (const key of superseded) {
      const found = await ask(key);
      if (found !== "non-member") {
        problems.push(`superseded ${key}: ${found}`);
      }
    }
    // Below the root's children, every path runs through one of them.
    const hidden = new Set(
      root.node.kind === "branch"
        ? root.node.children.map((e) => `${GC_NODES}${e.attempt}/${e.sha256}`)
        : [],
    );
    const blind: Storage = {
      ...bucket.storage,
      get: (key, opts) => (hidden.has(key) ? Promise.resolve(null) : bucket.storage.get(key, opts)),
    };
    const deep = [...live].filter((key) => !hidden.has(key) && key !== root.key);
    if (root.node.level < 3 || deep.length === 0) {
      problems.push("setup: no node below the root's children");
    }
    for (const key of deep) {
      const found = await ask(key, blind);
      if (found !== "path-unreadable") {
        problems.push(`live ${key} under an unreadable path: ${found}`);
      }
    }
    return joined(problems);
  });

/**
 * Two attempts race on one floor and the one whose id sorts last wins:
 * the loser's fresh nodes and the winner's superseded nodes are all
 * reclaimed, and nothing live is lost.
 */
const raceFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const loser = await bucket.prepare([["k04", 44]]);
    const winner = await bucket.prepare([["k15", 55]]);
    const won = await bucket.publish(winner, { attempt: "f".repeat(32) });
    const lost = await bucket.publish(loser, { attempt: "1".repeat(32) });
    if (won.kind !== "published" || lost.kind !== "cas-lost") {
      return `setup: ${won.kind}, ${lost.kind}`;
    }
    await reclaim(bucket, gcConfig(mutant));
    return reclaimedProblems(bucket);
  });

/**
 * A read that opened the root before a fold, and reads after GC has
 * resolved the fold and ticked inside the delay, meets no missing node.
 */
const readDuringGcFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    let misses = 0;
    const tapped: Storage = {
      ...bucket.storage,
      get: async (key, opts) => {
        const got = await bucket.storage.get(key, opts);
        if (got === null && key.startsWith(GC_NODES)) {
          misses += 1;
        }
        return got;
      },
    };
    const view = await openTreeView({ storage: tapped, prefix: GC_PREFIX, config: gcConfig() });
    const rows = bucket.rows.size;
    await bucket.fold(MIXED);
    for (const minutes of [0, 2, DELAY - 3]) {
      bucket.advance(minutes);
      await bucket.tick(gcConfig(mutant));
    }
    const read = await view.scan();
    if (misses > 0) {
      return `the read met ${misses} missing nodes inside the delay`;
    }
    return read.length === rows ? undefined : `read ${read.length} rows of ${rows}`;
  });

/** The local clock runs far ahead of the server's: superseded nodes still wait out the delay on the server clock. */
const skewFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const watch = new MarginWatch(bucket);
    await watch.observe();
    await bucket.fold(MIXED);
    await watch.observe();
    for (let i = 0; i < 6; i++) {
      // Twenty local minutes, two on the server.
      bucket.advance(20, 2);
      const { result } = await bucket.tick(gcConfig(mutant));
      await watch.afterTick(result.deleted);
    }
    return joined(watch.problems);
  });

/**
 * An attempt that lost reuses its identity for a publication still in
 * flight: GC must not drain the first publication's nodes, which the
 * second one adopted.
 */
const reuseFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const reused = "a".repeat(32);
    const loser = await bucket.prepare([["k03", 5]]);
    const winner = await bucket.prepare([["k19", 119]]);
    await bucket.publish(winner, { attempt: "b".repeat(32) });
    const lost = await bucket.publish(loser, { attempt: reused });
    if (lost.kind !== "cas-lost") {
      return `setup: ${lost.kind}`;
    }
    const retry = await bucket.startFold([["k03", 5]], { attempt: reused });
    await bucket.tick(gcConfig(mutant));
    const outcome = await retry.release();
    if (outcome.kind !== "published") {
      return `the retry was ${outcome.kind}`;
    }
    return joined(await bucket.violations());
  });

/**
 * A lost attempt the publisher retries shows up in GC's
 * duplicate-identity counter only if the retry reused its identity.
 */
const reuseCounterFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const options = mutant === undefined ? {} : { config: gcConfig(mutant) };
    const loser = await bucket.prepare([["k03", 5]]);
    await bucket.fold([["k19", 119]]);
    await bucket.publish(loser, options);
    await bucket.fold([["k03", 5]], options);
    const { counters } = await bucket.tick();
    const duplicates = counters.get("db.tree_gc.duplicate_attempt_total") ?? 0;
    return duplicates === 0 ? undefined : `${duplicates} duplicate identities`;
  });

/** An attempt in flight at the head's floor is neither resolved nor stuck, and its nodes survive. */
const openFloorFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const flight = await bucket.startFold([["k05", 55]]);
    const problems: string[] = [];
    for (let i = 0; i < 3; i++) {
      bucket.advance(1);
      await bucket.tick(gcConfig(mutant));
      const state = await bucket.state();
      const stuck = state?.stuck ?? null;
      if (stuck !== null) {
        problems.push(`floor ${stuck.floor} marked stuck`);
      }
    }
    await flight.release();
    problems.push(...(await bucket.violations()));
    return joined(problems);
  });

/**
 * After the head is re-seeded with a new generation and a lower floor,
 * the new history's superseded nodes are reclaimed: the old state's
 * progress never applies to it.
 */
const regenerationFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded("0a");
    await bucket.fold(MIXED);
    await reclaim(bucket, gcConfig(mutant));
    // A restore-like re-seed: a fresh head of a new history.
    await bucket.memory.put(GC_HEAD, encodeJsonBytes(freshGcHead("0b")));
    bucket.rows.clear();
    await bucket.fold(GC_SEED);
    const before = await bucket.reachable();
    await bucket.fold(MIXED);
    const superseded = await supersededSince(bucket, before);
    bucket.advance(1);
    await bucket.tick(gcConfig(mutant));
    await reclaim(bucket, gcConfig(mutant));
    const left = new Set(await bucket.keys(GC_NODES));
    const problems = [...(await bucket.violations())];
    const kept = superseded.filter((key) => left.has(key));
    if (kept.length > 0) {
      problems.push(`the new history's superseded nodes remain: ${kept.join(", ")}`);
    }
    return joined(problems);
  });

/**
 * The sweep reclaims nodes no record names (a lost attempt whose record
 * is gone), leaves keys that do not parse, counting them, and never
 * deletes a node the root reaches or one sooner than the delay after it
 * became unreachable.
 */
const sweepFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const loser = await bucket.prepare([["k07", 77]]);
    await bucket.fold([["k12", 12]]);
    const lost = await bucket.publish(loser);
    if (lost.kind !== "cas-lost") {
      return `setup: ${lost.kind}`;
    }
    await bucket.memory.delete(lost.record);
    const unreachable = await bucket.unreachable();
    const orphans = unreachable.filter((key) => key.startsWith(`${GC_NODES}${lost.attempt}/`));
    const sha = "0".repeat(64);
    const strays = [
      `${GC_NODES}${lost.attempt}/${sha}.json`,
      `${GC_NODES}${"A".repeat(32)}/${sha}`,
    ];
    for (const key of strays) {
      await bucket.memory.put(key, new TextEncoder().encode("{}"));
    }
    const watch = new MarginWatch(bucket);
    await watch.observe();
    let unknown = 0;
    for (let minute = 0; minute < 3 * AGE; minute++) {
      if (minute % 20 === 10) {
        await bucket.fold([["k00", minute]]);
        await watch.observe();
      }
      bucket.advance(1);
      const { result, counters } = await bucket.tick(gcConfig(mutant));
      unknown += counters.get("db.tree_gc.unknown_key_total") ?? 0;
      await watch.afterTick(result.deleted);
    }
    const left = new Set(await bucket.keys(GC_NODES));
    const problems = [...watch.problems];
    if (orphans.length === 0) {
      problems.push("setup: no orphan nodes");
    }
    problems.push(
      ...orphans.filter((key) => left.has(key)).map((key) => `orphan ${key} not swept`),
      ...strays.filter((key) => !left.has(key)).map((key) => `stray ${key} deleted`),
    );
    if (unknown === 0) {
      problems.push("no unknown key counted");
    }
    return joined(problems);
  });

/**
 * An attempt stays in flight past the sweep age, then lands; an
 * unrelated fold follows. Its nodes are never deleted while it can
 * still publish, nor once its root reaches them.
 */
const sweepInFlightFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const watch = new MarginWatch(bucket);
    await watch.observe();
    const flight = await bucket.startFold([["k08", 88]], { attempt: "0".repeat(32) });
    await bucket.tickFor(AGE + 10, gcConfig(mutant), watch);
    await flight.release();
    const problems = [...(await bucket.violations())];
    await watch.observe();
    await bucket.fold([["k12", 12]]);
    await watch.observe();
    await bucket.tickFor(AGE + 20, gcConfig(mutant), watch);
    problems.push(...watch.problems);
    return joined(problems);
  });

/**
 * An attempt's node is noted while the attempt is in flight, the
 * attempt lands, and a later fold supersedes the node: the node still
 * waits out the delay after that fold.
 */
const supersededAfterNoteFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const watch = new MarginWatch(bucket);
    await watch.observe();
    const flight = await bucket.startFold([["k08", 88]], { attempt: "0".repeat(32) });
    await bucket.tickFor(30, gcConfig(mutant), watch);
    await flight.release();
    await watch.observe();
    await bucket.tickFor(28, gcConfig(mutant), watch);
    await bucket.fold([["k08", 89]]);
    await watch.observe();
    await bucket.tickFor(AGE + 30, gcConfig(mutant), watch);
    return joined(watch.problems);
  });

/**
 * A fold lands and another attempt starts around the probe tick's head
 * GET and sweep LIST: the attempt's nodes are never deleted while it is
 * in flight.
 */
const floorBeforeListFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    let flight: Awaited<ReturnType<GcBucket["startFold"]>> | undefined;
    bucket.onList.set(GC_NODES, async () => {
      await bucket.fold([["k19", 1]]);
      flight = await bucket.startFold([["k02", 2]], { attempt: "0".repeat(32) });
    });
    const watch = new MarginWatch(bucket);
    await watch.observe();
    await bucket.tickFor(AGE + 10, gcConfig(mutant), watch);
    if (flight === undefined) {
      return "setup: the LIST hook never ran";
    }
    await flight.release();
    return joined([...watch.problems, ...(await bucket.violations())]);
  });

/** A superseded node below the root, at depth 3, picked from the last fold of `bucket`. */
const supersededBelowRoot = async (bucket: GcBucket): Promise<string> => {
  const head = await bucket.head();
  const before = await bucket.reachable();
  await bucket.fold(MIXED);
  const superseded = await supersededSince(bucket, before);
  return superseded.find((key) => key !== head.root)!;
};

/** A superseded node corrupt at rest at depth 3 is counted and left in place; the rest is reclaimed. */
const corruptFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const target = await supersededBelowRoot(bucket);
    await bucket.memory.put(target, new TextEncoder().encode("not a node"));
    let corrupt = 0;
    for (const minutes of [0, DELAY + 1, 1, 1]) {
      bucket.advance(minutes);
      const { counters } = await bucket.tick(gcConfig(mutant));
      corrupt += counters.get("db.tree_gc.corrupt_node_total") ?? 0;
    }
    const problems = [...(await bucket.violations())];
    const unreachable = await bucket.unreachable();
    if (!unreachable.includes(target)) {
      problems.push(`the corrupt node ${target} was deleted`);
    }
    if (unreachable.length !== 1) {
      problems.push(`unreachable: ${unreachable.join(", ")}`);
    }
    if (corrupt === 0) {
      problems.push("the corrupt node was not counted");
    }
    return joined(problems);
  });

/** A one-time misread of a superseded node is read again: no corruption is counted or warned. */
const misreadFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const target = await supersededBelowRoot(bucket);
    let misread = false;
    bucket.getOverride = (key) => {
      if (key === target && !misread) {
        misread = true;
        return new TextEncoder().encode("torn read");
      }
      return undefined;
    };
    const problems: string[] = [];
    for (const minutes of [0, DELAY + 1, 1, 1]) {
      bucket.advance(minutes);
      const { counters, warnings } = await bucket.tick(gcConfig(mutant));
      if ((counters.get("db.tree_gc.corrupt_node_total") ?? 0) > 0) {
        problems.push("a misread was counted as corruption");
      }
      if (warnings.includes("tree_gc_corrupt_node")) {
        problems.push("a misread was warned as corruption");
      }
    }
    if (!misread) {
      problems.push("setup: the target was never read");
    }
    return joined(problems);
  });

/** Overwrite the head's installer, keeping everything else (test-only damage). */
const overwriteInstaller = async (bucket: GcBucket, attempt: string): Promise<void> => {
  const head = await bucket.head();
  await bucket.memory.put(
    GC_HEAD,
    encodeJsonBytes({ ...head.json, proto_tree: { ...head.json.proto_tree!, attempt } }),
  );
};

/** The fresh node keys of attempt `attempt` in `bucket`. */
const freshOf = async (bucket: GcBucket, attempt: string): Promise<string[]> => {
  const keys = await bucket.keys(GC_NODES);
  return keys.filter((key) => key.startsWith(`${GC_NODES}${attempt}/`));
};

// ---------------------------------------------------------------------
// Record path
// ---------------------------------------------------------------------

describe("record path", () => {
  test("a fold's superseded nodes and its record are reclaimed after the delay, and nothing live is lost", async () => {
    await expect(reclaimFailure()).resolves.toBeUndefined();
  });

  test("superseded nodes wait out the delay on the server clock", async () => {
    const bucket = await GcBucket.seeded();
    await bucket.fold(MIXED);
    const unreachable = await bucket.unreachable();
    await bucket.tick();
    bucket.advance(DELAY - 1);
    const early = await bucket.tick();
    expect(early.result.deleted.filter((key) => key.startsWith(GC_NODES))).toEqual([]);
    bucket.advance(2);
    const due = await bucket.tick();
    expect(due.result.deleted.filter((key) => key.startsWith(GC_NODES)).toSorted()).toEqual(
      unreachable.toSorted(),
    );
  });

  test("a loser's fresh nodes are deleted in the tick that resolves its floor", async () => {
    const bucket = await GcBucket.seeded();
    const loser = await bucket.prepare([["k04", 44]]);
    await bucket.fold([["k15", 55]]);
    const lost = await bucket.publish(loser);
    expect(lost.kind).toBe("cas-lost");
    const fresh = await freshOf(bucket, lost.attempt);
    expect(fresh.length).toBeGreaterThan(0);
    const { result } = await bucket.tick();
    expect(result.deleted).toEqual(expect.arrayContaining([...fresh, lost.record]));
    await expect(bucket.violations()).resolves.toEqual([]);
  });

  test("racing attempts: the loser's fresh and the winner's superseded nodes are all reclaimed", async () => {
    await expect(raceFailure()).resolves.toBeUndefined();
  });

  test("a loser's corrupt node at depth 3 is deleted on its key alone, counted and warned", async () => {
    const bucket = await GcBucket.seeded();
    const loser = await bucket.prepare([["k04", 44]]);
    await bucket.fold([["k15", 55]]);
    const lost = await bucket.publish(loser);
    const [target] = await freshOf(bucket, lost.attempt);
    await bucket.memory.put(target!, new TextEncoder().encode("not a node"));
    const { result, counters, warnings } = await bucket.tick();
    expect(result.deleted).toContain(target);
    expect(counters.get("db.tree_gc.corrupt_node_total")).toBe(1);
    expect(warnings).toContain("tree_gc_corrupt_node");
  });

  test("a superseded node corrupt at rest is counted and left in place", async () => {
    await expect(corruptFailure()).resolves.toBeUndefined();
  });

  test("a one-time misread is read again, not counted as corruption", async () => {
    await expect(misreadFailure()).resolves.toBeUndefined();
  });

  test("a read through the replaced root meets no missing node inside the delay", async () => {
    await expect(readDuringGcFailure()).resolves.toBeUndefined();
  });

  test("a local clock far ahead of the server's does not shorten the delay", async () => {
    await expect(skewFailure()).resolves.toBeUndefined();
  });

  test("a probe whose write reports no server time stamps nothing, counts and warns; losers still drain", async () => {
    const bucket = await GcBucket.seeded();
    const loser = await bucket.prepare([["k04", 44]]);
    await bucket.fold([["k15", 55]]);
    const lost = await bucket.publish(loser);
    bucket.serverTime = false;
    const { result, counters, warnings } = await bucket.tick();
    expect(counters.get("db.tree_gc.no_server_time_total")).toBe(1);
    expect(warnings).toContain("tree_gc_no_server_time");
    expect(result.deleted).toEqual(expect.arrayContaining(await freshOf(bucket, lost.attempt)));
    bucket.advance(3 * DELAY);
    const later = await bucket.tick();
    expect(later.result.deleted.filter((key) => key.startsWith(GC_NODES))).toEqual([]);
    const state = await bucket.state();
    expect(state?.work.every((entry) => entry.due_at === null)).toBe(true);
  });

  test("a path node GC cannot read stops the tick's deletions, counted; the state is still written", async () => {
    const bucket = await GcBucket.seeded();
    await bucket.fold(MIXED);
    await bucket.tick();
    bucket.advance(DELAY + 1);
    const root = (await readTreeRoot(bucket.memory, await bucket.head()))!;
    const children = new Set(
      root.node.kind === "branch"
        ? root.node.children.map((e) => `${GC_NODES}${e.attempt}/${e.sha256}`)
        : [],
    );
    bucket.getOverride = (key) => (children.has(key) ? null : undefined);
    const before = await bucket.state();
    const { counters } = await bucket.tick();
    expect(counters.get("db.tree_gc.path_unreadable_total")).toBe(1);
    bucket.getOverride = undefined;
    await expect(bucket.unreachable()).resolves.not.toEqual([]);
    const after = await bucket.state();
    expect(after!.ticks).toBeGreaterThan(before!.ticks);
    await reclaim(bucket);
    await expect(reclaimedProblems(bucket)).resolves.toBeUndefined();
  });

  test("a floor with no evidence of its winner is stuck, then retired leak-only after the sweep age", async () => {
    const bucket = await GcBucket.seeded();
    await bucket.fold(MIXED);
    await bucket.fold([["k01", 1]]);
    const [, mixedRecord, lastRecord] = await bucket.keys(GC_RECORDS);
    // Hide the evidence of the mixed fold's win: the next record, and the installer.
    await bucket.memory.delete(lastRecord!);
    await overwriteInstaller(bucket, "e".repeat(32));
    await bucket.tick();
    const stuck = await bucket.state();
    expect(stuck?.stuck).toMatchObject({ floor: 20 });
    await bucket.tickFor(AGE + 2);
    await expect(bucket.keys(GC_RECORDS)).resolves.not.toContain(mixedRecord);
    const state = await bucket.state();
    expect(state?.stuck).toBeNull();
    expect(state?.resolved_through).toBeGreaterThanOrEqual(20);
    await expect(bucket.violations()).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------
// Membership
// ---------------------------------------------------------------------

describe("membership", () => {
  test("live nodes are members, superseded ones are not, and an unreadable path proves nothing", async () => {
    await expect(membershipFailure()).resolves.toBeUndefined();
  });

  test("at depth 0 and 1 membership reads no body", async () => {
    const bucket = await GcBucket.open();
    await bucket.fold([
      ["a", 1],
      ["b", 2],
    ]);
    const config = gcConfig();
    const head = (await readTreeHead(bucket.storage, GC_PREFIX))!;
    const root = (await readTreeRoot(bucket.storage, head, config))!;
    expect(root.node.level).toBeLessThanOrEqual(1);
    let gets = 0;
    const counting: Storage = {
      ...bucket.storage,
      get: (key, opts) => {
        gets += 1;
        return bucket.storage.get(key, opts);
      },
    };
    const view = createTreeGcRootView(counting, GC_PREFIX, root, config);
    await expect(treeGcMembership(root.key, view)).resolves.toBe("member");
    await expect(
      treeGcMembership(`${GC_NODES}${gcAttemptOf(9)}/${"0".repeat(64)}`, view),
    ).resolves.toBe("non-member");
    expect(gets).toBe(0);
  });
});

// ---------------------------------------------------------------------
// Attempt identity and closure
// ---------------------------------------------------------------------

describe("attempt identity and closure", () => {
  test("a reused identity is never a deletion source, from either list", async () => {
    await expect(reuseFailure()).resolves.toBeUndefined();
  });

  test("an identity in two records is counted, warned and its records retired leak-only", async () => {
    const bucket = await GcBucket.seeded();
    const reused = "a".repeat(32);
    const loser = await bucket.prepare([["k03", 5]]);
    await bucket.fold([["k19", 119]]);
    await bucket.publish(loser, { attempt: reused });
    await bucket.fold([["k03", 5]], { attempt: reused });
    const { result, counters, warnings } = await bucket.tick();
    expect(counters.get("db.tree_gc.duplicate_attempt_total")).toBe(1);
    expect(warnings).toContain("tree_gc_duplicate_attempt");
    const retired = result.deleted.filter((key) => key.startsWith(GC_RECORDS));
    expect(retired.filter((key) => key.includes(`/${reused}/`))).toHaveLength(2);
    expect(result.deleted.filter((key) => key.includes(`/n/${reused}/`))).toEqual([]);
    await expect(bucket.violations()).resolves.toEqual([]);
  });

  test("publications that mint fresh identities never trip the duplicate-identity counter", async () => {
    await expect(reuseCounterFailure()).resolves.toBeUndefined();
  });

  test("an attempt in flight at the head's floor is left alone", async () => {
    await expect(openFloorFailure()).resolves.toBeUndefined();
  });

  test("a new head history resets the state, and its superseded nodes are reclaimed", async () => {
    await expect(regenerationFailure()).resolves.toBeUndefined();
  });

  test("a head writer that keeps proto_tree keeps GC running; one that drops the installer stops it loudly", async () => {
    const kept = await GcBucket.seeded();
    await kept.fold(MIXED);
    await kept.refreshTailHint();
    await expect(kept.tick()).resolves.toMatchObject({ result: { outcome: "collected" } });

    const dropped = await GcBucket.seeded();
    await dropped.fold(MIXED);
    const nodes = await dropped.keys(GC_NODES);
    const head = await dropped.head();
    const { attempt: _installer, ...withoutInstaller } = head.json.proto_tree!;
    await dropped.memory.put(
      GC_HEAD,
      encodeJsonBytes({ ...head.json, proto_tree: withoutInstaller }),
    );
    await expect(dropped.tick()).rejects.toMatchObject({ code: "InvalidResponse" });
    await expect(dropped.keys(GC_NODES)).resolves.toEqual(nodes);
  });
});

// ---------------------------------------------------------------------
// Leak sweep
// ---------------------------------------------------------------------

describe("leak sweep", () => {
  test(
    "orphan nodes are swept, stray keys left and counted, and no live node is lost",
    async () => {
      await expect(sweepFailure()).resolves.toBeUndefined();
    },
    LONG,
  );

  test(
    "an attempt in flight past the sweep age keeps its nodes, before and after it lands",
    async () => {
      await expect(sweepInFlightFailure()).resolves.toBeUndefined();
    },
    LONG,
  );

  test(
    "a node noted while its attempt was in flight waits out the delay after a later fold supersedes it",
    async () => {
      await expect(supersededAfterNoteFailure()).resolves.toBeUndefined();
    },
    LONG,
  );

  test(
    "a fold that lands around a probe's LIST and head GET cannot expose an attempt in flight",
    async () => {
      await expect(floorBeforeListFailure()).resolves.toBeUndefined();
    },
    LONG,
  );
});

// ---------------------------------------------------------------------
// State, clock and budget
// ---------------------------------------------------------------------

describe("state and clock", () => {
  test("a tick with nothing to do and no probe due writes nothing", async () => {
    const bucket = await GcBucket.seeded();
    await bucket.tick();
    const before = await bucket.memory.get(GC_STATE);
    bucket.advance(0.5);
    await bucket.tick();
    const after = await bucket.memory.get(GC_STATE);
    expect(after?.etag).toBe(before?.etag);
  });

  test("probes are paced by local time against the local time of the last probe", async () => {
    const bucket = await GcBucket.seeded();
    await expect(bucket.tick()).resolves.toMatchObject({ result: { probed: true } });
    bucket.advance(0.5, 30);
    await expect(bucket.tick()).resolves.toMatchObject({ result: { probed: false } });
    bucket.advance(0.6, 0);
    await expect(bucket.tick()).resolves.toMatchObject({ result: { probed: true } });
    // A local clock that went backwards probes at once.
    bucket.advance(-10, 0);
    await expect(bucket.tick()).resolves.toMatchObject({ result: { probed: true } });
  });

  test("a malformed state is replaced by the empty state, and that is the tick's only write", async () => {
    const bucket = await GcBucket.seeded();
    await bucket.fold(MIXED);
    const nodes = await bucket.keys(GC_NODES);
    await bucket.memory.put(GC_STATE, encodeJsonBytes({ format: "baerly-tree-gc-state-proto" }));
    await expect(bucket.tick()).resolves.toMatchObject({
      result: { outcome: "reset", deleted: [] },
    });
    await expect(bucket.state()).resolves.toEqual(emptyTreeGcState(null, 23));
    await expect(bucket.keys(GC_NODES)).resolves.toEqual(nodes);
  });

  test("a state of a newer schema stops the tick with InvalidResponse and no write", async () => {
    const bucket = await GcBucket.seeded();
    await bucket.memory.put(
      GC_STATE,
      encodeJsonBytes({ format: "baerly-tree-gc-state-proto", schema_version: 2 }),
    );
    const before = await bucket.memory.get(GC_STATE);
    const error = await bucket.tick().catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(BaerlyError);
    expect(error).toMatchObject({ code: "InvalidResponse" });
    expect((error as BaerlyError).message).toContain("paused");
    const after = await bucket.memory.get(GC_STATE);
    expect(after?.etag).toBe(before?.etag);
  });

  test("a state bound to a higher floor is replaced", async () => {
    const bucket = await GcBucket.seeded();
    await bucket.memory.put(
      GC_STATE,
      encodeTreeGcState({ ...emptyTreeGcState(null, 99), ticks: 4 }),
    );
    await expect(bucket.tick()).resolves.toMatchObject({ result: { outcome: "reset" } });
    await expect(bucket.state()).resolves.toEqual(emptyTreeGcState(null, 20));
  });

  test("a collection with no head ends the tick with no write", async () => {
    const bucket = new GcBucket();
    await expect(bucket.tick()).resolves.toMatchObject({ result: { outcome: "no-head" } });
    await expect(bucket.keys(GC_PREFIX)).resolves.toEqual([]);
  });
});

describe("budget", () => {
  test("the candidate count follows the ledger: the static floor, the larger ceiling, or what fits", () => {
    expect(treeGcCandidateCharge(1)).toBe(3);
    expect(treeGcCandidateCharge(2)).toBe(9);
    expect(treeGcCandidates(0, Number.POSITIVE_INFINITY)).toBe(TREE_GC_TICK_MAX_CANDIDATES);
    expect(treeGcCandidates(2, 9000)).toBe(TREE_GC_TICK_MAX_CANDIDATES);
    expect(treeGcCandidates(0, 900)).toBe(TREE_GC_TICK_CANDIDATES);
    expect(treeGcCandidates(2, TREE_GC_TICK_RESERVED_CALLS + 9 * 10)).toBe(10);
    expect(treeGcCandidates(0, TREE_GC_TICK_RESERVED_CALLS + 2)).toBe(0);
  });

  test("a ledger with no room for one candidate check skips the tick, counted", async () => {
    const bucket = await GcBucket.seeded();
    const ledger = new RequestLedger({ internal: 30, external: 30 });
    const storage = ledgeredStorage(bucket.memory, "internal");
    const result = await runWithContext(createObservabilityContext({ ledger }), () =>
      runTreeGcTick({ storage, prefix: GC_PREFIX, config: gcConfig() }),
    );
    expect(result.outcome).toBe("budget");
  });

  test("a deleting tick's charged calls stay within the static bound for its candidate count", async () => {
    const bucket = await GcBucket.seeded();
    await bucket.fold(MIXED);
    await bucket.tick();
    bucket.advance(DELAY + 1);
    const ledger = new RequestLedger({ internal: 1_000, external: 1_000 });
    const storage = ledgeredStorage(bucket.memory, "internal");
    const result = await runWithContext(createObservabilityContext({ ledger }), () =>
      runTreeGcTick({
        storage,
        prefix: GC_PREFIX,
        config: gcConfig(),
        now: () => new Date(bucket.local),
      }),
    );
    expect(result.deleted.length).toBeGreaterThan(0);
    const charged = 1_000 - ledger.storageRemaining();
    expect(result.candidates).toBeGreaterThan(0);
    expect(charged).toBeLessThanOrEqual(
      TREE_GC_TICK_RESERVED_CALLS + result.candidates * treeGcCandidateCharge(3),
    );
  });
});

describe("crashes", () => {
  test(
    "a crash before any storage call of a tick loses nothing live, and later ticks finish the work",
    async () => {
      for (let k = 1; ; k++) {
        const bucket = await GcBucket.seeded();
        await bucket.fold(MIXED);
        await bucket.tick();
        bucket.advance(DELAY + 1);
        bucket.faults.armAt(k);
        let crashed = false;
        try {
          await bucket.tick();
          bucket.faults.armAt(undefined);
        } catch (error) {
          if ((error as Error).name !== "AbortError") {
            throw error;
          }
          crashed = true;
        }
        await expect(bucket.violations(), `crash at call ${k}`).resolves.toEqual([]);
        await reclaim(bucket);
        await expect(reclaimedProblems(bucket), `crash at call ${k}`).resolves.toBeUndefined();
        if (!crashed) {
          break;
        }
      }
    },
    LONG,
  );
});

// ---------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------

type Check = (mutant?: TreeMutant) => Promise<string | undefined>;

/** `check` with `record-names-reused-node` alongside: the record nominates a live node. */
const withReusedNode =
  (check: (...mutants: (TreeMutant | undefined)[]) => Promise<string | undefined>): Check =>
  (mutant) =>
    check(RECORD_NAMES_REUSED_NODE, mutant);

describe("mutation", () => {
  const checks = new Map<TreeMutant, readonly Check[]>([
    [GC_IGNORES_LIVE_ROOT, [membershipFailure]],
    [GC_DELETES_UNPARSEABLE_KEY, [sweepFailure]],
    [GC_DELETES_CORRUPT_CANDIDATE, [corruptFailure]],
    [GC_KEY_ONLY_MEMBERSHIP_AT_DEPTH_2, [membershipFailure, sweepFailure]],
    [GC_MEMBER_WRONG_LEVEL, [membershipFailure, sweepFailure]],
    [GC_MEMBER_ATTEMPT_ONLY, [membershipFailure, reclaimFailure]],
    [GC_PATH_MISS_AS_NONMEMBER, [membershipFailure]],
    [SWEEP_MEMBER_AGAINST_MARK_ROOT, [sweepInFlightFailure]],
    [GC_SKIPS_MEMBERSHIP_CHECK, [membershipFailure, withReusedNode(reclaimFailure)]],
    [PUBLISH_REUSES_ATTEMPT, [reuseCounterFailure]],
    [GC_IGNORES_DUPLICATE_IDENTITY, [reuseFailure]],
    [GC_PROCESSES_OPEN_FLOOR, [openFloorFailure]],
    [GC_IGNORES_GENERATION, [regenerationFailure]],
    [GC_WINNER_AS_LOSER, [raceFailure]],
    [GC_LOSER_AS_WINNER, [raceFailure]],
    [GC_WINNER_BY_KEY_ORDER, [raceFailure]],
    [GC_IGNORES_DUE_AT, [readDuringGcFailure]],
    [GC_LOCAL_CLOCK, [skewFailure]],
    [SWEEP_NO_FLOOR_GATE, [sweepInFlightFailure]],
    [SWEEP_FLOOR_BEFORE_LIST, [floorBeforeListFailure]],
    [SWEEP_AGE_FROM_NOTE, [supersededAfterNoteFailure]],
    [GC_CORRUPT_NO_RETRY, [misreadFailure]],
  ]);

  test("every GC mutant has checks", () => {
    expect([...checks.keys()]).toEqual(GC_MUTANTS);
  });

  test("a record that names a reused node loses nothing while the membership check holds", async () => {
    await expect(withReusedNode(reclaimFailure)()).resolves.toBeUndefined();
  });

  test.each(GC_MUTANTS.map((mutant) => [mutant.name, mutant] as const))(
    "%s turns its checks red",
    async (_name, mutant) => {
      for (const check of checks.get(mutant)!) {
        await expect(check(mutant)).resolves.toBeDefined();
      }
    },
    2 * LONG,
  );
});
