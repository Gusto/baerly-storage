import { fc } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";

import {
  alignedManifestBoundary,
  alignedManifestTarget,
  alignedObservedBoundary,
  liveGreedyBoundary,
  prepareFold,
  type BoundaryInput,
  type FoldBudget,
} from "./boundary.ts";
import { billableClassA, foldCost } from "./cost.ts";
import {
  applySnapshot,
  emptyState,
  makeSnapshot,
  replayAcknowledged,
  type ModelLog,
  type ModelManifest,
  type ModelOp,
  type ModelState,
} from "./model.ts";

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

const stateAt = (
  floor: number,
  acknowledgedTail: number,
  physicalTail = acknowledgedTail,
): ModelState => {
  const log: ModelLog = {
    ops: operations(physicalTail),
    acknowledgedTail,
  };
  if (floor === 0) {
    return emptyState(log);
  }

  return applySnapshot(emptyState(log), makeSnapshot(replayAcknowledged(log, floor), floor));
};

const inputAt = (
  floor: number,
  observedTail: number,
  budget: FoldBudget,
  k: number,
): BoundaryInput => ({
  manifest: stateAt(floor, Math.max(floor, observedTail)).manifest,
  observedTail,
  budget,
  k,
});

describe("fold boundary hypotheses", () => {
  test("P1a_manifestTargetIsIndependentOfObservationAndBudget", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000 }),
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: 0, max: 2_000 }),
        fc.integer({ min: 0, max: 500 }),
        (floor, k, observedTail, maxEntriesPerRun) => {
          const want = (Math.floor(floor / k) + 1) * k;

          expect(alignedManifestTarget(floor, k)).toBe(want);
          expect(
            alignedManifestTarget(
              inputAt(floor, observedTail, roomyBudget({ maxEntriesPerRun }), k).manifest
                .logSeqStart,
              k,
            ),
          ).toBe(want);
        },
      ),
    );
  });

  test("P1b_liveAndObservedAlignedTargetsDependOnObservedAvailability", () => {
    const budget = roomyBudget({ maxEntriesPerRun: 20 });

    expect(liveGreedyBoundary(inputAt(0, 13, budget, 5))).toBe(13);
    expect(liveGreedyBoundary(inputAt(0, 18, budget, 5))).toBe(18);
    expect(alignedObservedBoundary(inputAt(0, 13, budget, 5))).toBe(10);
    expect(alignedObservedBoundary(inputAt(0, 18, budget, 5))).toBe(15);
  });

  test("P2a_fewerThanNextKEntriesProducesNoObjectOrProgress", () => {
    const state = stateAt(1, 4);
    const result = prepareFold({
      state,
      observedTail: 4,
      probeFloor: 4,
      budget: roomyBudget(),
      k: 5,
      algorithm: "aligned-manifest",
    });

    expect(result).toEqual({
      outcome: "below_min_threshold",
      baseGeneration: 1,
      foldEnd: null,
      readSet: [],
      snapshot: null,
      cost: {
        currentGets: 1,
        probeGets: 1,
        snapshotGets: 0,
        logGets: 0,
        snapshotPuts: 0,
        currentPuts: 0,
        total: 2,
      },
    });
  });

  test("P2b_retryAfterAvailabilityUsesTheSameManifestTarget", () => {
    const state = stateAt(1, 5);
    const before = alignedManifestTarget(state.manifest.logSeqStart, 5);
    const unavailable = alignedManifestBoundary({
      manifest: state.manifest,
      observedTail: 4,
      budget: roomyBudget(),
      k: 5,
    });
    const retry = prepareFold({
      state,
      observedTail: 5,
      probeFloor: 5,
      budget: roomyBudget(),
      k: 5,
      algorithm: "aligned-manifest",
    });

    expect(unavailable).toBeNull();
    expect(before).toBe(5);
    expect(retry.foldEnd).toBe(before);
    expect(retry.outcome).toBe("prepared");
  });

  test("P4a_firstTargetAfterKChangeIsStrictlyMonotoneAndNewKAligned", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000 }),
        fc.integer({ min: 1, max: 128 }),
        (floor, newK) => {
          const target = alignedManifestTarget(floor, newK);

          expect(target).toBeGreaterThan(floor);
          expect(target % newK).toBe(0);
        },
      ),
    );
  });

  test("P7a_everyPreparedManifestBoundaryStrictlyAdvancesAndIsAligned", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 20 }), fc.integer({ min: 1, max: 12 }), (floor, k) => {
        const target = (Math.floor(floor / k) + 1) * k;
        const result = prepareFold({
          state: stateAt(floor, target),
          observedTail: target,
          probeFloor: target,
          budget: roomyBudget(),
          k,
          algorithm: "aligned-manifest",
        });

        expect(result.outcome).toBe("prepared");
        expect(result.foldEnd).toBeGreaterThan(floor);
        expect(result.foldEnd! % k).toBe(0);
      }),
    );
  });

  test("P7b_everyPreparedReadSetIsTheExactContiguousInterval", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 0, max: 20 }),
        (floor, k, unacknowledged) => {
          const target = (Math.floor(floor / k) + 1) * k;
          const result = prepareFold({
            state: stateAt(floor, target, target + unacknowledged),
            observedTail: target + unacknowledged,
            probeFloor: target,
            budget: roomyBudget(),
            k,
            algorithm: "aligned-manifest",
          });

          expect(result.outcome).toBe("prepared");
          expect(result.readSet).toEqual(
            Array.from({ length: target - floor }, (_, index) => floor + index),
          );
          expect(result.foldEnd).toBeLessThanOrEqual(target);
        },
      ),
    );
  });

  test.each([0, -1, 1.5])("pure boundary APIs reject invalid K=%s", (k) => {
    const input = inputAt(0, 10, roomyBudget(), k);

    expect(() => liveGreedyBoundary(input)).toThrow(RangeError);
    expect(() => alignedObservedBoundary(input)).toThrow(RangeError);
    expect(() => alignedManifestBoundary(input)).toThrow(RangeError);
    expect(() => alignedManifestTarget(0, k)).toThrow(RangeError);
  });
});

