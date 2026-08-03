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
  // MODEL ASSUMPTION, not a kernel constant. Every other field above is
  // imported from `@baerly/protocol`; this one is the Cloudflare Workers Free
  // plan per-request subrequest cap, a platform limit the kernel does not
  // model or export. It is what P8f measures the probe cost against, so it is
  // reported under `modelAssumptions` — never `liveConstants` — in the
  // evidence payload.
  subrequestLimit: 50,
};

export const NODE_BUDGET: FoldBudget = {
  maxEntriesPerRun: MAINTENANCE_PROFILE_NODE.maxFoldEntriesPerPass,
  minEntriesToCompact: WRITE_TICK_MIN_ENTRIES_TO_COMPACT,
  ceilingBytes: MAINTENANCE_PROFILE_NODE.maxFoldBytes,
  ceilingEntries: MAINTENANCE_PROFILE_NODE.maxFoldRows,
  // MODEL ASSUMPTION (see CF_FREE_BUDGET above). Self-hosted Node has no
  // platform subrequest cap; this stands in for "effectively unbounded" so the
  // Node arm can share one `FoldBudget` shape with the Cloudflare arm.
  subrequestLimit: 10_000,
};

interface PreparedFoldBase {
  readonly baseGeneration: number;
  readonly readSet: readonly number[];
  readonly cost: FoldCost;
}

/**
 * The result of one fold preparation, discriminated on `outcome`.
 *
 * `foldEnd` and `snapshot` are state-dependent: no boundary was chosen below the
 * minimum threshold, and a deferred fold chose a boundary but published no
 * object. Modelling that as a union rather than a flat record with two nullable
 * fields is what lets `schedule.ts` reach `snapshot` after an
 * `outcome !== "prepared"` early return without a non-null assertion.
 *
 * Every variant still declares both fields — `null`-typed where absent — so
 * call sites that only want to report or compare them (the evidence tables, for
 * instance) can read `foldEnd` / `snapshot` off an un-narrowed value.
 */
export type PreparedFold =
  | (PreparedFoldBase & {
      readonly outcome: "below_min_threshold";
      readonly foldEnd: null;
      readonly snapshot: null;
    })
  | (PreparedFoldBase & {
      readonly outcome: "deferred";
      readonly foldEnd: number;
      readonly snapshot: null;
    })
  | (PreparedFoldBase & {
      readonly outcome: "prepared";
      readonly foldEnd: number;
      readonly snapshot: SnapshotObject;
    });

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
