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
import {
  BaerlyError,
  encodeJsonBytes,
  GC_MARK_LIST_PAGE_KEYS,
  RequestLedger,
  type Storage,
} from "@baerly/protocol";
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
  GC_DELETES_BEFORE_PROBE,
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
  TREE_GC_CLOCK_RESET_MINUTES,
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
import { createTreeConfig } from "./layout.ts";
import { sealFoldRecord } from "./record.ts";
import { openTreeView } from "./read.ts";

const MIXED: readonly GcChange[] = [
  ["k03", 103],
  ["k10a", 7],
  ["k16", null],
];

const DELAY = TREE_GC_SUPERSEDED_DELAY_MINUTES;

/**
 * A ledger with room for exactly one candidate check at depth 3, after
 * the four calls a probe tick makes before it sizes its checks (the
 * state GET, the sweep LIST, the head and root GETs), each charged at
 * every attempt.
 */
const ONE_CHECK_LEDGER = TREE_GC_TICK_RESERVED_CALLS + 4 * 3 + 12;
const AGE = TREE_GC_SWEEP_AGE_MINUTES;
const RESET = TREE_GC_CLOCK_RESET_MINUTES;
const LONG = 60_000;

/**
 * Run `check`, turning a throw into a failure message: a read that found
 * a node the root names missing is reported as that, anything else as a
 * throw, which the mutation block accepts only where it says so.
 */
