import { WRITE_TICK_FOLD_ENTRIES_PER_PASS } from "@baerly/protocol";
import { fc } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";

import { CF_FREE_BUDGET, type FoldBudget } from "./boundary.ts";
import { emptyState, type ModelLog, type ModelOp, type ModelState } from "./model.ts";
import { drainToQuiescence, runSchedule, type ObserverAction } from "./schedule.ts";

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

const stateWithTail = (tail: number, tailHint = tail): ModelState => {
  const state = emptyState({ ops: operations(tail), acknowledgedTail: tail });
  const manifest = { ...state.manifest, tailHint };
  return { ...state, manifest, manifestHistory: [{ ...manifest }] };
};

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

const localReplay = (log: ModelLog, to: number): readonly (readonly [string, number])[] => {
  const rows = new Map<string, number>();
  const end = Math.min(to, log.acknowledgedTail);

  for (let sequence = 0; sequence < end; sequence += 1) {
    const operation = log.ops[sequence]!;
    if (operation.kind === "D") {
      rows.delete(operation.docId);
    } else {
      rows.set(operation.docId, operation.value);
    }
  }

  return [...rows.entries()].toSorted(([left], [right]) => left.localeCompare(right));
};

describe("fold crash and observer schedules", () => {
  test("P3a_crashBeforeCasLeavesManifestUnchangedAndRetryUsesSameTarget", () => {
    const initial = stateWithTail(20);
    const result = runSchedule({
      initial,
      observers: [
        action({ observerId: 1, crashAt: "after_manifest_read" }),
        action({ observerId: 2, observedTail: 200, crashAt: "after_snapshot_put" }),
        action({ observerId: 2, observedTail: 200 }),
      ],
    });

    expect(result.attempts.map(({ outcome, foldEnd }) => ({ outcome, foldEnd }))).toEqual([
      { outcome: "crashed", foldEnd: null },
      { outcome: "crashed", foldEnd: 5 },
      { outcome: "written", foldEnd: 5 },
    ]);
    expect(result.attempts[0]!.cost).toEqual({
      currentGets: 1,
      probeGets: 0,
      snapshotGets: 0,
      logGets: 0,
      snapshotPuts: 0,
      currentPuts: 0,
      total: 1,
    });
    expect(result.attempts[1]!.cost).toEqual({
      currentGets: 1,
      probeGets: 181,
      snapshotGets: 0,
      logGets: 5,
      snapshotPuts: 1,
      currentPuts: 0,
      total: 188,
    });
    expect(result.attempts[2]!.cost).toEqual({
      currentGets: 1,
      probeGets: 181,
      snapshotGets: 0,
      logGets: 5,
      snapshotPuts: 1,
      currentPuts: 1,
      total: 189,
    });
    expect(result.attempts[1]!.emittedKey).toBe(result.attempts[2]!.emittedKey);
    expect(
      result.generations.map(({ generation, logSeqStart }) => [generation, logSeqStart]),
    ).toEqual([
      [0, 0],
      [1, 5],
    ]);
    expect(result.finalState.snapshots.size).toBe(1);
    expect(result.neverReferencedSnapshots).toEqual([]);
    expect(() => runSchedule({ initial, observers: [action({ readsAtGeneration: 1 })] })).toThrow(
      RangeError,
    );
  });

  test("P3b_laggingObserverBoundarySequenceIsAPrefixOfFullyInformedSequence", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 8 }),
        (k, lagPasses) => {
          const tail = k * 10;
          const allPasses = 10;
          const initial = stateWithTail(tail);
          const fullyInformed = runSchedule({
            initial,
            observers: Array.from({ length: allPasses }, (_, index) =>
              action({ observerId: index, observedTail: tail, k }),
            ),
          });
          const lagging = runSchedule({
            initial,
            observers: Array.from({ length: lagPasses }, (_, index) =>
              action({ observerId: index, observedTail: (index + 1) * k, k }),
            ),
          });
          const fullBoundaries = fullyInformed.attempts
            .filter(({ outcome }) => outcome === "written")
            .map(({ foldEnd }) => foldEnd);
          const laggingBoundaries = lagging.attempts
            .filter(({ outcome }) => outcome === "written")
            .map(({ foldEnd }) => foldEnd);

          expect(laggingBoundaries).toEqual(fullBoundaries.slice(0, laggingBoundaries.length));
        },
      ),
    );
  });

  test("P4b_mixedKObserversCanPrepareDifferentObjectsFromOneGeneration", () => {
    const result = runSchedule({
      initial: stateWithTail(20),
      observers: [
        action({ observerId: 1, k: 4, crashAt: "after_snapshot_put" }),
        action({ observerId: 2, k: 6, crashAt: "after_snapshot_put" }),
      ],
    });

    expect(result.attempts.map(({ baseGeneration, foldEnd }) => [baseGeneration, foldEnd])).toEqual(
      [
        [0, 4],
        [0, 6],
      ],
    );
    expect(new Set(result.attempts.map(({ emittedKey }) => emittedKey)).size).toBe(2);
    expect(result.neverReferencedSnapshots).toHaveLength(2);
  });

  test("P5a_observersOnOppositeSidesOfOneBoundaryEmitAtMostOneObjectForOneK", () => {
    const result = runSchedule({
      initial: stateWithTail(20),
      observers: [
        action({ observerId: 1, readsAtGeneration: 0, observedTail: 5 }),
        action({ observerId: 2, readsAtGeneration: 0, observedTail: 9 }),
      ],
    });

    expect(result.attempts.map(({ foldEnd }) => foldEnd)).toEqual([5, 5]);
    expect(result.attempts.map(({ outcome }) => outcome)).toEqual(["written", "cas_lost"]);
    expect(result.attempts[1]!.cost).toEqual({
      currentGets: 1,
      probeGets: 1,
      snapshotGets: 0,
      logGets: 5,
      snapshotPuts: 1,
      currentPuts: 1,
      total: 9,
    });
    expect(result.attempts[0]!.emittedKey).toBe(result.attempts[1]!.emittedKey);
    expect(result.finalState.snapshots.size).toBe(1);
  });

  test("P5b_sameManifestSameKAlwaysProducesTheSameObjectKey", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 30 }),
        fc.integer({ min: 0, max: 30 }),
        (k, leftExtra, rightExtra) => {
          const tail = k + Math.max(leftExtra, rightExtra);
          const result = runSchedule({
            initial: stateWithTail(tail),
            observers: [
              action({
                observerId: 1,
                observedTail: k + leftExtra,
                k,
                crashAt: "after_snapshot_put",
              }),
              action({
                observerId: 2,
                observedTail: k + rightExtra,
                k,
                crashAt: "after_snapshot_put",
              }),
            ],
          });

          expect(result.attempts[0]!.emittedKey).toBe(result.attempts[1]!.emittedKey);
          expect(result.finalState.snapshots.size).toBe(1);
        },
      ),
    );
  });
});

