import { createHash } from "node:crypto";

export type DocId = string;
export type ModelOp =
  | { readonly kind: "I" | "U"; readonly docId: DocId; readonly value: number }
  | { readonly kind: "D"; readonly docId: DocId };
export interface ModelLog {
  readonly ops: readonly ModelOp[];
  readonly acknowledgedTail: number;
}
export type ModelRows = ReadonlyMap<DocId, number>;
export interface SnapshotObject {
  readonly key: string;
  readonly maxSeq: number;
  readonly rows: readonly (readonly [DocId, number])[];
}
export interface ModelManifest {
  readonly generation: number;
  readonly logSeqStart: number;
  readonly snapshotKey: string | null;
  readonly tailHint: number;
}
export interface ModelState {
  readonly log: ModelLog;
  readonly manifest: ModelManifest;
  readonly manifestHistory: readonly ModelManifest[];
  readonly snapshots: ReadonlyMap<string, SnapshotObject>;
}

const compareDocIds = (left: DocId, right: DocId): number => {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
};

const copySnapshot = (snapshot: SnapshotObject): SnapshotObject => ({
  key: snapshot.key,
  maxSeq: snapshot.maxSeq,
  rows: snapshot.rows.map(([docId, value]) => [docId, value] as const),
});

const copyManifest = (manifest: ModelManifest): ModelManifest => ({ ...manifest });

const boundedSequence = (log: ModelLog, sequence: number): number =>
  Math.max(0, Math.min(sequence, log.acknowledgedTail));

export const modelTail = (log: ModelLog): number => log.ops.length;

export const emptyState = (log: ModelLog): ModelState => {
  const manifest: ModelManifest = {
    generation: 0,
    logSeqStart: 0,
    snapshotKey: null,
    tailHint: modelTail(log),
  };
  return {
    log,
    manifest,
    manifestHistory: [copyManifest(manifest)],
    snapshots: new Map(),
  };
};

export const foldRange = (base: ModelRows, log: ModelLog, from: number, to: number): ModelRows => {
  const rows = new Map(base);
  const start = boundedSequence(log, from);
  const end = boundedSequence(log, to);

  for (const operation of log.ops.slice(start, end)) {
    if (operation.kind === "D") {
      rows.delete(operation.docId);
    } else {
      rows.set(operation.docId, operation.value);
    }
  }

  return rows;
};

export const replayAcknowledged = (log: ModelLog, to = log.acknowledgedTail): ModelRows =>
  foldRange(new Map(), log, 0, to);

export const makeSnapshot = (rows: ModelRows, maxSeq: number): SnapshotObject => {
  const canonicalRows = [...rows.entries()]
    .toSorted(([left], [right]) => compareDocIds(left, right))
    .map(([docId, value]) => [docId, value] as const);
  const canonicalBytes = JSON.stringify({ maxSeq, rows: canonicalRows });

  return {
    key: createHash("sha256").update(canonicalBytes).digest("hex"),
    maxSeq,
    rows: canonicalRows,
  };
};

export const applySnapshot = (state: ModelState, snapshot: SnapshotObject): ModelState => {
  const snapshots = new Map(state.snapshots);
  snapshots.set(snapshot.key, copySnapshot(snapshot));
  const manifest: ModelManifest = {
    ...state.manifest,
    generation: state.manifest.generation + 1,
    logSeqStart: snapshot.maxSeq,
    snapshotKey: snapshot.key,
  };

  return {
    log: state.log,
    manifest,
    manifestHistory: [...state.manifestHistory, copyManifest(manifest)],
    snapshots,
  };
};

export const rowsAtManifest = (
  state: ModelState,
  manifest: ModelManifest = state.manifest,
): ModelRows => {
  const base =
    manifest.snapshotKey === null
      ? new Map<DocId, number>()
      : snapshotRows(state, manifest.snapshotKey);

  return foldRange(base, state.log, manifest.logSeqStart, state.log.acknowledgedTail);
};

const snapshotRows = (state: ModelState, snapshotKey: string): ModelRows => {
  const snapshot = state.snapshots.get(snapshotKey);
  if (snapshot === undefined) {
    throw new Error(`missing snapshot object: ${snapshotKey}`);
  }

  return new Map(snapshot.rows);
};