const guarded = async (check: () => Promise<string | undefined>): Promise<string | undefined> => {
  try {
    return await check();
  } catch (error) {
    if (
      error instanceof BaerlyError &&
      error.code === "InvalidResponse" &&
      /missing|absent/.test(error.message)
    ) {
      return `a read met a missing node: ${error.message}`;
    }
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

/**
 * An attempt in flight at the head's floor for longer than the sweep
 * age is neither resolved nor stuck, and once it lands everything it
 * recorded is reclaimed. Treating the open floor as closed cannot
 * delete here (no evidence ever names an attempt still in flight), but
 * it marks the floor stuck, ages it out and retires the attempt's
 * record leak-only, so what the attempt superseded leaks.
 */
const openFloorFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const flight = await bucket.startFold([["k05", 55]]);
    const problems: string[] = [];
    for (let i = 0; i < AGE + 5; i++) {
      bucket.advance(1);
      await bucket.tick(gcConfig(mutant));
      const state = await bucket.state();
      const stuck = state?.stuck ?? null;
      if (stuck !== null && i === 0) {
        problems.push(`floor ${stuck.floor} marked stuck`);
      }
    }
    await flight.release();
    bucket.advance(1);
    await reclaim(bucket, gcConfig(mutant));
    const left = await reclaimedProblems(bucket);
    if (left !== undefined) {
      problems.push(left);
    }
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
 * became unreachable. A sweep that took a stray key for a node would
 * not count it, and would hand it to the membership check, which never
 * answers "delete" for a key that does not parse; so that defect shows
 * here as the missing count, with the strays still in place.
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
    // The attempt's record lags in LIST, so only the floor gate protects its nodes.
    bucket.listLag.add("0".repeat(32));
    const flight = await bucket.startFold([["k08", 88]], { attempt: "0".repeat(32) });
    await bucket.tickFor(AGE + 10, gcConfig(mutant), watch);
    await flight.release();
    bucket.listLag.clear();
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
    bucket.listLag.add("0".repeat(32));
    const flight = await bucket.startFold([["k08", 88]], { attempt: "0".repeat(32) });
    await bucket.tickFor(30, gcConfig(mutant), watch);
    await flight.release();
    bucket.listLag.clear();
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
    bucket.listLag.add("0".repeat(32));
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
    bucket.listLag.clear();
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

/**
 * A one-time misread of a superseded node is read again: no corruption
 * is counted or warned, and the record path reclaims the node on a later
 * probe, well before the sweep age.
 */
const misreadFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const target = await supersededBelowRoot(bucket);
    let armed = false;
    let misread = false;
    bucket.getOverride = (key) => {
      if (key === target && armed && !misread) {
        misread = true;
        return new TextEncoder().encode("torn read");
      }
      return undefined;
    };
    const problems: string[] = [];
    for (const minutes of [0, DELAY + 1, 1, 1]) {
      // The misread lands on the record drain, in the tick the node is due.
      armed = minutes > 0;
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
    const left = await bucket.keys(GC_NODES);
    if (left.includes(target)) {
      problems.push(`the misread node ${target} was not reclaimed`);
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

/**
 * A duplicate identity found only after its loser entry was assigned:
 * X loses a floor; a tick with room for one check resolves the floor and
 * names X's record as the loser to drain, but drains nothing; then an
 * attempt reusing X starts, adopting X's existing leaf. The next tick
 * must not drain X's fresh nodes, and the reusing attempt's CAS lands on
 * a complete tree.
 */
const lateDuplicateFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const reused = "a".repeat(32);
    const loser = await bucket.prepare([["k03", 5]]);
    await bucket.fold([["k19", 119]], { attempt: "b".repeat(32) });
    await bucket.publish(loser, { attempt: reused });
    // Room for one check: the probe's sweep page takes it.
    const first = await bucket.tickWithLedger(ONE_CHECK_LEDGER, gcConfig(mutant));
    const state = await bucket.state();
    const entry = state?.work.find((w) => w.floor === 20);
    if (first.result.candidates !== 1 || entry?.loser?.record.slice(0, 32) !== reused) {
      return `setup: candidates ${first.result.candidates}, entry ${JSON.stringify(entry)}`;
    }
    const retry = await bucket.startFold([["k03", 5]], { attempt: reused });
    bucket.advance(1);
    await bucket.tick(gcConfig(mutant));
    const outcome = await retry.release();
    if (outcome.kind !== "published" || outcome.adopted === 0) {
      return `setup: the retry was ${outcome.kind}, adopting ${outcome.adopted}`;
    }
    return joined(await bucket.violations());
  });

/**
 * A lost attempt's record is gone, so the sweep marks and stamps its
 * nodes; before they are due an attempt reusing its identity starts and
 * adopts one of them. The sweep must not delete it while that attempt
 * can still land.
 */
const sweepReuseFailure = (mutant?: TreeMutant, duplicateRecord = false) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const reused = "a".repeat(32);
    const loser = await bucket.prepare([["k07", 77]]);
    await bucket.fold([["k12", 12]]);
    const lost = await bucket.publish(loser, { attempt: reused });
    await bucket.memory.delete(lost.record);
    let stamped = false;
    for (let minute = 0; minute < 40 && !stamped; minute++) {
      if (minute === 5) {
        await bucket.fold([["k19", 19]]);
      }
      bucket.advance(1);
      await bucket.tick(gcConfig(mutant));
      const state = await bucket.state();
      stamped = (state?.sweep.marks ?? []).some(
        (mark) => mark.key.startsWith(reused) && mark.due_at !== null,
      );
    }
    if (!stamped) {
      return "setup: no mark of the lost attempt was stamped";
    }
    if (duplicateRecord) {
      const duplicate = await bucket.prepare([
        ["k07", 77],
        ["k09", 99],
      ]);
      await bucket.refreshTailHint();
      const lostAgain = await bucket.publish(duplicate, { attempt: reused });
      if (lostAgain.kind !== "cas-lost") {
        return `setup: the duplicate was ${lostAgain.kind}`;
      }
    }
    const retry = await bucket.startFold([["k07", 77]], { attempt: reused });
    await bucket.tickFor(AGE + 5, gcConfig(mutant));
    const outcome = await retry.release();
    if (outcome.kind !== "published" || outcome.adopted === 0) {
      return `setup: the retry was ${outcome.kind}, adopting ${outcome.adopted}`;
    }
    return joined(await bucket.violations());
  });

