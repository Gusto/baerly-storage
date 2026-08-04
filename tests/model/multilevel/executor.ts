import { isDeepStrictEqual } from "node:util";
import {
  reconstructModelCold,
  reconstructModelReference,
  reconstructModelWarm,
  type ModelReconstruction,
} from "./reconstruct.ts";
import {
  applyModelDurableEffect,
  emptyModelStore,
  reachableModelObjectKeys,
} from "./model-store.ts";
import { classifyModelRejectedArm } from "./rejected-arms.ts";
import {
  DEFAULT_MODEL_ASSUMPTIONS,
  type ModelAttempt,
  type ModelCoverage,
  type ModelDurableEffect,
  type ModelDurableResult,
  type ModelDurableTraceEntry,
  type ModelEmitRunOperation,
  type ModelLogObject,
  type ModelManifestObject,
  type ModelMergeRunsOperation,
  type ModelMutation,
  type ModelObject,
  type ModelOperation,
  type ModelPublicationInput,
  type ModelPublishRootOperation,
  type ModelReconstructOperation,
  type ModelRun as ModelBaseRun,
  type ModelRunObject,
  type ModelState,
  type ModelStore,
  type ModelTransition as ModelBaseTransition,
  type ModelTransitionOutcome,
  type ModelWorkloadAssumptions,
} from "./types.ts";

/**
 * A transition, carrying the reconstruction a `reconstruct` operation produced.
 *
 * `reconstructionMode` and `reconstruction` are one fact, not two: only a
 * `reconstruct` operation sets either, and it always sets both. Encoding that as
 * a union rather than two nullable fields means narrowing on the mode also
 * narrows the result, so consumers cannot be written to tolerate a half-set pair
 * and an edit that sets one without the other fails to compile.
 */
export type ModelTransition =
  | (Omit<ModelBaseTransition, "reconstructionMode"> & {
      readonly reconstructionMode: null;
      readonly reconstruction: null;
    })
  | (Omit<ModelBaseTransition, "reconstructionMode"> & {
      readonly reconstructionMode: ModelReconstructOperation["mode"];
      readonly reconstruction: ModelReconstruction;
    });

/** The arm of {@link ModelTransition} a `reconstruct` operation produces. */
export type ModelReconstructTransition = Extract<
  ModelTransition,
  { readonly reconstruction: ModelReconstruction }
>;

export interface ModelRun extends Omit<ModelBaseRun, "transitions"> {
  readonly transitions: readonly ModelTransition[];
}

export const initialModelState = (
  assumptions: ModelWorkloadAssumptions = DEFAULT_MODEL_ASSUMPTIONS,
): ModelState => ({
  assumptions,
  store: emptyModelStore(),
  referenceLedger: [],
  attempts: new Map(),
  pendingCrash: null,
  warmCache: { rootGeneration: null, runs: new Map() },
  coverage: {
    crashBoundaries: new Set(),
    publicationOutcomes: new Set(),
    maintenanceOrders: new Set(),
    rejectedArms: new Set(),
  },
  unreclaimedByAttempt: new Map(),
  unreclaimedAttempts: 0,
});

function modelRejectedTransition(
  state: ModelState,
  operation: ModelOperation,
  rejectionId: string,
): ModelTransition {
  const rejectedArms = new Set(state.coverage.rejectedArms);
  rejectedArms.add(rejectionId);
  const coverage: ModelCoverage = { ...state.coverage, rejectedArms };
  const attempt: ModelAttempt = { operation, durableEffects: [], outcome: "rejected" };
  const attempts = new Map(state.attempts);
  attempts.set(operation.operationId, attempt);
  return {
    state: { ...state, attempts, coverage },
    operation,
    outcome: "rejected",
    durableEffects: [],
    rejectionId,
    reconstructionMode: null,
    reconstruction: null,
  };
}

function modelHasMatchingAcknowledgement(state: ModelState, mutation: ModelMutation): boolean {
  const acknowledgement = state.store.objects.get(`ack/${mutation.sequence}`);
  const log = state.store.objects.get(`log/${mutation.sequence}`);
  return (
    acknowledgement?.kind === "ack" &&
    acknowledgement.key === `ack/${mutation.sequence}` &&
    acknowledgement.sequence === mutation.sequence &&
    acknowledgement.mutationId === mutation.mutationId &&
    log?.kind === "log" &&
    log.key === `log/${mutation.sequence}` &&
    isDeepStrictEqual(log.mutation, mutation)
  );
}