describe("fold publication and progress bounds", () => {
  test("P7e_everyPublishedSnapshotMatchesReferenceReplayThroughItsFloor", () => {
    const log: ModelLog = {
      ops: [
        { kind: "I", docId: "alpha", value: 1 },
        { kind: "I", docId: "bravo", value: 2 },
        { kind: "U", docId: "alpha", value: 3 },
        { kind: "D", docId: "bravo" },
        { kind: "I", docId: "charlie", value: 5 },
        { kind: "U", docId: "alpha", value: 6 },
        { kind: "I", docId: "delta", value: 7 },
        { kind: "D", docId: "alpha" },
      ],
      acknowledgedTail: 8,
    };
    const result = runSchedule({
      initial: emptyState(log),
      observers: [
        action({ k: 3, observedTail: 8 }),
        action({ k: 4, observedTail: 8 }),
        action({ k: 3, observedTail: 8 }),
      ],
    });

    expect(result.attempts.map(({ outcome }) => outcome)).toEqual([
      "written",
      "written",
      "written",
    ]);
    for (const manifest of result.generations.slice(1)) {
      const snapshot = result.finalState.snapshots.get(manifest.snapshotKey!);
      expect(snapshot?.maxSeq).toBe(manifest.logSeqStart);
      expect(snapshot?.rows).toEqual(localReplay(log, manifest.logSeqStart));
    }
    expect(result.supersededSnapshots).toHaveLength(2);
    expect(result.reclaimableSnapshots).toEqual(result.supersededSnapshots);
  });

  test("P8e_manifestAlignedProgressFitsCfFreeWithTightKnownTailForKAtMostTwenty", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: WRITE_TICK_FOLD_ENTRIES_PER_PASS }),
        fc.integer({ min: 3, max: 8 }),
        (k, passes) => {
          const tail = CF_FREE_BUDGET.minEntriesToCompact + k * passes;
          const result = drainToQuiescence({
            initial: stateWithTail(tail),
            budget: CF_FREE_BUDGET,
            k,
            algorithm: "aligned-manifest",
            maxPasses: passes + 2,
          });
          expect(result.attempts).toHaveLength(passes + 2);
          expect(result.attempts.slice(0, -1).map(({ outcome }) => outcome)).toEqual(
            Array.from({ length: passes + 1 }, () => "written"),
          );
          expect(result.attempts.at(-1)?.outcome).toBe("below_min_threshold");
          expect(
            result.attempts
              .slice(0, -1)
              .every(({ cost }) => cost.total <= CF_FREE_BUDGET.subrequestLimit),
          ).toBe(true);
          expect(result.finalState.manifest.logSeqStart).toBe(k * (passes + 1));
        },
      ),
    );
  });

  test("P8f_scheduledStaleProbeCanExceedThePerPassSubrequestLimit", () => {
    const result = runSchedule({
      initial: stateWithTail(100, 0),
      observers: [action({ observedTail: 100, k: 20, budget: CF_FREE_BUDGET })],
    });

    expect(result.attempts[0]!.outcome).toBe("written");
    expect(result.attempts[0]!.cost.probeGets).toBe(101);
    expect(result.attempts[0]!.cost.total).toBeGreaterThan(CF_FREE_BUDGET.subrequestLimit);
  });

  test("scheduler_advancesTailHintAndAmortizesAStaleProbeAcrossSuccessfulPasses", () => {
    const first = runSchedule({
      initial: stateWithTail(100, 0),
      observers: [action({ observedTail: 100, k: 20 })],
    });
    const second = runSchedule({
      initial: first.finalState,
      observers: [action({ observedTail: 100, k: 20 })],
    });

    expect(first.attempts[0]!.outcome).toBe("written");
    expect(first.attempts[0]!.cost.probeGets).toBe(101);
    expect(first.finalState.manifest.tailHint).toBe(100);
    expect(second.attempts[0]!.outcome).toBe("written");
    expect(second.attempts[0]!.cost.probeGets).toBe(1);
    expect(second.finalState.manifest.tailHint).toBe(100);
  });

  test("scheduler_neverProbesBelowAPublishedLogFloor", () => {
    const published = runSchedule({
      initial: stateWithTail(20, 0),
      observers: [action({ observedTail: 5, k: 5 })],
    }).finalState;
    const staleManifest = { ...published.manifest, tailHint: 0 };
    const staleHintBelowFloor: ModelState = {
      ...published,
      manifest: staleManifest,
      manifestHistory: [...published.manifestHistory.slice(0, -1), { ...staleManifest }],
    };
    const result = runSchedule({
      initial: staleHintBelowFloor,
      observers: [action({ observedTail: 5, k: 5 })],
    });

    expect(staleHintBelowFloor.manifest.logSeqStart).toBe(5);
    expect(result.attempts[0]!.outcome).toBe("below_min_threshold");
    expect(result.attempts[0]!.cost.probeGets).toBe(1);
  });
});