/**
 * A probe tick on a nearly spent ledger, at depth 3 with room for one
 * check, stays within the static bound for that one check: the sweep
 * page shrinks to fit instead of checking every listed key.
 */
const nearFullLedgerFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    await bucket.fold(MIXED);
    let checks = 0;
    const counted = gcConfig(mutant);
    const isMember = counted.steps.gcIsMember ?? treeGcMembership;
    const config = createTreeConfig({
      layout: counted.layout,
      steps: {
        ...counted.steps,
        gcIsMember: (x, view) => {
          checks += 1;
          return isMember(x, view);
        },
      },
    });
    const { result, charged } = await bucket.tickWithLedger(ONE_CHECK_LEDGER, config);
    if (result.candidates !== 1 || !result.probed) {
      return `setup: ${result.candidates} candidates, probed ${result.probed}`;
    }
    const bound = TREE_GC_TICK_RESERVED_CALLS + result.candidates * treeGcCandidateCharge(3);
    const problems: string[] = [];
    if (checks > result.candidates) {
      problems.push(`${checks} candidate checks with room for ${result.candidates}`);
    }
    if (charged > bound) {
      problems.push(`charged ${charged} of a ${bound}-call bound`);
    }
    return joined(problems);
  });

/**
 * A record of another head history at the floor a new history's floor
 * resolves against: it is never the evidence that names the new floor's
 * winner, so the new winner's fresh nodes are not deleted as a loser's.
 */
const generationWitnessFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded("0a");
    await bucket.fold(MIXED);
    // Re-seed a new history over the old records, none reclaimed.
    await bucket.memory.put(GC_HEAD, encodeJsonBytes(freshGcHead("0b")));
    bucket.rows.clear();
    const watch = new MarginWatch(bucket);
    await bucket.fold(GC_SEED);
    await watch.observe();
    await bucket.fold(MIXED);
    await watch.observe();
    for (let i = 0; i < 4; i++) {
      bucket.advance(1);
      const { result } = await bucket.tick(gcConfig(mutant));
      await watch.afterTick(result.deleted);
    }
    return joined(watch.problems);
  });

/**
 * A node noted while its attempt was in flight is a member once the
 * attempt lands, so it is dropped, not stamped: a fold that supersedes
 * it late in what would have been its age leaves it the full delay.
 */
const lateSupersedeFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const watch = new MarginWatch(bucket);
    await watch.observe();
    bucket.listLag.add("0".repeat(32));
    const flight = await bucket.startFold([["k08", 88]], { attempt: "0".repeat(32) });
    await bucket.tickFor(10, gcConfig(mutant), watch);
    await flight.release();
    bucket.listLag.clear();
    await watch.observe();
    // A fold moves the floor, so the next probe judges every noted mark.
    await bucket.fold([["k19", 19]]);
    await watch.observe();
    await bucket.tickFor(AGE - 8, gcConfig(mutant), watch);
    await bucket.fold([["k08", 89]]);
    await watch.observe();
    await bucket.tickFor(30, gcConfig(mutant), watch);
    return joined(watch.problems);
  });

/**
 * A winner whose identity shows up in other records while its list is
 * still pending is never a deletion source, even in a tick whose record
 * DELETEs run out before its own record is retired.
 */
const quarantineFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const winner = "c".repeat(32);
    const before = await bucket.reachable();
    await bucket.fold(MIXED, { attempt: winner });
    const superseded = await supersededSince(bucket, before);
    await bucket.tick(gcConfig(mutant));
    // Five more records under the winner's identity, all sorting before its own.
    for (let floor = 1; floor <= 5; floor++) {
      const sealed = await sealFoldRecord(GC_PREFIX, {
        attempt: winner,
        base: { floor, root: null, attempt: null, generation: null },
        result: { floor: floor + 1, root: null },
        fresh: [],
        superseded: [],
      });
      await bucket.memory.put(sealed.key, sealed.bytes);
    }
    bucket.advance(DELAY + 1);
    const { result } = await bucket.tick(gcConfig(mutant));
    const taken = result.deleted.filter((key) => superseded.includes(key));
    return taken.length === 0
      ? undefined
      : `deleted ${taken.length} of the winner's superseded nodes`;
  });

