/**
 * The tree model's transition executor driving the real `Writer` on memory
 * storage, with the properties the log path alone can falsify checked
 * against the logical oracle: acknowledged commits are never lost,
 * unacknowledged ones never become visible, and every read equals the
 * oracle. The other five properties need a fold, GC or warm reader;
 * `tests/fixtures/tree-model-properties.ts` lists what each requires.
 */
import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import { BaerlyError, decodeJsonBytes, type DocumentData, encodeJsonBytes } from "@baerly/protocol";
import { findLogTail, probeTailFrom } from "@baerly/server/_internal/kernel";
import { foldLogEntriesOnto } from "../../packages/server/src/log-walk.ts";
import {
  capabilitiesOf,
  headOf,
  logCreateTarget,
  logPathSystem,
  runTreeSchedule,
  TREE_MODEL_PREFIX,
  treeScheduleArbitrary,
  type TreeCrashPoint,
  type TreeRun,
  type TreeSystem,
  type TreeSystemFactory,
  type TreeTransition,
  type TreeWorld,
} from "../fixtures/tree-executor.ts";
import {
  checkTreeProperties,
  checkTreeStructure,
  isEvaluable,
  TREE_MUTATION_SCHEDULES,
  TREE_PROPERTIES,
  TREE_REFUSED_COMMIT,
  type TreeStructureOracle,
} from "../fixtures/tree-model-properties.ts";

const failuresOf = (run: TreeRun): string[] =>
  checkTreeProperties(run).flatMap((check) =>
    check.failures.map((failure) => `${check.name}: ${failure}`),
  );

const logPathBounds = {
  capabilities: capabilitiesOf(logPathSystem()),
  docIds: ["a", "b", "c"],
  maxLength: 12,
  maxCrashOp: 6,
} as const;

describe("transition executor", () => {
  test("the log path provides no fold, GC or warm reader", () => {
    expect([...capabilitiesOf(logPathSystem())]).toEqual([]);
  });

  test.each<[string, TreeTransition[]]>([
    ["fold", [{ kind: "fold" }]],
    ["fold-prepare", [{ kind: "fold-prepare" }]],
    ["gc", [{ kind: "gc" }]],
    ["warm read", [{ kind: "read", mode: "warm" }]],
  ])("refuses a %s step the system cannot run, before any step runs", async (_label, tail) => {
    let commits = 0;
    const counting = (): TreeSystem => {
      const real = logPathSystem();
      return {
        ...real,
        commit: (world, input) => {
          commits += 1;
          return real.commit(world, input);
        },
      };
    };
    await expect(
      runTreeSchedule(counting, [{ kind: "commit", op: "I", docId: "a", value: 1 }, ...tail]),
    ).rejects.toThrow(/needs the (fold|gc|warm-read) capability/);
    expect(commits).toBe(0);
  });

  test("refuses a retry of a step that is not a crashed fold or GC", async () => {
    await expect(
      runTreeSchedule(logPathSystem, [
        { kind: "commit", op: "I", docId: "a", value: 1 },
        { kind: "retry", of: 0 },
      ]),
    ).rejects.toThrow(/not an earlier fold or GC step/);
  });

  test("records each step's outcome, ops and image", async () => {
    const run = await runTreeSchedule(logPathSystem, [
      { kind: "commit", op: "I", docId: "a", value: 1 },
      { kind: "commit", op: "U", docId: "a", value: 2 },
      { kind: "commit", op: "D", docId: "a" },
      { kind: "read", mode: "cold" },
      TREE_REFUSED_COMMIT,
    ]);
    expect(run.steps.map((step) => step.outcome.kind)).toEqual([
      "acknowledged",
      "acknowledged",
      "acknowledged",
      "read",
      "refused",
    ]);
    expect(run.steps[1]!.applied.map((op) => `${op.op} ${op.key}`)).toEqual([
      `put ${TREE_MODEL_PREFIX}/log/1.json`,
    ]);
    expect(run.steps[1]!.reached).toBeGreaterThan(1);
    expect(run.steps[4]!.reached).toBe(0);
    for (const step of run.steps) {
      expect(headOf(step.image, TREE_MODEL_PREFIX)?.snapshot).toBeNull();
    }
    expect(run.finalRead).toEqual({ kind: "read", rows: new Map() });
  });

  test("a before crash kills the process: no later op lands and the next step gets a new system", async () => {
    let built = 0;
    const real = logPathSystem();
    // A commit that swallows its abort and writes on, as a catch block would.
    const stubborn = (): TreeSystem => {
      built += 1;
      return {
        ...real,
        commit: async (world, input) => {
          try {
            return await real.commit(world, input);
          } catch {
            await world.storage.put(`${world.prefix}/stray.json`, encodeJsonBytes({}));
            return await real.commit(world, input);
          }
        },
      };
    };
    const run = await runTreeSchedule(stubborn, [
      { kind: "commit", op: "I", docId: "a", value: 1 },
      {
        kind: "commit",
        op: "I",
        docId: "b",
        value: 2,
        crash: { boundary: "before", nth: 1, target: logCreateTarget() },
      },
      { kind: "commit", op: "I", docId: "c", value: 3 },
    ]);
    expect(run.steps[1]!.died).toBe(true);
    expect(run.steps[1]!.outcome.kind).toBe("crashed");
    expect(run.steps[1]!.applied).toEqual([]);
    expect(run.steps[2]!.outcome.kind).toBe("acknowledged");
    expect(built).toBe(2);
  });

  test("an after crash is a lost response, not a death", async () => {
    let built = 0;
    const counting = (): TreeSystem => {
      built += 1;
      return logPathSystem();
    };
    const run = await runTreeSchedule(counting, [
      {
        kind: "commit",
        op: "I",
        docId: "a",
        value: 1,
        crash: { boundary: "after", nth: 1, target: logCreateTarget() },
      },
      { kind: "commit", op: "I", docId: "b", value: 2 },
    ]);
    expect(run.steps[0]!.crashFired).toBe(true);
    expect(run.steps[0]!.died).toBe(false);
    expect(built).toBe(1);
  });

  test("fails a run whose step leaves a snapshot on the tree head", async () => {
    const snapshotting = (): TreeSystem => {
      const real = logPathSystem();
      return {
        ...real,
        name: "snapshotting",
        commit: async (world, input) => {
          const result = await real.commit(world, input);
          const stored = await world.storage.get(world.currentJsonKey);
          const head = decodeJsonBytes<Record<string, unknown>>(stored!.body);
          await world.storage.put(
            world.currentJsonKey,
            encodeJsonBytes({ ...head, snapshot: "snapshot/L9/x.json" }),
          );
          return result;
        },
      };
    };
    await expect(
      runTreeSchedule(snapshotting, [{ kind: "commit", op: "I", docId: "a", value: 1 }]),
    ).rejects.toThrow(/left snapshot .* on the tree head/);
  });
});