/**
 * Objects durably written by the trace, including those written by an
 * operation that crashed immediately afterwards.
 *
 * Depends only on the store, so callers checking many mutations against the
 * same state derive it once rather than per mutation.
 */
function modelAppliedTraceObjects(state: ModelState): readonly ModelObject[] {
  return state.store.durableTrace
    .filter(({ outcome }) => outcome === "applied" || outcome === "crashed-after")
    .flatMap(({ effect }) => (effect.kind === "put-immutable" ? [effect.object] : []));
}

function modelMutationWasAcknowledged(
  state: ModelState,
  mutation: ModelMutation,
  appliedObjects: readonly ModelObject[],
): boolean {
  if (modelHasMatchingAcknowledgement(state, mutation)) {
    return true;
  }
  const logged = appliedObjects.some(
    (object) => object.kind === "log" && isDeepStrictEqual(object.mutation, mutation),
  );
  const acknowledged = appliedObjects.some(
    (object) =>
      object.kind === "ack" &&
      object.sequence === mutation.sequence &&
      object.mutationId === mutation.mutationId,
  );
  return logged && acknowledged;
}

function modelManifest(
  state: ModelState,
  publication: ModelPublicationInput,
): ModelManifestObject | string {
  if (publication.expectedGeneration !== state.store.root.generation) {
    return `publish/stale-generation/${publication.publicationId}`;
  }

  const levelsByNumber = new Map<number, string[]>();
  const appliedObjects = modelAppliedTraceObjects(state);
  for (const runKey of publication.runKeys) {
    const object = state.store.objects.get(runKey);
    if (object?.kind !== "run") {
      return `publish/missing-run/${runKey}`;
    }
    const unacknowledged = object.mutations.find(
      (mutation) => !modelMutationWasAcknowledged(state, mutation, appliedObjects),
    );
    if (unacknowledged !== undefined) {
      return `publish/unacknowledged-mutation/${runKey}/${unacknowledged.mutationId}`;
    }
    const runKeys = levelsByNumber.get(object.level) ?? [];
    levelsByNumber.set(object.level, [...runKeys, runKey]);
  }

  return {
    kind: "manifest",
    key: `manifests/${publication.publicationId}`,
    generation: publication.expectedGeneration + 1,
    predecessorKey: state.store.root.manifestKey,
    foldedThrough: publication.foldedThrough,
    levels: [...levelsByNumber.entries()]
      .toSorted(([left], [right]) => left - right)
      .map(([level, runKeys]) => ({ level, runKeys })),
  };
}

/**
 * A publication is always exactly two effects, in this order. Encoding that as
 * a tuple rather than an array is what lets `lose-publication-cas` interleave
 * the two publications by index without asserting the indices exist.
 */
type ModelPublicationEffects = readonly [
  putManifest: ModelDurableEffect,
  casRoot: ModelDurableEffect,
];

function modelPublicationEffects(
  state: ModelState,
  publication: ModelPublicationInput,
): ModelPublicationEffects | string {
  const manifest = modelManifest(state, publication);
  if (typeof manifest === "string") {
    return manifest;
  }
  return [
    { kind: "put-immutable", object: manifest },
    {
      kind: "cas-root",
      expectedEtag: state.store.root.etag,
      next: {
        generation: manifest.generation,
        etag: `root/${publication.publicationId}`,
        manifestKey: manifest.key,
      },
    },
  ];
}

function modelMutationsForSequences(
  state: ModelState,
  operation: ModelEmitRunOperation,
): readonly ModelMutation[] | string {
  const mutations: ModelMutation[] = [];
  for (const sequence of operation.sequences) {
    const object = state.store.objects.get(`log/${sequence}`);
    if (object?.kind !== "log") {
      return `emit/missing-log/${sequence}`;
    }
    const log: ModelLogObject = object;
    if (!modelHasMatchingAcknowledgement(state, log.mutation)) {
      return `emit/missing-ack/${sequence}`;
    }
    mutations.push(log.mutation);
  }
  return mutations;
}

