import { fc } from "@fast-check/vitest";

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

export const arbReachableState: fc.Arbitrary<ModelState> = arbModelLog.chain((log) =>
  fc
    .integer({ min: 0, max: log.acknowledgedTail })
    .map((boundary) =>
      applySnapshot(emptyState(log), makeSnapshot(replayAcknowledged(log, boundary), boundary)),
    ),
);