describe("log-path properties", () => {
  test("the commit and read properties are evaluable on the log path", () => {
    const capabilities = capabilitiesOf(logPathSystem());
    expect(
      TREE_PROPERTIES.filter((property) => isEvaluable(property, capabilities, {})).map(
        (property) => property.name,
      ),
    ).toEqual([
      "acknowledged-never-lost",
      "unacknowledged-never-visible",
      "cold-and-warm-equal-reference",
    ]);
  });

  test("a run that reaches nothing exercises nothing and violates nothing", async () => {
    const run = await runTreeSchedule(logPathSystem, [TREE_REFUSED_COMMIT]);
    expect(checkTreeProperties(run).map(({ status }) => status)).toEqual([
      "not-exercised",
      "not-exercised",
      "not-exercised",
    ]);
  });

  /** Every crash point a commit can hit: each op, before it applies and after. */
  test("hold when a commit crashes at any op, before or after it applies", async () => {
    let fired = 0;
    for (const boundary of ["before", "after"] as const) {
      for (let nth = 1; ; nth++) {
        const crash: TreeCrashPoint = { boundary, nth };
        const run = await runTreeSchedule(logPathSystem, [
          { kind: "commit", op: "I", docId: "a", value: 1 },
          { kind: "commit", op: "I", docId: "b", value: 2, crash },
          { kind: "commit", op: "U", docId: "a", value: 3 },
          { kind: "read", mode: "cold" },
          { kind: "commit", op: "D", docId: "b", crash },
          { kind: "read", mode: "cold" },
        ]);
        expect(failuresOf(run), `${boundary} op ${nth}`).toEqual([]);
        if (!run.steps[1]!.crashFired) {
          break;
        }
        fired += 1;
      }
    }
    // A commit issues at least the head read, the tail probe, the log
    // create and the floor re-read, so each boundary fires at least 4 times.
    expect(fired).toBeGreaterThanOrEqual(8);
  });

  fcTest.prop({ schedule: treeScheduleArbitrary(logPathBounds) })(
    "hold over generated schedules",
    async ({ schedule }) => {
      const run = await runTreeSchedule(logPathSystem, schedule);
      expect(failuresOf(run)).toEqual([]);
    },
  );

  test("generated schedules reach every evaluable property and crash boundary", async () => {
    const schedules = fc.sample(treeScheduleArbitrary(logPathBounds), { seed: 1, numRuns: 64 });
    const runs: TreeRun[] = [];
    for (const schedule of schedules) {
      runs.push(await runTreeSchedule(logPathSystem, schedule));
    }
    const structure = checkTreeStructure(runs);
    expect(structure.map(({ name }) => name)).toEqual([
      "every-evaluable-property-is-exercised",
      "every-crash-boundary-fires",
    ]);
    expect(structure.filter(({ ok }) => !ok)).toEqual([]);
  });
});