describe("exact compact cost", () => {
  test("P8a_tightKnownTailCostIsNPlusFiveWithSnapshotAndNPlusFourWithout", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000 }), (logEntriesRead) => {
        const withSnapshot: ModelManifest = {
          generation: 2,
          logSeqStart: 10,
          snapshotKey: "prior",
          tailHint: 10 + logEntriesRead,
        };
        const withoutSnapshot: ModelManifest = {
          ...withSnapshot,
          generation: 0,
          logSeqStart: 0,
          snapshotKey: null,
        };
        const common = {
          probeFloor: 10 + logEntriesRead,
          observedTail: 10 + logEntriesRead,
          logEntriesRead,
          reachedSnapshotPut: true,
          reachedCurrentCas: true,
        };

        expect(foldCost({ ...common, manifest: withSnapshot }).total).toBe(logEntriesRead + 5);
        expect(foldCost({ ...common, manifest: withoutSnapshot }).total).toBe(logEntriesRead + 4);
      }),
    );
  });

  test("P8b_deferredAttemptStillPaysSnapshotAndLogReadsButNoPuts", () => {
    const result = prepareFold({
      state: stateAt(1, 3),
      observedTail: 3,
      probeFloor: 3,
      budget: roomyBudget({ ceilingEntries: 1 }),
      k: 3,
      algorithm: "aligned-manifest",
    });

    expect(result.outcome).toBe("deferred");
    expect(result.readSet).toEqual([1, 2]);
    expect(result.cost).toEqual({
      currentGets: 1,
      probeGets: 1,
      snapshotGets: 1,
      logGets: 2,
      snapshotPuts: 0,
      currentPuts: 0,
      total: 5,
    });
  });

  test("byte ceiling defers after replay without charging writes", () => {
    const result = prepareFold({
      state: stateAt(0, 1),
      observedTail: 1,
      probeFloor: 1,
      budget: roomyBudget({ ceilingBytes: 1 }),
      k: 1,
      algorithm: "aligned-manifest",
    });

    expect(result.outcome).toBe("deferred");
    expect(result.readSet).toEqual([0]);
    expect(result.cost.snapshotPuts).toBe(0);
    expect(result.cost.currentPuts).toBe(0);
  });

  test("P8c_kAboveMaxEntriesCannotPrepare", () => {
    const result = prepareFold({
      state: stateAt(0, 10),
      observedTail: 10,
      probeFloor: 10,
      budget: roomyBudget({ maxEntriesPerRun: 4 }),
      k: 5,
      algorithm: "aligned-manifest",
    });

    expect(result.outcome).toBe("below_min_threshold");
    expect(result.foldEnd).toBeNull();
    expect(result.readSet).toEqual([]);
    expect(result.snapshot).toBeNull();
  });

  test("P8d_zeroMaxEntriesIsAnExplicitZeroProgressCounterexample", () => {
    const input = inputAt(7, 20, roomyBudget({ maxEntriesPerRun: 0 }), 5);

    expect(liveGreedyBoundary(input)).toBeNull();
    expect(alignedObservedBoundary(input)).toBeNull();
    expect(alignedManifestBoundary(input)).toBeNull();

    const result = prepareFold({
      state: stateAt(7, 20),
      observedTail: 20,
      probeFloor: 20,
      budget: input.budget,
      k: 5,
      algorithm: "live-greedy",
    });
    expect(result.outcome).not.toBe("prepared");
    expect(result.foldEnd).toBeNull();
  });

  test("billableClassA counts only snapshot and current writes", () => {
    const cost = foldCost({
      manifest: stateAt(0, 2).manifest,
      probeFloor: 2,
      observedTail: 2,
      logEntriesRead: 2,
      reachedSnapshotPut: true,
      reachedCurrentCas: true,
    });

    expect(billableClassA(cost)).toBe(2);
  });
});
