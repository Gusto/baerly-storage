import { prepareFold, type BoundaryAlgorithm, type FoldBudget } from "./boundary.ts";
import type { FoldCost } from "./cost.ts";
import type { ModelManifest, ModelState, SnapshotObject } from "./model.ts";

export type CrashPoint = "none" | "after_manifest_read" | "after_snapshot_put";

export interface ObserverAction {
  readonly observerId: number;
  readonly readsAtGeneration: number;
  readonly observedTail: number;
  readonly k: number;
  readonly budget: FoldBudget;
  readonly algorithm: BoundaryAlgorithm;
  readonly crashAt: CrashPoint;
}

export interface FoldAttempt {
  readonly observerId: number;
  readonly outcome: "below_min_threshold" | "deferred" | "crashed" | "cas_lost" | "written";
  readonly baseGeneration: number;
  readonly foldEnd: number | null;
  readonly emittedKey: string | null;
  readonly readSet: readonly number[];
  readonly cost: FoldCost;
}

export interface ScheduleResult {
  readonly attempts: readonly FoldAttempt[];
  readonly finalState: ModelState;
  readonly generations: readonly ModelManifest[];
  readonly neverReferencedSnapshots: readonly string[];
  readonly supersededSnapshots: readonly string[];
  readonly reclaimableSnapshots: readonly string[];
}

interface MutableSchedule {
  state: ModelState;
  readonly attempts: FoldAttempt[];
  readonly generations: ModelManifest[];
}

const manifestReadCost = (): FoldCost => ({
  currentGets: 1,
  probeGets: 0,
  snapshotGets: 0,
  logGets: 0,
  snapshotPuts: 0,
  currentPuts: 0,
  total: 1,
});

const withoutCurrentPut = (cost: FoldCost): FoldCost => ({
  ...cost,
  currentPuts: 0,
  total: cost.total - cost.currentPuts,
});

const storeSnapshot = (state: ModelState, snapshot: SnapshotObject): ModelState => {
  const snapshots = new Map(state.snapshots);
  snapshots.set(snapshot.key, snapshot);
  return { ...state, snapshots };
};

const selectedManifest = (
  generations: readonly ModelManifest[],
  action: ObserverAction,
): ModelManifest => {
  if (action.readsAtGeneration === Number.MAX_SAFE_INTEGER) {
    return generations.at(-1)!;
  }

  const manifest = generations.find(({ generation }) => generation === action.readsAtGeneration);
  if (manifest === undefined) {
    throw new RangeError(`generation ${action.readsAtGeneration} has not been created`);
  }
  return manifest;
};

const performAttempt = (schedule: MutableSchedule, action: ObserverAction): FoldAttempt => {
  const manifest = selectedManifest(schedule.generations, action);
  if (action.crashAt === "after_manifest_read") {
    return {
      observerId: action.observerId,
      outcome: "crashed",
      baseGeneration: manifest.generation,
      foldEnd: null,
      emittedKey: null,
      readSet: [],
      cost: manifestReadCost(),
    };
  }

  const observedTail = Math.max(
    0,
    Math.min(action.observedTail, schedule.state.log.acknowledgedTail),
  );
  const historicalState: ModelState = {
    log: schedule.state.log,
    manifest,
    snapshots: schedule.state.snapshots,
  };
  const prepared = prepareFold({
    state: historicalState,
    observedTail,
    probeFloor: manifest.tailHint,
    budget: action.budget,
    k: action.k,
    algorithm: action.algorithm,
  });

  if (prepared.outcome !== "prepared") {
    return {
      observerId: action.observerId,
      outcome: prepared.outcome,
      baseGeneration: prepared.baseGeneration,
      foldEnd: prepared.foldEnd,
      emittedKey: null,
      readSet: prepared.readSet,
      cost: prepared.cost,
    };
  }

  const snapshot = prepared.snapshot!;
  schedule.state = storeSnapshot(schedule.state, snapshot);
  if (action.crashAt === "after_snapshot_put") {
    return {
      observerId: action.observerId,
      outcome: "crashed",
      baseGeneration: prepared.baseGeneration,
      foldEnd: prepared.foldEnd,
      emittedKey: snapshot.key,
      readSet: prepared.readSet,
      cost: withoutCurrentPut(prepared.cost),
    };
  }

  if (schedule.state.manifest.generation !== prepared.baseGeneration) {
    return {
      observerId: action.observerId,
      outcome: "cas_lost",
      baseGeneration: prepared.baseGeneration,
      foldEnd: prepared.foldEnd,
      emittedKey: snapshot.key,
      readSet: prepared.readSet,
      cost: prepared.cost,
    };
  }

  const published: ModelManifest = {
    ...manifest,
    generation: manifest.generation + 1,
    logSeqStart: snapshot.maxSeq,
    snapshotKey: snapshot.key,
  };
  schedule.state = { ...schedule.state, manifest: published };
  schedule.generations.push(published);
  return {
    observerId: action.observerId,
    outcome: "written",
    baseGeneration: prepared.baseGeneration,
    foldEnd: prepared.foldEnd,
    emittedKey: snapshot.key,
    readSet: prepared.readSet,
    cost: prepared.cost,
  };
};

const finish = (schedule: MutableSchedule): ScheduleResult => {
  const referenced = new Set(
    schedule.generations.flatMap(({ snapshotKey }) => (snapshotKey === null ? [] : [snapshotKey])),
  );
  const currentKey = schedule.state.manifest.snapshotKey;
  const present = [...schedule.state.snapshots.keys()];
  const neverReferencedSnapshots = present.filter((key) => !referenced.has(key)).toSorted();
  const supersededSnapshots = present
    .filter((key) => referenced.has(key) && key !== currentKey)
    .toSorted();
  const reclaimableSnapshots = [
    ...new Set([...neverReferencedSnapshots, ...supersededSnapshots]),
  ].toSorted();

  return {
    attempts: schedule.attempts,
    finalState: schedule.state,
    generations: schedule.generations,
    neverReferencedSnapshots,
    supersededSnapshots,
    reclaimableSnapshots,
  };
};

const mutableSchedule = (initial: ModelState): MutableSchedule => ({
  state: initial,
  attempts: [],
  generations: [initial.manifest],
});

export const runSchedule = (args: {
  readonly initial: ModelState;
  readonly observers: readonly ObserverAction[];
}): ScheduleResult => {
  const schedule = mutableSchedule(args.initial);
  for (const observer of args.observers) {
    schedule.attempts.push(performAttempt(schedule, observer));
  }
  return finish(schedule);
};

export const drainToQuiescence = (args: {
  readonly initial: ModelState;
  readonly budget: FoldBudget;
  readonly k: number;
  readonly algorithm: BoundaryAlgorithm;
  readonly maxPasses: number;
}): ScheduleResult => {
  const schedule = mutableSchedule(args.initial);
  for (let pass = 0; pass < args.maxPasses; pass += 1) {
    const attempt = performAttempt(schedule, {
      observerId: pass,
      readsAtGeneration: Number.MAX_SAFE_INTEGER,
      observedTail: schedule.state.log.acknowledgedTail,
      k: args.k,
      budget: args.budget,
      algorithm: args.algorithm,
      crashAt: "none",
    });
    schedule.attempts.push(attempt);
    if (attempt.outcome !== "written") {
      break;
    }
  }
  return finish(schedule);
};