function modelMergedMutations(
  state: ModelState,
  operation: ModelMergeRunsOperation,
): readonly ModelMutation[] | string {
  const bySequence = new Map<number, ModelMutation>();
  for (const runKey of operation.inputRunKeys) {
    const object = state.store.objects.get(runKey);
    if (object?.kind !== "run") {
      return `merge/missing-run/${runKey}`;
    }
    for (const mutation of object.mutations) {
      bySequence.set(mutation.sequence, mutation);
    }
  }
  return [...bySequence.values()].toSorted((left, right) => left.sequence - right.sequence);
}

function modelOperationEffects(
  state: ModelState,
  operation: ModelOperation,
): readonly ModelDurableEffect[] | string {
  switch (operation.kind) {
    case "append-log": {
      // Derived inside the narrowed branch rather than from a parallel
      // ternary: a single discriminant test keeps `contentKey` and the content
      // effect from drifting apart, and removes the non-null assertion that
      // would have silently produced `key: null` if they ever did.
      let contentKey: string | null = null;
      const effects: ModelDurableEffect[] = [];
      if (operation.mutation.change.kind === "put") {
        contentKey = `content/${operation.mutation.mutationId}`;
        effects.push({
          kind: "put-immutable",
          object: {
            kind: "content",
            key: contentKey,
            documentId: operation.mutation.documentId,
            value: operation.mutation.change.value,
          },
        });
      }
      effects.push({
        kind: "put-immutable",
        object: {
          kind: "log",
          key: `log/${operation.mutation.sequence}`,
          mutation: operation.mutation,
          contentKey,
        },
      });
      if (operation.acknowledgement === "acknowledge") {
        effects.push({
          kind: "put-immutable",
          object: {
            kind: "ack",
            key: `ack/${operation.mutation.sequence}`,
            sequence: operation.mutation.sequence,
            mutationId: operation.mutation.mutationId,
          },
        });
      }
      return effects;
    }
    case "emit-run": {
      const mutations = modelMutationsForSequences(state, operation);
      if (typeof mutations === "string") {
        return mutations;
      }
      return [
        {
          kind: "put-immutable",
          object: {
            kind: "run",
            key: `runs/${operation.runId}`,
            level: operation.level,
            mutations,
            complete: true,
          },
        },
      ];
    }
    case "publish-root": {
      return modelPublicationEffects(state, operation);
    }
    case "merge-runs": {
      const mutations = modelMergedMutations(state, operation);
      if (typeof mutations === "string") {
        return mutations;
      }
      return [
        {
          kind: "put-immutable",
          object: {
            kind: "run",
            key: `runs/${operation.outputRunId}`,
            level: operation.targetLevel,
            mutations,
            complete: true,
          },
        },
      ];
    }
    case "lose-publication-cas": {
      if (operation.winner.expectedGeneration !== operation.loser.expectedGeneration) {
        return `publish/generation-mismatch/${operation.operationId}`;
      }
      const winner = modelPublicationEffects(state, operation.winner);
      const loser = modelPublicationEffects(state, operation.loser);
      if (typeof winner === "string") {
        return winner;
      }
      if (typeof loser === "string") {
        return loser;
      }
      const [winnerManifest, winnerCas] = winner;
      const [loserManifest, loserCas] = loser;
      return [winnerManifest, loserManifest, winnerCas, loserCas];
    }
    case "reclaim": {
      const reachable = reachableModelObjectKeys(state.store);
      const reachableCandidate = operation.candidateKeys.find((key) => reachable.has(key));
      if (reachableCandidate !== undefined) {
        return `reclaim/reachable/${reachableCandidate}`;
      }
      return operation.candidateKeys.map((key) => ({ kind: "delete-object", key }));
    }
    case "crash":
    case "retry":
    case "reconstruct": {
      return [];
    }
  }
}

/**
 * How many durable effects `operation` would attempt from `state`, which is
 * exactly how many crash boundaries it has: `executeModelDurableOperation`
 * offers `before` and `after` at each index in `[0, count)`, and
 * `modelStateAfterCrashIndexValidation` rejects an armed index outside it.
 *
 * Exists so a caller enumerating crash points derives its bound instead of
 * repeating the current maximum — today 4, from the composite CAS's
 * winner/loser manifest plus winner/loser root CAS. A literal would leave the
 * new last boundary unprobed, silently and without a failing test, the day an
 * operation gains an effect.
 *
 * A rejected operation attempts nothing and so has no boundary: `0`.
 */
