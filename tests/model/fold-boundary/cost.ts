import type { ModelManifest } from "./model.ts";

export interface FoldCost {
  readonly currentGets: number;
  readonly probeGets: number;
  readonly snapshotGets: number;
  readonly logGets: number;
  readonly snapshotPuts: number;
  readonly currentPuts: number;
  readonly total: number;
}

export const foldCost = (args: {
  readonly manifest: ModelManifest;
  readonly probeFloor: number;
  readonly observedTail: number;
  readonly logEntriesRead: number;
  readonly reachedSnapshotPut: boolean;
  readonly reachedCurrentCas: boolean;
}): FoldCost => {
  const currentGets = 1;
  const probeGets = Math.max(0, args.observedTail - args.probeFloor) + 1;
  const snapshotGets = args.manifest.snapshotKey === null ? 0 : 1;
  const logGets = args.logEntriesRead;
  const snapshotPuts = args.reachedSnapshotPut ? 1 : 0;
  const currentPuts = args.reachedCurrentCas ? 1 : 0;

  return {
    currentGets,
    probeGets,
    snapshotGets,
    logGets,
    snapshotPuts,
    currentPuts,
    total: currentGets + probeGets + snapshotGets + logGets + snapshotPuts + currentPuts,
  };
};

export const billableClassA = (cost: FoldCost): number => cost.snapshotPuts + cost.currentPuts;
