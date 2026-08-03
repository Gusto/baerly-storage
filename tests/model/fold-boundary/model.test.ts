import { createHash } from "node:crypto";

import { fc } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";

import {
  applySnapshot,
  emptyState,
  foldRange,
  makeSnapshot,
  replayAcknowledged,
  rowsAtManifest,
  type ModelLog,
  type ModelRows,
} from "./model.ts";
import { arbModelLog, arbPositiveK } from "./arbitraries.ts";

const sortedRows = (rows: ModelRows): readonly (readonly [string, number])[] =>
  [...rows.entries()].toSorted(([left], [right]) => left.localeCompare(right));

const oracleRowsAt = (log: ModelLog, to: number): ModelRows => {
  const rows = new Map<string, number>();
  const acknowledgedEnd = Math.max(0, Math.min(to, log.acknowledgedTail));

  for (const operation of log.ops.slice(0, acknowledgedEnd)) {
    if (operation.kind === "D") {
      rows.delete(operation.docId);
    } else {
      rows.set(operation.docId, operation.value);
    }
  }

  return rows;
};

describe("fold-boundary reference model", () => {
  test("P7c_contiguousIncrementalFoldEqualsReferenceReplay", () => {
    fc.assert(
      fc.property(arbModelLog, arbPositiveK, (log, requestedBoundary) => {
        const boundary = Math.min(requestedBoundary, log.acknowledgedTail);
        const base = oracleRowsAt(log, boundary);

        expect(sortedRows(foldRange(base, log, boundary, log.acknowledgedTail))).toEqual(
          sortedRows(oracleRowsAt(log, log.acknowledgedTail)),
        );
      }),
    );
  });

  test("P7d_publishedSnapshotCanPreserveEveryAcknowledgedPrefix", () => {
    fc.assert(
      fc.property(arbModelLog, arbPositiveK, (log, requestedBoundary) => {
        const boundary = Math.min(requestedBoundary, log.acknowledgedTail);
        const snapshot = makeSnapshot(oracleRowsAt(log, boundary), boundary);
        const published = applySnapshot(emptyState(log), snapshot);

        expect(sortedRows(rowsAtManifest(published))).toEqual(
          sortedRows(oracleRowsAt(log, log.acknowledgedTail)),
        );
      }),
    );
  });

  test("model_neverReplaysPastAcknowledgedTail", () => {
    const log: ModelLog = {
      ops: [
        { kind: "I", docId: "alpha", value: 1 },
        { kind: "U", docId: "alpha", value: 2 },
        { kind: "I", docId: "unacknowledged", value: 3 },
      ],
      acknowledgedTail: 2,
    };

    expect(sortedRows(replayAcknowledged(log))).toEqual([["alpha", 2]]);
    expect(sortedRows(foldRange(new Map(), log, 0, log.ops.length))).toEqual([["alpha", 2]]);
  });

  test("model_snapshotIdentityIsCanonicalAndContentAddressed", () => {
    const first = makeSnapshot(
      new Map([
        ["bravo", 2],
        ["alpha", 1],
      ]),
      4,
    );
    const reordered = makeSnapshot(
      new Map([
        ["alpha", 1],
        ["bravo", 2],
      ]),
      4,
    );
    const changedBoundary = makeSnapshot(new Map(first.rows), 5);
    const canonicalBytes = JSON.stringify({
      maxSeq: 4,
      rows: [
        ["alpha", 1],
        ["bravo", 2],
      ],
    });
    const expectedKey = createHash("sha256").update(canonicalBytes).digest("hex");

    expect(first.rows).toEqual([
      ["alpha", 1],
      ["bravo", 2],
    ]);
    expect(first.key).toBe(expectedKey);
    expect(reordered.key).toBe(first.key);
    expect(changedBoundary.key).not.toBe(first.key);
  });

  test("model_logAndStateTransitionsDoNotMutateInputs", () => {
    const log: ModelLog = {
      ops: [
        { kind: "I", docId: "alpha", value: 1 },
        { kind: "D", docId: "alpha" },
      ],
      acknowledgedTail: 2,
    };
    const base = new Map<string, number>([["before", 0]]);
    const state = emptyState(log);
    const snapshotRows = new Map<string, number>([["bravo", 2]]);
    const snapshot = makeSnapshot(snapshotRows, 1);
    const originalState = {
      manifest: state.manifest,
      snapshots: [...state.snapshots.entries()],
    };

    foldRange(base, log, 0, 1);
    replayAcknowledged(log);
    applySnapshot(state, snapshot);

    expect(sortedRows(base)).toEqual([["before", 0]]);
    expect(log).toEqual({
      ops: [
        { kind: "I", docId: "alpha", value: 1 },
        { kind: "D", docId: "alpha" },
      ],
      acknowledgedTail: 2,
    });
    expect(sortedRows(snapshotRows)).toEqual([["bravo", 2]]);
    expect(state.manifest).toBe(originalState.manifest);
    expect([...state.snapshots.entries()]).toEqual(originalState.snapshots);
  });
});