export const modelDurableEffectCount = (state: ModelState, operation: ModelOperation): number => {
  const effects = modelOperationEffects(state, operation);
  return typeof effects === "string" ? 0 : effects.length;
};

function modelTraceResult(
  result: ModelDurableResult,
  previousTraceLength: number,
  operationId: string,
  effectIndex: number,
): ModelDurableResult {
  const traceEntry: ModelDurableTraceEntry = {
    ...result.traceEntry,
    effectId: `${operationId}/${effectIndex}`,
    operationId,
    effectIndex,
  };
  if (result.store.durableTrace.length === previousTraceLength) {
    return { ...result, traceEntry };
  }
  return {
    ...result,
    store: {
      ...result.store,
      durableTrace: [...result.store.durableTrace.slice(0, -1), traceEntry],
    },
    traceEntry,
  };
}

/**
 * A tail fold: a publication that both carries runs and advances
 * `foldedThrough`. A `role: "tail"` publication that moves neither is not one,
 * so `tail-fold-and-base-merge-run-in-both-orders` cannot be satisfied by a
 * publication that folded nothing.
 */
const isModelTailFold = (operation: ModelOperation): boolean =>
  operation.kind === "publish-root" &&
  operation.role === "tail" &&
  operation.runKeys.length > 0 &&
  operation.foldedThrough > 0;

/** A base merge: a merge that actually consumed inputs. */
const isModelBaseMerge = (operation: ModelOperation): boolean =>
  operation.kind === "merge-runs" && operation.inputRunKeys.length > 0;

function modelMaintenanceCoverage(
  state: ModelState,
  operation: ModelPublishRootOperation | ModelMergeRunsOperation,
): ModelCoverage {
  const publicationOutcomes = new Set(state.coverage.publicationOutcomes);
  if (operation.kind === "publish-root") {
    publicationOutcomes.add("win");
  }

  // Only whether such an attempt exists matters, not which one, so this neither
  // reverses nor keeps the match.
  const appliedAttemptExists = (matches: (operation: ModelOperation) => boolean): boolean =>
    [...state.attempts.values()].some(
      (attempt) => attempt.outcome === "applied" && matches(attempt.operation),
    );

  const maintenanceOrders = new Set(state.coverage.maintenanceOrders);
  if (isModelBaseMerge(operation) && appliedAttemptExists(isModelTailFold)) {
    maintenanceOrders.add("tail-before-base");
  } else if (isModelTailFold(operation) && appliedAttemptExists(isModelBaseMerge)) {
    maintenanceOrders.add("base-before-tail");
  }
  return { ...state.coverage, publicationOutcomes, maintenanceOrders };
}

function modelSuccessfulState(state: ModelState, operation: ModelOperation): ModelState {
  switch (operation.kind) {
    case "append-log": {
      if (
        operation.acknowledgement === "drop" ||
        state.referenceLedger.some(({ mutationId }) => mutationId === operation.mutation.mutationId)
      ) {
        return state;
      }
      return { ...state, referenceLedger: [...state.referenceLedger, operation.mutation] };
    }
    case "emit-run": {
      const object = state.store.objects.get(`runs/${operation.runId}`);
      if (object?.kind !== "run") {
        return state;
      }
      const runs = new Map(state.warmCache.runs);
      runs.set(object.key, object);
      return { ...state, warmCache: { ...state.warmCache, runs } };
    }
    case "merge-runs": {
      const object = state.store.objects.get(`runs/${operation.outputRunId}`);
      if (object?.kind !== "run") {
        return state;
      }
      const run: ModelRunObject = object;
      const runs = new Map(state.warmCache.runs);
      runs.set(run.key, run);
      return {
        ...state,
        warmCache: { ...state.warmCache, runs },
        coverage: modelMaintenanceCoverage(state, operation),
      };
    }
    case "publish-root": {
      return {
        ...state,
        warmCache: { ...state.warmCache, rootGeneration: state.store.root.generation },
        coverage: modelMaintenanceCoverage(state, operation),
      };
    }
    case "reclaim": {
      const runs = new Map(state.warmCache.runs);
      for (const key of operation.candidateKeys) {
        runs.delete(key);
      }
      return { ...state, warmCache: { ...state.warmCache, runs } };
    }
    case "lose-publication-cas":
    case "crash":
    case "retry":
    case "reconstruct": {
      return state;
    }
  }
}