/**
 * The state changes between a tick's state GET and its probe write, in a
 * tick that has records to retire (an identity in two records): the
 * probe loses, and the tick deletes nothing.
 */
const lostProbeFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const reused = "a".repeat(32);
    const loser = await bucket.prepare([["k03", 5]]);
    await bucket.fold([["k19", 119]]);
    await bucket.publish(loser, { attempt: reused });
    await bucket.fold([["k03", 5]], { attempt: reused });
    const before = [...(await bucket.keys(GC_NODES)), ...(await bucket.keys(GC_RECORDS))];
    // Another tick's state write lands while this one lists its records.
    const head = await bucket.head();
    const floor = head.json.log_seq_start;
    bucket.onList.set(GC_RECORDS, async () => {
      await bucket.memory.put(GC_STATE, encodeTreeGcState(emptyTreeGcState(null, floor)));
    });
    const { result } = await bucket.tick(gcConfig(mutant));
    const after = new Set([...(await bucket.keys(GC_NODES)), ...(await bucket.keys(GC_RECORDS))]);
    const problems: string[] = [];
    if (result.outcome !== "conflict") {
      problems.push(`setup: the tick ended ${result.outcome}`);
    }
    if (result.deleted.length > 0) {
      problems.push(`deleted ${result.deleted.join(", ")} after losing the probe`);
    }
    const gone = before.filter((key) => !after.has(key));
    if (gone.length > 0) {
      problems.push(`gone from the bucket: ${gone.join(", ")}`);
    }
    return joined(problems);
  });

/**
 * A winner's identity reappears in four records that sort before its
 * own, so the tick's record DELETEs retire those four and run out before
 * the winner's record. Later ticks see the identity once again, yet the
 * slot stays quarantined: it drops and its record is retired, and none
 * of the nodes it names is deleted.
 */
const quarantineClearsFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const winner = "c".repeat(32);
    await bucket.fold(MIXED, { attempt: winner });
    await bucket.tick(gcConfig(mutant));
    const listed = await bucket.keys(GC_RECORDS);
    const own = listed.find((key) => key.includes(`/${winner}/`))!;
    for (let floor = 1; floor <= 4; floor++) {
      const sealed = await sealFoldRecord(GC_PREFIX, {
        attempt: winner,
        base: { floor, root: null, attempt: null, generation: null },
        result: { floor: floor + 1, root: null },
        fresh: [],
        superseded: [],
      });
      await bucket.memory.put(sealed.key, sealed.bytes);
    }
    const deleted: string[] = [];
    for (const minutes of [DELAY + 1, 1, 1, 1]) {
      bucket.advance(minutes);
      const { result } = await bucket.tick(gcConfig(mutant));
      deleted.push(...result.deleted);
    }
    const problems: string[] = [];
    const nodes = deleted.filter((key) => key.startsWith(GC_NODES));
    if (nodes.length > 0) {
      problems.push(`deleted nodes ${nodes.join(", ")}`);
    }
    const left = await bucket.keys(GC_RECORDS);
    if (left.includes(own)) {
      problems.push("the quarantined winner's record remains");
    }
    const state = await bucket.state();
    if (state?.work.some((entry) => entry.winner.startsWith(winner))) {
      problems.push("the quarantined slot remains");
    }
    return joined(problems);
  });

/**
 * A full record page made only of keys that do not parse, all sorting
 * before the real records: the page does not show the floors past it,
 * so no winner slot whose record lies there is dropped, and once the
 * stray keys are gone everything is reclaimed.
 */
const strayPageFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    await bucket.fold(MIXED);
    await bucket.tick(gcConfig(mutant));
    const first = await bucket.state();
    const floors = first?.work.map((entry) => entry.floor) ?? [];
    if (floors.length === 0) {
      return "setup: no work entry";
    }
    const strays = Array.from({ length: GC_MARK_LIST_PAGE_KEYS }, (_, i) => `${GC_RECORDS}0/${i}`);
    for (const key of strays) {
      await bucket.memory.put(key, new TextEncoder().encode("{}"));
    }
    bucket.advance(DELAY + 1);
    await bucket.tick(gcConfig(mutant));
    const problems: string[] = [];
    const after = await bucket.state();
    const kept = after?.work.map((entry) => entry.floor) ?? [];
    const lost = floors.filter((floor) => !kept.includes(floor));
    if (lost.length > 0) {
      problems.push(`slots past the page dropped: floors ${lost.join(", ")}`);
    }
    for (const key of strays) {
      await bucket.memory.delete(key);
    }
    await reclaim(bucket, gcConfig(mutant));
    const left = await reclaimedProblems(bucket);
    if (left !== undefined) {
      problems.push(left);
    }
    return joined(problems);
  });

/**
 * Attempt A changes one row and W changes it again, superseding every
 * node A wrote. Once they are due, an attempt reusing A's identity
 * starts and adopts some of them by writing A's value back. W is a
 * trusted winner, but the identity its superseded nodes carry is not:
 * GC must not delete them while that attempt can still land.
 */
