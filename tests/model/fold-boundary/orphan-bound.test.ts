import { fc } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";

import { type FoldBudget } from "./boundary.ts";
import { emptyState, rowsAtManifest, type ModelOp, type ModelState } from "./model.ts";
import {
  reclaimUnreferenced,
  runSchedule,
  type ObserverAction,
  type ScheduleResult,
} from "./schedule.ts";

const roomyBudget = (overrides: Partial<FoldBudget> = {}): FoldBudget => ({
  maxEntriesPerRun: 100,
  minEntriesToCompact: 1,
  ceilingBytes: 1_000_000,
  ceilingEntries: 1_000,
  subrequestLimit: 10_000,
  ...overrides,
});

const operations = (count: number): readonly ModelOp[] =>
  Array.from({ length: count }, (_, index) => ({
    kind: "I" as const,
    docId: `doc-${index}`,
    value: index,
  }));

const stateWithTail = (tail: number): ModelState =>
  emptyState({ ops: operations(tail), acknowledgedTail: tail });

const action = (overrides: Partial<ObserverAction> = {}): ObserverAction => ({
  observerId: 0,
  readsAtGeneration: Number.MAX_SAFE_INTEGER,
  observedTail: 20,
  k: 5,
  budget: roomyBudget(),
  algorithm: "aligned-manifest",
  crashAt: "none",
  ...overrides,
});

const sortedKeys = (state: ModelState): readonly string[] => [...state.snapshots.keys()].toSorted();

type ReclamationScenario = "empty" | "crashed" | "mixed-k" | "successive-fold";

const reclamationScenarios: readonly ReclamationScenario[] = [
  "empty",
  "crashed",
  "mixed-k",
  "successive-fold",
];

const expectedClassification = (result: ScheduleResult) => {
  const referenced = new Set(
    result.generations.flatMap(({ snapshotKey }) => (snapshotKey === null ? [] : [snapshotKey])),
  );
  const present = sortedKeys(result.finalState);
  const current = result.finalState.manifest.snapshotKey;
  const neverReferenced = present.filter((key) => !referenced.has(key));
  const superseded = present.filter((key) => referenced.has(key) && key !== current);

  return {
    neverReferenced,
    superseded,
    reclaimable: [...new Set([...neverReferenced, ...superseded])].toSorted(),
  };
};

const reclamationState = (scenario: ReclamationScenario, tail: number): ModelState => {
  const initial = stateWithTail(tail);
  if (scenario === "empty") {
    return runSchedule({ initial, observers: [] }).finalState;
  }
  if (scenario === "crashed") {
    return runSchedule({
      initial,
      observers: [action({ observedTail: tail, k: 1, crashAt: "after_snapshot_put" })],
    }).finalState;
  }
  if (scenario === "mixed-k") {
    return runSchedule({
      initial,
      observers: [
        action({ observerId: 1, readsAtGeneration: 0, observedTail: tail, k: 1 }),
        action({ observerId: 2, readsAtGeneration: 0, observedTail: tail, k: 2 }),
      ],
    }).finalState;
  }

  const first = runSchedule({
    initial,
    observers: [action({ observerId: 1, observedTail: tail, k: 1 })],
  });
  return runSchedule({
    initial: first.finalState,
    observers: [action({ observerId: 2, observedTail: tail, k: 1 })],
  }).finalState;
};

const stateProjection = (state: ModelState) => ({
  log: {
    acknowledgedTail: state.log.acknowledgedTail,
    ops: state.log.ops.map((operation) => ({ ...operation })),
  },
  manifest: { ...state.manifest },
  snapshots: [...state.snapshots.entries()].map(([key, snapshot]) => [
    key,
    {
      key: snapshot.key,
      maxSeq: snapshot.maxSeq,
      rows: snapshot.rows.map(([docId, value]) => [docId, value] as const),
    },
  ]),
});