function modelStateAfterCrashIndexValidation(
  state: ModelState,
  operationId: string,
  effectCount: number,
): ModelState {
  const pending = state.pendingCrash;
  const hasInvalidCrashIndex =
    pending?.targetOperationId === operationId &&
    (!Number.isInteger(pending.durableEffectIndex) ||
      pending.durableEffectIndex < 0 ||
      pending.durableEffectIndex >= effectCount);
  if (pending === null || !hasInvalidCrashIndex) {
    return state;
  }
  const rejectedArms = new Set(state.coverage.rejectedArms);
  rejectedArms.add(`crash/invalid-effect-index/${pending.operationId}`);
  return {
    ...state,
    pendingCrash: null,
    coverage: { ...state.coverage, rejectedArms },
  };
}

function modelCompositeReplayEffects(
  state: ModelState,
  attempt: ModelAttempt,
): readonly ModelDurableEffect[] | null {
  const operation = attempt.operation;
  if (operation.kind !== "lose-publication-cas") {
    return null;
  }
  const winnerManifest = attempt.durableEffects[0];
  const loserManifest = attempt.durableEffects[1];
  const winnerCas = attempt.durableEffects[2];
  if (
    winnerManifest?.kind !== "put-immutable" ||
    loserManifest?.kind !== "put-immutable" ||
    winnerCas?.kind !== "cas-root" ||
    !isDeepStrictEqual(state.store.root, winnerCas.next)
  ) {
    return null;
  }
  return [
    winnerManifest,
    loserManifest,
    winnerCas,
    {
      kind: "cas-root",
      expectedEtag: winnerCas.expectedEtag,
      next: {
        generation: operation.loser.expectedGeneration + 1,
        etag: `root/${operation.loser.publicationId}`,
        manifestKey: `manifests/${operation.loser.publicationId}`,
      },
    },
  ];
}

function modelUnreclaimedOwner(operation: ModelOperation, key: string): string {
  if (operation.kind !== "lose-publication-cas") {
    return operation.operationId;
  }
  return key === `manifests/${operation.loser.publicationId}`
    ? operation.loser.publicationId
    : operation.winner.publicationId;
}

function modelAdoptedRunOwners(
  store: ModelStore,
  operation: ModelOperation,
): ReadonlyMap<string, string> {
  const owners = new Map<string, string>();
  if (operation.kind === "publish-root") {
    if (store.objects.has(`manifests/${operation.publicationId}`)) {
      for (const runKey of operation.runKeys) {
        owners.set(runKey, operation.operationId);
      }
    }
    return owners;
  }
  if (operation.kind === "merge-runs") {
    if (store.objects.has(`runs/${operation.outputRunId}`)) {
      for (const runKey of operation.inputRunKeys) {
        owners.set(runKey, operation.operationId);
      }
    }
    return owners;
  }
  if (operation.kind !== "lose-publication-cas") {
    return owners;
  }
  if (store.objects.has(`manifests/${operation.winner.publicationId}`)) {
    for (const runKey of operation.winner.runKeys) {
      owners.set(runKey, operation.winner.publicationId);
    }
  }
  if (store.objects.has(`manifests/${operation.loser.publicationId}`)) {
    for (const runKey of operation.loser.runKeys) {
      if (!owners.has(runKey)) {
        owners.set(runKey, operation.loser.publicationId);
      }
    }
  }
  return owners;
}

/**
 * Pass 1 of `modelUnreclaimedOwnership`: an attempt keeps the keys it already
 * owned, minus any the operation reached, deleted, or adopted. Excluding the
 * adopted keys is what makes this pass disjoint from pass 2, which reassigns
 * exactly those keys to whoever superseded the run.
 */
function modelCarriedOverOwnership(
  state: ModelState,
  store: ModelStore,
  afterReachable: ReadonlySet<string>,
  adoptedRunOwners: ReadonlyMap<string, string>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const ownership = new Map<string, ReadonlySet<string>>();
  for (const [owner, keys] of state.unreclaimedByAttempt) {
    const liveKeys = new Set(
      [...keys].filter(
        (key) => store.objects.has(key) && !afterReachable.has(key) && !adoptedRunOwners.has(key),
      ),
    );
    if (liveKeys.size > 0) {
      ownership.set(owner, liveKeys);
    }
  }
  return ownership;
}