const supersededReuseFailure = (mutant?: TreeMutant) =>
  guarded(async () => {
    const bucket = await GcBucket.seeded();
    const reused = "a".repeat(32);
    await bucket.fold([["k03", 103]], { attempt: reused });
    await bucket.fold([["k03", 303]], { attempt: "c".repeat(32) });
    await bucket.tick(gcConfig(mutant));
    bucket.advance(DELAY + 1);
    const retry = await bucket.startFold([["k03", 103]], { attempt: reused });
    await bucket.tick(gcConfig(mutant));
    const outcome = await retry.release();
    if (outcome.kind !== "published" || outcome.adopted === 0) {
      return `setup: the retry was ${outcome.kind}, adopting ${outcome.adopted}`;
    }
    return joined(await bucket.violations());
  });

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

  test("a one-time misread is read again, not counted as corruption, and reclaimed later", async () => {
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

  test("a full record page of keys that do not parse drops no slot past the page", async () => {
    await expect(strayPageFailure()).resolves.toBeUndefined();
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

  test("a key that does not parse as a node key is never answered with non-member", async () => {
    const bucket = await GcBucket.seeded();
    const config = gcConfig();
    const head = (await readTreeHead(bucket.storage, GC_PREFIX))!;
    const root = await readTreeRoot(bucket.storage, head, config);
    const view = createTreeGcRootView(bucket.storage, GC_PREFIX, root, config);
    for (const key of [
      `${GC_NODES}${gcAttemptOf(9)}/${"0".repeat(64)}.json`,
      `${GC_NODES}${"A".repeat(32)}/${"0".repeat(64)}`,
      `${GC_RECORDS}0000000000000000/${gcAttemptOf(9)}/${"0".repeat(64)}`,
    ]) {
      await expect(treeGcMembership(key, view)).resolves.toBe("not-a-node");
    }
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

  test("a duplicate found after its loser entry was assigned stops that loser's drain", async () => {
    await expect(lateDuplicateFailure()).resolves.toBeUndefined();
  });

  test(
    "the sweep never deletes a node of an identity a publication still in flight holds",
    async () => {
      await expect(sweepReuseFailure()).resolves.toBeUndefined();
    },
    LONG,
  );

  test("retiring duplicate records preserves an open publisher's sweep protection", async () => {
    await expect(sweepReuseFailure(undefined, true)).resolves.toBeUndefined();
  });

  test("a winner whose identity reappears is quarantined even when its record outlives the tick", async () => {
    await expect(quarantineFailure()).resolves.toBeUndefined();
  });

  test("a quarantined slot drops and retires its winner's record leak-only", async () => {
    await expect(quarantineClearsFailure()).resolves.toBeUndefined();
  });

  test("a winner's superseded node whose own identity is untrusted is not deleted", async () => {
    await expect(supersededReuseFailure()).resolves.toBeUndefined();
  });

  test("a record of another head history is never evidence for the new history's winner", async () => {
    await expect(generationWitnessFailure()).resolves.toBeUndefined();
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
    "a noted node that becomes a member is dropped, so a late supersession still gets the full delay",
    async () => {
      await expect(lateSupersedeFailure()).resolves.toBeUndefined();
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
    // A local clock a little behind the last probe's is skew, and waits.
    bucket.advance(-10, 0);
    await expect(bucket.tick()).resolves.toMatchObject({ result: { probed: false } });
    // A jump back past the reset bound is a clock reset, and probes at once.
    bucket.advance(-RESET, 0);
    await expect(bucket.tick()).resolves.toMatchObject({ result: { probed: true } });
  });

  test("writers on two instances whose clocks are 2 minutes apart do not probe on every tick", async () => {
    const bucket = await GcBucket.seeded();
    let probes = 0;
    const ticks = 24;
    for (let i = 0; i < ticks; i++) {
      // Fifteen seconds apart, alternating between an instance on time and one 2 minutes behind.
      bucket.advance(0.25);
      const behind = i % 2 === 1 ? 2 * 60_000 : 0;
      bucket.local -= behind;
      const { result } = await bucket.tick();
      bucket.local += behind;
      probes += result.probed ? 1 : 0;
    }
    // Six minutes of ticks: about one probe a minute, not one a tick.
    expect(probes).toBeLessThanOrEqual(7);
  });

  test("between probes a tick lists and deletes nothing, even with work due; the next probe does it", async () => {
    const bucket = await GcBucket.seeded();
    await bucket.tick();
    const loser = await bucket.prepare([["k04", 44]]);
    await bucket.fold([["k15", 55]]);
    const lost = await bucket.publish(loser);
    expect(lost.kind).toBe("cas-lost");
    const fresh = await freshOf(bucket, lost.attempt);
    expect(fresh.length).toBeGreaterThan(0);
    const listed: string[] = [];
    bucket.onList.set(GC_RECORDS, async () => {
      listed.push(GC_RECORDS);
    });
    bucket.onList.set(GC_NODES, async () => {
      listed.push(GC_NODES);
    });
    const kept = [...(await bucket.keys(GC_NODES)), ...(await bucket.keys(GC_RECORDS))];
    bucket.advance(0.5);
    const paced = await bucket.tick();
    expect(paced.result).toMatchObject({ outcome: "paced", probed: false, deleted: [] });
    expect(listed).toEqual([]);
    await expect(bucket.keys(GC_NODES)).resolves.toEqual(expect.arrayContaining(fresh));
    expect([...(await bucket.keys(GC_NODES)), ...(await bucket.keys(GC_RECORDS))]).toEqual(kept);
    bucket.advance(0.6);
    const { result } = await bucket.tick();
    expect(result).toMatchObject({ outcome: "collected", probed: true });
    expect(result.deleted).toEqual(expect.arrayContaining([...fresh, lost.record]));
    await expect(bucket.violations()).resolves.toEqual([]);
  });

  test("a malformed state is replaced by the empty state, and that is the tick's only write", async () => {
    const bucket = await GcBucket.seeded();
    await bucket.fold(MIXED);
    const nodes = await bucket.keys(GC_NODES);
    await bucket.memory.put(
      GC_STATE,
      encodeJsonBytes({ format: "baerly-tree-gc-state-proto", schema_version: 1, ticks: -1 }),
    );
    await expect(bucket.tick()).resolves.toMatchObject({
      result: { outcome: "reset", deleted: [] },
    });
    await expect(bucket.state()).resolves.toEqual(emptyTreeGcState(null, 23));
    await expect(bucket.keys(GC_NODES)).resolves.toEqual(nodes);
  });

  test.each([
    ["a newer schema", { format: "baerly-tree-gc-state-proto", schema_version: 2 }],
    ["a non-number schema", { format: "baerly-tree-gc-state-proto", schema_version: "2" }],
    ["another format", { format: "baerly-tree-gc-state-next", schema_version: 1 }],
  ])("a state of %s stops the tick with InvalidResponse and no write", async (_name, body) => {
    const bucket = await GcBucket.seeded();
    await bucket.memory.put(GC_STATE, encodeJsonBytes(body));
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

  test("a tick whose probe write loses deletes nothing and ends in conflict", async () => {
    await expect(lostProbeFailure()).resolves.toBeUndefined();
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

  test("a probe tick on a nearly spent ledger shortens its sweep page to fit its one check", async () => {
    await expect(nearFullLedgerFailure()).resolves.toBeUndefined();
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

  test("a probe tick with no room for one check at any depth lists nothing and still retires the log", async () => {
    const bucket = await GcBucket.seeded();
    const listed: string[] = [];
    for (const prefix of [GC_NODES, GC_RECORDS]) {
      bucket.onList.set(prefix, async () => {
        listed.push(prefix);
      });
    }
    const before = await bucket.head();
    const floorBefore = before.json.log_delete_floor ?? 0;
    const { result } = await bucket.tickWithLedger(TREE_GC_TICK_RESERVED_CALLS + 2, gcConfig(), 0);
    expect(result).toMatchObject({ outcome: "budget", probed: false, deleted: [] });
    expect(listed).toEqual([]);
    const head = await bucket.head();
    expect(head.json.log_delete_floor).toBeGreaterThan(floorBefore);
  });

  test("a probe tick with no room at the root's depth writes the probe, so the next ticks are paced", async () => {
    const bucket = await GcBucket.seeded();
    // Room for one check at depth 0 after the state GET, none at depth 3 after the root GET.
    const limit = TREE_GC_TICK_RESERVED_CALLS + 4 * 3 + 5;
    const first = await bucket.tickWithLedger(limit);
    expect(first.result).toMatchObject({ outcome: "budget", deleted: [] });
    const listed: string[] = [];
    for (const prefix of [GC_NODES, GC_RECORDS]) {
      bucket.onList.set(prefix, async () => {
        listed.push(prefix);
      });
    }
    bucket.advance(0.5);
    const second = await bucket.tickWithLedger(limit);
    expect(second.result.outcome).toBe("paced");
    expect(listed).toEqual([]);
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
    [
      GC_IGNORES_DUPLICATE_IDENTITY,
      [
        reuseFailure,
        lateDuplicateFailure,
        sweepReuseFailure,
        quarantineClearsFailure,
        supersededReuseFailure,
      ],
    ],
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
    [GC_DELETES_BEFORE_PROBE, [lostProbeFailure]],
  ]);

  test("every GC mutant has checks", () => {
    expect([...checks.keys()]).toEqual(GC_MUTANTS);
  });

  test("a record that names a reused node loses nothing while the membership check holds", async () => {
    await expect(withReusedNode(reclaimFailure)()).resolves.toBeUndefined();
  });

  /** Mutants whose only consequence is a throw, and the throw each must raise; none today. */
  const throws = new Map<TreeMutant, RegExp>();

  test.each(GC_MUTANTS.map((mutant) => [mutant.name, mutant] as const))(
    "%s turns its checks red",
    async (_name, mutant) => {
      for (const check of checks.get(mutant)!) {
        const found = await check(mutant);
        expect(found).toBeDefined();
        const expected = throws.get(mutant);
        if (expected === undefined) {
          expect(found).not.toMatch(/^threw /);
        } else {
          expect(found).toMatch(expected);
        }
      }
    },
    2 * LONG,
  );
});