describe("orphan and reclamation bounds", () => {
  test("P6a_sameGenerationSameKContentionAddsNoDistinctCasOrphan", () => {
    const result = runSchedule({
      initial: stateWithTail(20),
      observers: [
        action({ observerId: 1, readsAtGeneration: 0, observedTail: 20, k: 5 }),
        action({ observerId: 2, readsAtGeneration: 0, observedTail: 20, k: 5 }),
      ],
    });
    const [winner, loser] = result.attempts.map(({ emittedKey }) => emittedKey);
    const expected = expectedClassification(result);

    expect(result.attempts.map(({ outcome }) => outcome)).toEqual(["written", "cas_lost"]);
    expect(winner).not.toBeNull();
    expect(loser).toBe(winner);
    expect(sortedKeys(result.finalState)).toEqual([winner]);
    expect(result.finalState.snapshots.size).toBe(1);
    expect(expected.neverReferenced).toEqual([]);
    expect(result.neverReferencedSnapshots).toEqual(expected.neverReferenced);
    expect(result.supersededSnapshots).toEqual(expected.superseded);
    expect(result.reclaimableSnapshots).toEqual(expected.reclaimable);
  });

  test("P6b_successfulFoldCanIncreaseRatherThanReduceReclaimableObjects", () => {
    const initial = stateWithTail(10);
    const first = runSchedule({
      initial,
      observers: [action({ observerId: 1, observedTail: 10, k: 5 })],
    });
    const second = runSchedule({
      initial: first.finalState,
      observers: [action({ observerId: 2, observedTail: 10, k: 5 })],
    });
    const oldHead = first.finalState.manifest.snapshotKey;
    const newHead = second.finalState.manifest.snapshotKey;
    const expected = expectedClassification(second);

    expect(first.reclaimableSnapshots).toEqual([]);
    expect(second.attempts.map(({ outcome }) => outcome)).toEqual(["written"]);
    expect(oldHead).not.toBeNull();
    expect(newHead).not.toBeNull();
    expect(newHead).not.toBe(oldHead);
    expect(sortedKeys(second.finalState)).toEqual([oldHead!, newHead!].toSorted());
    expect(expected.neverReferenced).toEqual([]);
    expect(expected.superseded).toEqual([oldHead]);
    expect(second.neverReferencedSnapshots).toEqual(expected.neverReferenced);
    expect(second.supersededSnapshots).toEqual(expected.superseded);
    expect(second.reclaimableSnapshots).toEqual(expected.reclaimable);
    expect(second.reclaimableSnapshots.length).toBeGreaterThan(first.reclaimableSnapshots.length);
  });

  test("P6c_mixedKContentionHasAReachableDistinctCasOrphan", () => {
    const result = runSchedule({
      initial: stateWithTail(20),
      observers: [
        action({ observerId: 1, readsAtGeneration: 0, observedTail: 20, k: 4 }),
        action({ observerId: 2, readsAtGeneration: 0, observedTail: 20, k: 6 }),
      ],
    });
    const [winner, loser] = result.attempts.map(({ emittedKey }) => emittedKey);
    const expected = expectedClassification(result);

    expect(result.attempts.map(({ outcome }) => outcome)).toEqual(["written", "cas_lost"]);
    expect(winner).not.toBeNull();
    expect(loser).not.toBeNull();
    expect(loser).not.toBe(winner);
    expect(sortedKeys(result.finalState)).toEqual([winner!, loser!].toSorted());
    expect(expected.neverReferenced).toEqual([loser]);
    expect(expected.superseded).toEqual([]);
    expect(result.neverReferencedSnapshots).toEqual(expected.neverReferenced);
    expect(result.supersededSnapshots).toEqual(expected.superseded);
    expect(result.reclaimableSnapshots).toEqual(expected.reclaimable);
  });

  test("P6d_crashAfterPutHasAReachableNeverReferencedSnapshot", () => {
    const result = runSchedule({
      initial: stateWithTail(20),
      observers: [action({ observerId: 1, observedTail: 20, k: 5, crashAt: "after_snapshot_put" })],
    });
    const [crashedKey] = result.attempts.map(({ emittedKey }) => emittedKey);
    const expected = expectedClassification(result);

    expect(result.attempts.map(({ outcome }) => outcome)).toEqual(["crashed"]);
    expect(crashedKey).not.toBeNull();
    expect(sortedKeys(result.finalState)).toEqual([crashedKey]);
    expect(expected.neverReferenced).toEqual([crashedKey]);
    expect(expected.superseded).toEqual([]);
    expect(result.neverReferencedSnapshots).toEqual(expected.neverReferenced);
    expect(result.supersededSnapshots).toEqual(expected.superseded);
    expect(result.reclaimableSnapshots).toEqual(expected.reclaimable);
  });

  test("P6e_reclamationRemovesAllAndOnlyNonCurrentSnapshots", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 32 }), (tail) => {
        for (const scenario of reclamationScenarios) {
          const state = reclamationState(scenario, tail);
          const before = stateProjection(state);
          const beforeRows = [...rowsAtManifest(state).entries()].toSorted();
          const expectedKeys =
            state.manifest.snapshotKey === null ? [] : [state.manifest.snapshotKey];
          const reclaimed = reclaimUnreferenced(state);
          const freshClassification = runSchedule({ initial: reclaimed, observers: [] });

          expect(sortedKeys(reclaimed)).toEqual(expectedKeys);
          expect([...rowsAtManifest(reclaimed).entries()].toSorted()).toEqual(beforeRows);
          expect(reclaimed.log).toBe(state.log);
          expect(reclaimed.manifest).toBe(state.manifest);
          expect(reclaimed.snapshots).not.toBe(state.snapshots);
          expect(stateProjection(state)).toEqual(before);
          expect(freshClassification.neverReferencedSnapshots).toEqual([]);
          expect(freshClassification.supersededSnapshots).toEqual([]);
          expect(freshClassification.reclaimableSnapshots).toEqual([]);
        }
      }),
    );
  });

  test("reclamation rejects a missing current snapshot instead of fabricating it", () => {
    const state = stateWithTail(2);
    const missingCurrent: ModelState = {
      ...state,
      manifest: { ...state.manifest, snapshotKey: "missing-current-snapshot" },
    };

    expect(() => reclaimUnreferenced(missingCurrent)).toThrow(
      "missing snapshot object: missing-current-snapshot",
    );
  });
});