/**
 * Pass 2: the publication or merge that superseded a run becomes accountable
 * for it, but only once its own output is durable — `modelAdoptedRunOwners`
 * checks that, so a torn attempt adopts nothing and the run stays with its
 * previous owner. A run the operation left reachable is not garbage yet.
 */
function modelAdoptedOwnership(
  store: ModelStore,
  afterReachable: ReadonlySet<string>,
  adoptedRunOwners: ReadonlyMap<string, string>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const ownership = new Map<string, Set<string>>();
  for (const [key, owner] of adoptedRunOwners) {
    if (!store.objects.has(key) || afterReachable.has(key)) {
      continue;
    }
    const keys = ownership.get(owner) ?? new Set<string>();
    keys.add(key);
    ownership.set(owner, keys);
  }
  return ownership;
}

/**
 * Pass 3: whatever this operation left unreachable and unclaimed is its own
 * orphan. The `claimed` set is what the two earlier passes already attributed.
 *
 * The pre-existing-and-already-unreachable skip is the load-bearing clause: a
 * key that was in the store and unreachable *before* the operation ran is
 * somebody else's garbage that the earlier passes declined to carry over —
 * typically because a crash lost the attempt that owned it. Claiming it here
 * would charge this operation for a predecessor's litter and inflate
 * `unreclaimedAttempts` toward the `maxConcurrentPublishers` bound.
 */
function modelOrphanOwnership(
  state: ModelState,
  store: ModelStore,
  beforeReachable: ReadonlySet<string>,
  afterReachable: ReadonlySet<string>,
  operation: ModelOperation,
  claimed: ReadonlySet<string>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const ownership = new Map<string, Set<string>>();
  for (const key of store.objects.keys()) {
    if (afterReachable.has(key) || claimed.has(key)) {
      continue;
    }
    if (state.store.objects.has(key) && !beforeReachable.has(key)) {
      continue;
    }
    const owner = modelUnreclaimedOwner(operation, key);
    const keys = ownership.get(owner) ?? new Set<string>();
    keys.add(key);
    ownership.set(owner, keys);
  }
  return ownership;
}

function modelOwnedKeys(
  contributions: readonly ReadonlyMap<string, ReadonlySet<string>>[],
): ReadonlySet<string> {
  const owned = new Set<string>();
  for (const contribution of contributions) {
    for (const keys of contribution.values()) {
      for (const key of keys) {
        owned.add(key);
      }
    }
  }
  return owned;
}

function modelMergedOwnership(
  contributions: readonly ReadonlyMap<string, ReadonlySet<string>>[],
): ReadonlyMap<string, ReadonlySet<string>> {
  const merged = new Map<string, Set<string>>();
  for (const contribution of contributions) {
    for (const [owner, keys] of contribution) {
      const existing = merged.get(owner) ?? new Set<string>();
      for (const key of keys) {
        existing.add(key);
      }
      merged.set(owner, existing);
    }
  }
  return merged;
}

/**
 * Which attempt is accountable for each object the operation left unreachable.
 * `unreclaimedAttempts` is this map's size, and the generator holds it at or
 * under `maxConcurrentPublishers`, so a rule that over-attributes shows up as a
 * schedule the generator refuses to build rather than as a wrong report.
 *
 * Three rules, applied in order, each contributing independently: carried-over,
 * adopted, then orphan. Carried-over and adopted are disjoint by construction —
 * the first excludes exactly the keys the second claims — so only the orphan
 * rule needs to see what the earlier two took.
 */
function modelUnreclaimedOwnership(
  state: ModelState,
  store: ModelStore,
  operation: ModelOperation,
): ReadonlyMap<string, ReadonlySet<string>> {
  const beforeReachable = reachableModelObjectKeys(state.store);
  const afterReachable = reachableModelObjectKeys(store);
  const adoptedRunOwners = modelAdoptedRunOwners(store, operation);

  const carried = modelCarriedOverOwnership(state, store, afterReachable, adoptedRunOwners);
  const adopted = modelAdoptedOwnership(store, afterReachable, adoptedRunOwners);
  const orphans = modelOrphanOwnership(
    state,
    store,
    beforeReachable,
    afterReachable,
    operation,
    modelOwnedKeys([carried, adopted]),
  );

  return modelMergedOwnership([carried, adopted, orphans]);
}

