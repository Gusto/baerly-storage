import { fc } from "@fast-check/vitest";

import type { BoundaryAlgorithm, FoldBudget } from "./boundary.ts";
import type { CrashPoint, ObserverAction } from "./schedule.ts";

import {
  applySnapshot,
  emptyState,
  makeSnapshot,
  replayAcknowledged,
  type ModelLog,
  type ModelOp,
  type ModelState,
} from "./model.ts";

const arbDocId = fc.constantFrom("alpha", "bravo", "charlie", "delta");
const arbValue = fc.integer({ min: -100, max: 100 });

export const arbModelOp: fc.Arbitrary<ModelOp> = fc.oneof(
  fc
    .tuple(fc.constantFrom<"I" | "U">("I", "U"), arbDocId, arbValue)
    .map(([kind, docId, value]) => ({ kind, docId, value })),
  arbDocId.map((docId) => ({ kind: "D" as const, docId })),
);

export const arbModelLog: fc.Arbitrary<ModelLog> = fc
  .array(arbModelOp, { maxLength: 32 })
  .chain((ops) =>
    fc.integer({ min: 0, max: ops.length }).map((acknowledgedTail) => ({
      ops,
      acknowledgedTail,
    })),
  );

export const arbPositiveK = fc.integer({ min: 1, max: 64 });

export const arbCrashPoint: fc.Arbitrary<CrashPoint> = fc.constantFrom(
  "none",
  "after_manifest_read",
  "after_snapshot_put",
);

export const arbKChange: fc.Arbitrary<{
  readonly fromK: number;
  readonly toK: number;
}> = fc
  .tuple(arbPositiveK, arbPositiveK)
  .filter(([fromK, toK]) => fromK !== toK)
  .map(([fromK, toK]) => ({ fromK, toK }));

export const arbObserverAction = (opts: {
  readonly maxObservedTail: number;
  readonly maxGeneration: number;
  readonly budget: FoldBudget;
  readonly algorithm?: BoundaryAlgorithm;
}): fc.Arbitrary<ObserverAction> =>
  fc.record({
    observerId: fc.nat({ max: 7 }),
    readsAtGeneration: fc.oneof(
      fc.integer({ min: 0, max: opts.maxGeneration }),
      fc.constant(Number.MAX_SAFE_INTEGER),
    ),
    observedTail: fc.integer({ min: 0, max: opts.maxObservedTail }),
    k: arbPositiveK,
    budget: fc.constant(opts.budget),
    algorithm:
      opts.algorithm === undefined
        ? fc.constantFrom<BoundaryAlgorithm>("live-greedy", "aligned-observed", "aligned-manifest")
        : fc.constant(opts.algorithm),
    crashAt: arbCrashPoint,
  });

export const arbReachableState: fc.Arbitrary<ModelState> = arbModelLog.chain((log) =>
  fc
    .integer({ min: 0, max: log.acknowledgedTail })
    .map((boundary) =>
      applySnapshot(emptyState(log), makeSnapshot(replayAcknowledged(log, boundary), boundary)),
    ),
);