/**
 * A stand-in fold and GC that touch only the head: a fold publishes a root
 * named for the log tail it captured, CASing on the head it captured; a
 * GC tick moves the fence. The folded seq stays 0, because the `Writer`
 * refuses a head whose `log_seq_start` moved without a snapshot. It writes
 * no nodes, and its reader folds the whole log, which nothing retires.
 * Enough to run the lost-CAS schedules before the tree fold exists.
 */
const headOnlyFoldSystem =
  (opts: { readonly ignoreCas: boolean }): TreeSystemFactory =>
  () => {
    const base = logPathSystem();
    type Head = Record<string, unknown> & {
      proto_tree?: { root: string | null; gc_fence_epoch: number };
    };
    const readHead = async (world: TreeWorld): Promise<{ head: Head; etag: string }> => {
      const got = await world.storage.get(world.currentJsonKey);
      return { head: decodeJsonBytes<Head>(got!.body), etag: got!.etag };
    };
    const casHead = async (world: TreeWorld, head: Head, etag: string): Promise<boolean> => {
      try {
        await world.storage.put(
          world.currentJsonKey,
          encodeJsonBytes(head),
          opts.ignoreCas ? undefined : { ifMatch: etag },
        );
        return true;
      } catch (error) {
        if (error instanceof BaerlyError && error.code === "WriteConflict") {
          return false;
        }
        throw error;
      }
    };
    return {
      ...base,
      name: opts.ignoreCas ? "head-only-fold+head-put-ignores-cas" : "head-only-fold",
      readCold: async (world) => {
        const rows = new Map<string, DocumentData>();
        const { entries } = await probeTailFrom(world.storage, world.prefix, 0);
        foldLogEntriesOnto(rows, entries, { collection: world.collection });
        return rows;
      },
      fold: {
        prepare: async (world) => {
          const { head, etag } = await readHead(world);
          const tail = await findLogTail(world.storage, world.prefix, 0);
          const root = `${world.prefix}/root-${tail}`;
          return {
            publish: async () => {
              if (head.proto_tree?.root === root) {
                return { kind: "nothing-to-fold" };
              }
              const next: Head = {
                ...head,
                proto_tree: { root, gc_fence_epoch: head.proto_tree?.gc_fence_epoch ?? 0 },
              };
              return (await casHead(world, next, etag))
                ? { kind: "published", foldedSeq: tail, root }
                : { kind: "cas-lost" };
            },
          };
        },
      },
      gc: {
        tick: async (world) => {
          const { head, etag } = await readHead(world);
          const fence = head.proto_tree ?? { root: null, gc_fence_epoch: 0 };
          await casHead(
            world,
            { ...head, proto_tree: { ...fence, gc_fence_epoch: fence.gc_fence_epoch + 1 } },
            etag,
          );
          return { deleted: [] };
        },
      },
    };
  };

/** Every root reaches only itself and nothing is missing; one node per non-empty row set. */
const headOnlyStructure: TreeStructureOracle = {
  reachable: (_image, _prefix, root) => ({ keys: new Set([root]), missing: [] }),
  bookkeepingKeys: () => [],
  canonicalNodeCount: (rows) => (rows.size === 0 ? 0 : 1),
};

describe("lost-cas schedules on a head-only fold and GC", () => {
  const schedules = TREE_MUTATION_SCHEDULES.filter(
    ({ property }) => property === "lost-cas-preserves-winner",
  );

  test("there is a fold race and a GC race", () => {
    expect(schedules.map(({ schedule }) => schedule.some(({ kind }) => kind === "gc"))).toEqual([
      false,
      true,
    ]);
  });

  for (const [index, schedule] of schedules.entries()) {
    test(`head-put-ignores-cas turns lost-cas-preserves-winner red on schedule ${index}`, async () => {
      const oracles = { structure: headOnlyStructure };
      const passing = await runTreeSchedule(
        headOnlyFoldSystem({ ignoreCas: false }),
        schedule.schedule,
      );
      const passingChecks = checkTreeProperties(passing, oracles);
      expect(passingChecks).toHaveLength(8);
      expect(passingChecks.filter(({ status }) => status === "violated")).toEqual([]);
      expect(passingChecks.find(({ name }) => name === schedule.property)!.status).toBe("holds");

      const mutated = await runTreeSchedule(
        headOnlyFoldSystem({ ignoreCas: true }),
        schedule.schedule,
      );
      const mutatedChecks = checkTreeProperties(mutated, oracles);
      const target = mutatedChecks.find(({ name }) => name === schedule.property)!;
      expect(target.exercised).toBe(true);
      expect(target.status).toBe("violated");
      expect(
        mutatedChecks
          .filter(
            ({ name, status }) =>
              status === "violated" &&
              name !== schedule.property &&
              !(schedule.collateral as readonly string[]).includes(name),
          )
          .map(({ name }) => name),
      ).toEqual([]);
    });
  }
});