function executeModelDurableOperation(
  state: ModelState,
  operation: ModelOperation,
  effects: readonly ModelDurableEffect[],
): ModelTransition {
  let nextState = modelStateAfterCrashIndexValidation(state, operation.operationId, effects.length);
  let outcome: ModelTransitionOutcome = "applied";
  let rejectionId: string | null = null;
  let attemptedCount = 0;

  for (const [effectIndex, effect] of effects.entries()) {
    attemptedCount = effectIndex + 1;
    const pending = nextState.pendingCrash;
    const crash =
      pending?.targetOperationId === operation.operationId &&
      pending.durableEffectIndex === effectIndex
        ? pending.boundary
        : null;
    const rawResult = applyModelDurableEffect(nextState.store, effect, crash);
    const result = modelTraceResult(
      rawResult,
      nextState.store.durableTrace.length,
      operation.operationId,
      effectIndex,
    );
    nextState = Object.assign({}, nextState, { store: result.store });

    if (result.outcome === "conflict") {
      if (crash === "after" && pending !== null) {
        const rejectedArms = new Set(nextState.coverage.rejectedArms);
        rejectedArms.add(`crash/unapplied-effect/${pending.operationId}`);
        nextState = {
          ...nextState,
          pendingCrash: null,
          coverage: { ...nextState.coverage, rejectedArms },
        };
      }
      outcome = effect.kind === "cas-root" ? "cas-lost" : "rejected";
      rejectionId =
        effect.kind === "cas-root"
          ? null
          : `durable/conflict/${operation.operationId}/${effectIndex}`;
      break;
    }
    if (result.outcome === "crashed-before" || result.outcome === "crashed-after") {
      outcome = result.outcome;
      const crashBoundaries = new Set(nextState.coverage.crashBoundaries);
      crashBoundaries.add(`${operation.operationId}/${effectIndex}/${crash}`);
      nextState = {
        ...nextState,
        pendingCrash: null,
        warmCache: { rootGeneration: null, runs: new Map() },
        coverage: { ...nextState.coverage, crashBoundaries },
      };
      break;
    }
  }

  if (outcome === "applied" || (outcome === "crashed-after" && attemptedCount === effects.length)) {
    nextState = modelSuccessfulState(nextState, operation);
  }
  if (operation.kind === "lose-publication-cas" && outcome === "cas-lost") {
    const publicationOutcomes = new Set(nextState.coverage.publicationOutcomes);
    publicationOutcomes.add("win");
    publicationOutcomes.add("lose");
    nextState = {
      ...nextState,
      warmCache: { ...nextState.warmCache, rootGeneration: nextState.store.root.generation },
      coverage: { ...nextState.coverage, publicationOutcomes },
    };
  }
  if (outcome === "rejected" && rejectionId !== null) {
    const rejectedArms = new Set(nextState.coverage.rejectedArms);
    rejectedArms.add(rejectionId);
    nextState = { ...nextState, coverage: { ...nextState.coverage, rejectedArms } };
  }

  const attemptedEffects = effects.slice(0, attemptedCount);
  const attempts = new Map(nextState.attempts);
  attempts.set(operation.operationId, { operation, durableEffects: attemptedEffects, outcome });
  const unreclaimedByAttempt = modelUnreclaimedOwnership(state, nextState.store, operation);
  nextState = {
    ...nextState,
    attempts,
    unreclaimedByAttempt,
    unreclaimedAttempts: unreclaimedByAttempt.size,
  };

  return {
    state: nextState,
    operation,
    outcome,
    durableEffects: attemptedEffects,
    rejectionId,
    reconstructionMode: null,
    reconstruction: null,
  };
}

/** Arms a crash for a later operation; durable state is untouched. */
function executeModelCrashArming(
  state: ModelState,
  operation: Extract<ModelOperation, { readonly kind: "crash" }>,
): ModelTransition {
  if (state.pendingCrash !== null) {
    return modelRejectedTransition(
      state,
      operation,
      `crash/already-armed/${operation.operationId}`,
    );
  }
  const attempts = new Map(state.attempts);
  attempts.set(operation.operationId, { operation, durableEffects: [], outcome: "applied" });
  return {
    state: { ...state, attempts, pendingCrash: operation },
    operation,
    outcome: "applied",
    durableEffects: [],
    rejectionId: null,
    reconstructionMode: null,
    reconstruction: null,
  };
}

