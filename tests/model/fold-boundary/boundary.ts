import {
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_PROFILE_NODE,
  WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
} from "@baerly/protocol";

import { foldCost, type FoldCost } from "./cost.ts";
import {
  foldRange,
  makeSnapshot,
  type ModelManifest,
  type ModelState,
  type SnapshotObject,
} from "./model.ts";

export interface FoldBudget {
  readonly maxEntriesPerRun: number;
  readonly minEntriesToCompact: number;
  readonly ceilingBytes: number;
  readonly ceilingEntries: number;
  readonly subrequestLimit: number;
}

export type BoundaryAlgorithm = "live-greedy" | "aligned-observed" | "aligned-manifest";

export interface BoundaryInput {
  readonly manifest: ModelManifest;
  readonly observedTail: number;
  readonly budget: FoldBudget;
  readonly k: number;
}

export type BoundaryFn = (input: BoundaryInput) => number | null;

const validateK = (k: number): void => {
  if (!Number.isInteger(k) || k <= 0) {
    throw new RangeError("k must be a positive integer");
  }
};

const hasMinimumAvailability = (input: BoundaryInput): boolean =>
  input.observedTail - input.manifest.logSeqStart >= input.budget.minEntriesToCompact;

export const liveGreedyBoundary: BoundaryFn = (input) => {
  validateK(input.k);
  if (!hasMinimumAvailability(input)) {
    return null;
  }

  const boundary = Math.min(
    input.observedTail,
    input.manifest.logSeqStart + input.budget.maxEntriesPerRun,
  );
  return boundary > input.manifest.logSeqStart ? boundary : null;
};

export const alignedObservedBoundary: BoundaryFn = (input) => {
  validateK(input.k);
  const liveBoundary = liveGreedyBoundary(input);
  if (liveBoundary === null) {
    return null;
  }

  const boundary = Math.floor(liveBoundary / input.k) * input.k;
  return boundary > input.manifest.logSeqStart ? boundary : null;
};

export const alignedManifestTarget = (floor: number, k: number): number => {
  validateK(k);
  return (Math.floor(floor / k) + 1) * k;
};

export const alignedManifestBoundary: BoundaryFn = (input) => {
  validateK(input.k);
  if (!hasMinimumAvailability(input)) {
    return null;
  }

  const floor = input.manifest.logSeqStart;
  const target = alignedManifestTarget(floor, input.k);
  if (target > input.observedTail || target - floor > input.budget.maxEntriesPerRun) {
    return null;
  }

  return target;
};

export const CF_FREE_BUDGET: FoldBudget = {
  maxEntriesPerRun: MAINTENANCE_PROFILE_CF_FREE.maxFoldEntriesPerPass,
  minEntriesToCompact: WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
  ceilingBytes: MAINTENANCE_PROFILE_CF_FREE.maxFoldBytes,
  ceilingEntries: MAINTENANCE_PROFILE_CF_FREE.maxFoldRows,
  subrequestLimit: 50,
};

export const NODE_BUDGET: FoldBudget = {
  maxEntriesPerRun: MAINTENANCE_PROFILE_NODE.maxFoldEntriesPerPass,
  minEntriesToCompact: WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
  ceilingBytes: MAINTENANCE_PROFILE_NODE.maxFoldBytes,
  ceilingEntries: MAINTENANCE_PROFILE_NODE.maxFoldRows,
  subrequestLimit: 10_000,
};

export interface PreparedFold {
  readonly outcome: "below_min_threshold" | "deferred" | "prepared";
  readonly baseGeneration: number;
  readonly foldEnd: number | null;
  readonly readSet: readonly number[];
  readonly snapshot: SnapshotObject | null;
  readonly cost: FoldCost;
}

const algorithms: Readonly<Record<BoundaryAlgorithm, BoundaryFn>> = {
  "live-greedy": liveGreedyBoundary,
  "aligned-observed": alignedObservedBoundary,
  "aligned-manifest": alignedManifestBoundary,
};

const noWorkCost = (probeFloor: number, observedTail: number): FoldCost => {
  const currentGets = 1;
  const probeGets = Math.max(0, observedTail - probeFloor) + 1;
  return {
    currentGets,
    probeGets,
    snapshotGets: 0,
    logGets: 0,
    snapshotPuts: 0,
    currentPuts: 0,
    total: currentGets + probeGets,
  };
};

const encodedSnapshotBytes = (snapshot: SnapshotObject): number =>
  new TextEncoder().encode(JSON.stringify({ maxSeq: snapshot.maxSeq, rows: snapshot.rows })).length;

export const prepareFold = (args: {
  readonly state: ModelState;
  readonly observedTail: number;
  readonly probeFloor: number;
  readonly budget: FoldBudget;
  readonly k: number;
  readonly algorithm: BoundaryAlgorithm;
}): PreparedFold => {
  const availableTail = Math.max(0, Math.min(args.observedTail, args.state.log.acknowledgedTail));
  const baseGeneration = args.state.manifest.generation;
  const foldEnd = algorithms[args.algorithm]({
    manifest: args.state.manifest,
    observedTail: availableTail,
    budget: args.budget,
    k: args.k,
  });

  if (foldEnd === null) {
    return {
      outcome: "below_min_threshold",
      baseGeneration,
      foldEnd: null,
      readSet: [],
      snapshot: null,
      cost: noWorkCost(args.probeFloor, args.observedTail),
    };
  }

  const floor = args.state.manifest.logSeqStart;
  const priorRows = (() => {
    if (args.state.manifest.snapshotKey === null) {
      return new Map<string, number>();
    }
    const prior = args.state.snapshots.get(args.state.manifest.snapshotKey);
    if (prior === undefined) {
      throw new Error(`missing snapshot object: ${args.state.manifest.snapshotKey}`);
    }
    return new Map(prior.rows);
  })();
  const readSet = Array.from({ length: foldEnd - floor }, (_, index) => floor + index);
  const rows = foldRange(priorRows, args.state.log, floor, foldEnd);
  const snapshot = makeSnapshot(rows, foldEnd);
  const deferred =
    snapshot.rows.length > args.budget.ceilingEntries ||
    encodedSnapshotBytes(snapshot) > args.budget.ceilingBytes;

  if (deferred) {
    return {
      outcome: "deferred",
      baseGeneration,
      foldEnd,
      readSet,
      snapshot: null,
      cost: foldCost({
        manifest: args.state.manifest,
        probeFloor: args.probeFloor,
        observedTail: args.observedTail,
        logEntriesRead: readSet.length,
        reachedSnapshotPut: false,
        reachedCurrentCas: false,
      }),
    };
  }

  return {
    outcome: "prepared",
    baseGeneration,
    foldEnd,
    readSet,
    snapshot,
    cost: foldCost({
      manifest: args.state.manifest,
      probeFloor: args.probeFloor,
      observedTail: args.observedTail,
      logEntriesRead: readSet.length,
      reachedSnapshotPut: true,
      reachedCurrentCas: true,
    }),
  };
};