/**
 * Replays the target of a retry. A publication whose CAS already landed, and any
 * operation with recorded composite effects, replays those exact effects rather
 * than being recomputed, so the replay is the idempotence question the property
 * asks and not a fresh attempt that happens to agree.
 */
function executeModelRetry(
  state: ModelState,
  operation: Extract<ModelOperation, { readonly kind: "retry" }>,
): ModelTransition {
  const target = state.attempts.get(operation.targetOperationId);
  if (
    target === undefined ||
    target.operation.kind === "retry" ||
    target.operation.kind === "crash" ||
    target.operation.kind === "reconstruct"
  ) {
    return modelRejectedTransition(state, operation, "retry-without-crash");
  }
  const recordedCas = target.durableEffects.at(-1);
  const publicationAlreadyLanded =
    target.operation.kind === "publish-root" &&
    recordedCas?.kind === "cas-root" &&
    recordedCas.next.generation === state.store.root.generation &&
    recordedCas.next.etag === state.store.root.etag &&
    recordedCas.next.manifestKey === state.store.root.manifestKey;
  const compositeReplayEffects = modelCompositeReplayEffects(state, target);
  const replay =
    publicationAlreadyLanded || compositeReplayEffects !== null
      ? executeModelDurableOperation(
          state,
          target.operation,
          compositeReplayEffects ?? target.durableEffects,
        )
      : executeModelOperation(state, target.operation);
  const attempts = new Map(replay.state.attempts);
  attempts.set(operation.operationId, {
    operation,
    durableEffects: replay.durableEffects,
    outcome: replay.outcome,
  });
  return {
    ...replay,
    state: { ...replay.state, attempts },
    operation,
  };
}

/** Materialises a view through one of the three reconstruction paths. */
function executeModelReconstruct(
  state: ModelState,
  operation: Extract<ModelOperation, { readonly kind: "reconstruct" }>,
): ModelTransition {
  const validatedState = modelStateAfterCrashIndexValidation(state, operation.operationId, 0);
  const reconstruction: ModelReconstruction = (() => {
    switch (operation.mode) {
      case "cold": {
        return reconstructModelCold(validatedState.store);
      }
      case "warm": {
        return reconstructModelWarm(validatedState.store, validatedState.warmCache);
      }
      case "reference": {
        // The reference replay reads the ledger, so it neither consults nor
        // populates the warm cache. Returning the incoming cache unchanged is
        // what makes it a no-op for the cache below rather than a special case
        // spelled out there.
        return {
          view: reconstructModelReference(validatedState.referenceLedger),
          cache: validatedState.warmCache,
          findings: [],
        };
      }
    }
  })();
  const attempts = new Map(validatedState.attempts);
  attempts.set(operation.operationId, { operation, durableEffects: [], outcome: "applied" });
  return {
    state: {
      ...validatedState,
      attempts,
      warmCache: reconstruction.cache,
    },
    operation,
    outcome: "applied",
    durableEffects: [],
    rejectionId: null,
    reconstructionMode: operation.mode,
    reconstruction,
  };
}

export const executeModelOperation = (
  state: ModelState,
  operation: ModelOperation,
): ModelTransition => {
  const classifiedRejection = classifyModelRejectedArm(state, operation);
  if (classifiedRejection !== null) {
    const validatedState = modelStateAfterCrashIndexValidation(state, operation.operationId, 0);
    return modelRejectedTransition(validatedState, operation, classifiedRejection);
  }

  switch (operation.kind) {
    case "crash": {
      return executeModelCrashArming(state, operation);
    }
    case "retry": {
      return executeModelRetry(state, operation);
    }
    case "reconstruct": {
      return executeModelReconstruct(state, operation);
    }
    default: {
      const effects = modelOperationEffects(state, operation);
      if (typeof effects === "string") {
        const validatedState = modelStateAfterCrashIndexValidation(state, operation.operationId, 0);
        return modelRejectedTransition(validatedState, operation, effects);
      }
      return executeModelDurableOperation(state, operation, effects);
    }
  }
};

export const runModelSchedule = (
  initial: ModelState,
  operations: readonly ModelOperation[],
): ModelRun => {
  const transitions: ModelTransition[] = [];
  let state = initial;
  for (const operation of operations) {
    const transition = executeModelOperation(state, operation);
    transitions.push(transition);
    state = transition.state;
  }
  return { initial, final: state, transitions };
};
