import { isDeepStrictEqual } from "node:util";
import {
  executeModelOperation,
  type ModelReconstructTransition,
  type ModelRun,
  type ModelTransition,
} from "./executor.ts";
import { reachableModelObjectKeys } from "./model-store.ts";
import {
  calculateModelObjectBound,
  countModelObjects,
  ModelAssumptionViolationError,
  type ModelObjectBoundObservation,
} from "./object-count.ts";
import type { ModelPropertyCheck, ModelPropertyName } from "./property-suite.ts";
import {
  equalModelViews,
  isCanonicalModelSuffixAcknowledgement,
  isCanonicalModelSuffixLog,
  reconstructModelCold,
  reconstructModelReference,
  reconstructModelWarm,
  type ModelLogicalView,
  type ModelReconstruction,
} from "./reconstruct.ts";
import {
  compareModelMutations,
  MODEL_NOTHING_FOLDED,
  type ModelLosePublicationCasOperation,
  type ModelManifestObject,
  type ModelMutation,
  type ModelRunObject,
  type ModelState,
  type ModelWorkloadAssumptions,
} from "./types.ts";

function modelPropertyCheck(
  name: ModelPropertyName,
  failures: readonly string[],
  evidence: readonly string[],
): ModelPropertyCheck {
  return { name, ok: failures.length === 0, evidence: [...evidence, ...failures] };
}

function modelAcknowledgedLedger(run: ModelRun): readonly ModelMutation[] {
  const acknowledged = new Map<string, ModelMutation>();
  const acknowledgedMutationIds = new Set(
    run.final.store.durableTrace.flatMap(({ effect, outcome }) =>
      (outcome === "applied" || outcome === "crashed-after") &&
      effect.kind === "put-immutable" &&
      effect.object.kind === "ack"
        ? [effect.object.mutationId]
        : [],
    ),
  );
  for (const transition of run.transitions) {
    const operation = transition.operation;
    if (operation.kind !== "append-log" || operation.acknowledgement !== "acknowledge") {
      continue;
    }
    if (acknowledgedMutationIds.has(operation.mutation.mutationId)) {
      acknowledged.set(operation.mutation.mutationId, operation.mutation);
    }
  }
  // Sorted for the evidence and failure lines this ledger feeds, not for the
  // replay: `reconstructModelReference` orders its input itself. Both use
  // `compareModelMutations` so a reported ordering matches the replayed one.
  return [...acknowledged.values()].toSorted(compareModelMutations);
}

function modelViewValue(view: ModelLogicalView, documentId: string): string {
  return view.has(documentId) ? String(view.get(documentId)) : "absent";
}

function checkAcknowledgedMutations(run: ModelRun): ModelPropertyCheck {
  const ledger = modelAcknowledgedLedger(run);
  const expected = reconstructModelReference(ledger);
  const reference = reconstructModelReference(run.final.referenceLedger);
  const cold = reconstructModelCold(run.final.store).view;
  const warm = reconstructModelWarm(run.final.store, run.final.warmCache).view;
  const documentIds = new Set(ledger.map(({ documentId }) => documentId));
  const failures: string[] = [];

  for (const documentId of documentIds) {
    const expectedValue = modelViewValue(expected, documentId);
    for (const [mode, view] of [
      ["reference", reference],
      ["cold", cold],
      ["warm", warm],
    ] as const) {
      if (modelViewValue(view, documentId) !== expectedValue) {
        failures.push(
          `document=${documentId}:expected=${expectedValue}:${mode}=${modelViewValue(view, documentId)}`,
        );
      }
    }
  }

  return modelPropertyCheck(
    "acknowledged-mutations-never-lost",
    failures,
    ledger.map(({ mutationId }) => `acknowledged=${mutationId}`),
  );
}

function checkUnacknowledgedMutations(
  run: ModelRun,
  requireDroppedEvidence: boolean,
): ModelPropertyCheck {
  const dropped = new Map<string, ModelMutation>();
  for (const { operation } of run.transitions) {
    if (operation.kind === "append-log" && operation.acknowledgement === "drop") {
      dropped.set(operation.mutation.mutationId, operation.mutation);
    }
  }

  const reachable = reachableModelObjectKeys(run.final.store);
  const failures: string[] = [];
  if (requireDroppedEvidence && dropped.size === 0) {
    failures.push("missing-dropped-mutation-evidence");
  }
  for (const mutation of dropped.values()) {
    const locations: string[] = [];
    if (run.final.referenceLedger.some(({ mutationId }) => mutationId === mutation.mutationId)) {
      locations.push("reference-ledger");
    }
    if (
      [...run.final.store.objects.values()].some(
        (object) => object.kind === "ack" && object.mutationId === mutation.mutationId,
      )
    ) {
      locations.push("acknowledged-suffix");
    }
    for (const key of reachable) {
      const object = run.final.store.objects.get(key);
      if (
        object?.kind === "run" &&
        object.mutations.some(({ mutationId }) => mutationId === mutation.mutationId)
      ) {
        locations.push(key);
      }
    }
    if (locations.length > 0) {
      failures.push(`mutation=${mutation.mutationId}:visible=${locations.join(",")}`);
    }
  }

  return modelPropertyCheck(
    "unacknowledged-mutations-never-visible",
    failures,
    [...dropped.keys()].map((mutationId) => `dropped=${mutationId}`),
  );
}

/**
 * Recomputes what the transition's declared mode should have produced from the
 * state the transition settled in, independently of the result it recorded.
 */
function expectedModelTransitionView(transition: ModelReconstructTransition): ModelReconstruction {
  switch (transition.reconstructionMode) {
    case "cold": {
      return reconstructModelCold(transition.state.store);
    }
    case "warm": {
      return reconstructModelWarm(transition.state.store, transition.state.warmCache);
    }
    case "reference": {
      return {
        view: reconstructModelReference(transition.state.referenceLedger),
        cache: transition.state.warmCache,
        findings: [],
      };
    }
  }
}

function recordModelReconstructionFindings(
  failures: string[],
  label: string,
  reconstruction: ModelReconstruction,
): void {
  for (const finding of reconstruction.findings) {
    failures.push(`${label}:finding=${finding}`);
  }
}

function checkReconstructions(run: ModelRun): ModelPropertyCheck {
  const reference = reconstructModelReference(run.final.referenceLedger);
  const cold = reconstructModelCold(run.final.store);
  const warm = reconstructModelWarm(run.final.store, run.final.warmCache);
  const failures: string[] = [];
  const evidence = ["final=reference,cold,warm"];

  recordModelReconstructionFindings(failures, "final:cold", cold);
  recordModelReconstructionFindings(failures, "final:warm", warm);
  if (!equalModelViews(reference, cold.view)) {
    failures.push("final:cold!=reference");
  }
  if (!equalModelViews(reference, warm.view)) {
    failures.push("final:warm!=reference");
  }
  for (const transition of run.transitions) {
    if (transition.reconstructionMode === null) {
      continue;
    }
    // Narrowing on the mode narrowed `reconstruction` too, so a recorded result
    // that went missing is a compile error rather than a mismatch line here.
    const label = `reconstruction=${transition.operation.operationId}`;
    evidence.push(`${label}:${transition.reconstructionMode}`);
    const expected = expectedModelTransitionView(transition);
    recordModelReconstructionFindings(failures, `${label}:expected`, expected);
    recordModelReconstructionFindings(failures, `${label}:recorded`, transition.reconstruction);
    if (!equalModelViews(expected.view, transition.reconstruction.view)) {
      failures.push(`${label}:${transition.reconstructionMode}:mismatch`);
    }
  }

  return modelPropertyCheck("cold-and-warm-equal-reference-replay", failures, evidence);
}

function validateModelPublishedState(previous: ModelState, current: ModelState): readonly string[] {
  const failures: string[] = [];
  const previousRoot = previous.store.root;
  const root = current.store.root;
  if (root.generation === previousRoot.generation) {
    if (!isDeepStrictEqual(root, previousRoot)) {
      failures.push(`generation=${root.generation}:root-changed-without-generation`);
    }
    return failures;
  }
  if (root.generation !== previousRoot.generation + 1) {
    failures.push(`generation=${previousRoot.generation}->${root.generation}:non-monotone`);
  }

  if (root.manifestKey === null) {
    if (root.generation !== 0) {
      failures.push(`generation=${root.generation}:missing-manifest-key`);
    }
    return failures;
  }
  const object = current.store.objects.get(root.manifestKey);
  if (object?.kind !== "manifest") {
    failures.push(`generation=${root.generation}:manifest=${root.manifestKey}:missing`);
    return failures;
  }
  const manifest: ModelManifestObject = object;
  if (manifest.key !== root.manifestKey) {
    failures.push(
      `generation=${root.generation}:manifest-key=${manifest.key}:expected=${root.manifestKey}`,
    );
  }
  if (manifest.generation !== root.generation) {
    failures.push(
      `generation=${root.generation}:manifest=${manifest.key}:declares=${manifest.generation}`,
    );
  }
  if (
    root.generation !== previousRoot.generation &&
    manifest.predecessorKey !== previousRoot.manifestKey
  ) {
    failures.push(
      `generation=${root.generation}:predecessor=${String(manifest.predecessorKey)}:expected=${String(previousRoot.manifestKey)}`,
    );
  }
  for (const level of manifest.levels) {
    for (const runKey of level.runKeys) {
      const run = current.store.objects.get(runKey);
      if (
        run?.kind !== "run" ||
        run.key !== runKey ||
        run.level !== level.level ||
        run.complete !== true
      ) {
        failures.push(`generation=${root.generation}:run=${runKey}:incomplete`);
      }
    }
  }
  return failures;
}

function checkPublications(run: ModelRun): ModelPropertyCheck {
  const states = [run.initial, ...run.transitions.map(({ state }) => state)];
  if (states.at(-1) !== run.final) {
    states.push(run.final);
  }
  const failures: string[] = [];
  const generations = new Set<number>();
  for (let index = 1; index < states.length; index += 1) {
    const previous = states[index - 1] as ModelState;
    const current = states[index] as ModelState;
    generations.add(current.store.root.generation);
    failures.push(...validateModelPublishedState(previous, current));
  }

  return modelPropertyCheck(
    "publication-monotone-no-partial-run",
    failures,
    [...generations].toSorted((left, right) => left - right).map((value) => `generation=${value}`),
  );
}

function modelWinningLineageKeys(state: ModelState): ReadonlySet<string> {
  const lineage = new Set<string>();
  let manifestKey = state.store.root.manifestKey;
  while (manifestKey !== null && !lineage.has(manifestKey)) {
    lineage.add(manifestKey);
    const object = state.store.objects.get(manifestKey);
    if (object?.kind !== "manifest") {
      break;
    }
    for (const level of object.levels) {
      for (const runKey of level.runKeys) {
        lineage.add(runKey);
      }
    }
    manifestKey = object.predecessorKey;
  }
  return lineage;
}

interface ModelLostCasProvenance {
  readonly operation: ModelLosePublicationCasOperation;
  readonly stateBefore: ModelState;
}

function modelLostCasProvenance(
  run: ModelRun,
  transitionIndex: number,
  failures: string[],
  evidence: string[],
): ModelLostCasProvenance | null {
  const transition = run.transitions[transitionIndex];
  if (transition === undefined || transition.outcome !== "cas-lost") {
    return null;
  }
  if (transition.operation.kind === "lose-publication-cas") {
    return {
      operation: transition.operation,
      stateBefore:
        transitionIndex === 0
          ? run.initial
          : (run.transitions[transitionIndex - 1]?.state ?? run.initial),
    };
  }
  if (transition.operation.kind !== "retry") {
    return null;
  }

  const targetOperationId = transition.operation.targetOperationId;
  evidence.push(`retry=${transition.operation.operationId}:target=${targetOperationId}`);
  for (let index = transitionIndex - 1; index >= 0; index -= 1) {
    const original = run.transitions[index];
    if (
      original?.operation.kind !== "lose-publication-cas" ||
      original.operation.operationId !== targetOperationId
    ) {
      continue;
    }
    return {
      operation: original.operation,
      stateBefore: index === 0 ? run.initial : (run.transitions[index - 1]?.state ?? run.initial),
    };
  }
  failures.push(
    `retry=${transition.operation.operationId}:target=${targetOperationId}:original-not-found`,
  );
  return null;
}

function modelExpectedWinnerManifest(
  provenance: ModelLostCasProvenance,
  failures: string[],
): { readonly manifest: ModelManifestObject; readonly runs: readonly ModelRunObject[] } | null {
  const { operation, stateBefore } = provenance;
  const levelsByNumber = new Map<number, string[]>();
  const runs: ModelRunObject[] = [];
  for (const runKey of operation.winner.runKeys) {
    const object = stateBefore.store.objects.get(runKey);
    if (object?.kind !== "run") {
      failures.push(`original=${operation.operationId}:winner-run=${runKey}:missing-provenance`);
      continue;
    }
    runs.push(object);
    const runKeys = levelsByNumber.get(object.level) ?? [];
    levelsByNumber.set(object.level, [...runKeys, runKey]);
  }
  if (runs.length !== operation.winner.runKeys.length) {
    return null;
  }
  return {
    manifest: {
      kind: "manifest",
      key: `manifests/${operation.winner.publicationId}`,
      generation: operation.winner.expectedGeneration + 1,
      predecessorKey: stateBefore.store.root.manifestKey,
      foldedThrough: operation.winner.foldedThrough,
      levels: [...levelsByNumber.entries()]
        .toSorted(([left], [right]) => left - right)
        .map(([level, runKeys]) => ({ level, runKeys })),
    },
    runs,
  };
}

function checkLostCasLineage(run: ModelRun): ModelPropertyCheck {
  const failures: string[] = [];
  const evidence: string[] = [];
  for (const [transitionIndex, transition] of run.transitions.entries()) {
    const provenance = modelLostCasProvenance(run, transitionIndex, failures, evidence);
    if (provenance === null) {
      continue;
    }
    const operation = provenance.operation;
    const expected = modelExpectedWinnerManifest(provenance, failures);
    const lineage = modelWinningLineageKeys(transition.state);
    const winnerManifestKey = `manifests/${operation.winner.publicationId}`;
    const loserManifestKey = `manifests/${operation.loser.publicationId}`;
    const loserOnlyRunKeys = operation.loser.runKeys.filter(
      (key) => !operation.winner.runKeys.includes(key),
    );
    evidence.push(
      `original=${operation.operationId}`,
      `winner-lineage=${winnerManifestKey}`,
      `loser-lineage=${loserManifestKey}`,
    );
    const expectedRoot = {
      generation: operation.winner.expectedGeneration + 1,
      etag: `root/${operation.winner.publicationId}`,
      manifestKey: winnerManifestKey,
    };
    if (!isDeepStrictEqual(transition.state.store.root, expectedRoot)) {
      failures.push(`winner=${winnerManifestKey}:root-mismatch`);
    }
    if (!lineage.has(winnerManifestKey)) {
      failures.push(`winner=${winnerManifestKey}:not-published`);
    }
    const winnerManifest = transition.state.store.objects.get(winnerManifestKey);
    if (expected !== null && !isDeepStrictEqual(winnerManifest, expected.manifest)) {
      failures.push(`winner=${winnerManifestKey}:manifest-mismatch`);
    }
    for (const expectedRun of expected?.runs ?? []) {
      evidence.push(`winner-run=${expectedRun.key}`);
      if (!isDeepStrictEqual(transition.state.store.objects.get(expectedRun.key), expectedRun)) {
        failures.push(`winner-run=${expectedRun.key}:missing-or-corrupt`);
      }
    }
    if (lineage.has(loserManifestKey)) {
      failures.push(`loser=${loserManifestKey}:attached`);
    }
    for (const runKey of loserOnlyRunKeys) {
      evidence.push(`loser-run=${runKey}`);
      if (lineage.has(runKey)) {
        failures.push(`loser-run=${runKey}:attached`);
      }
    }
  }

  return modelPropertyCheck("lost-cas-preserves-winning-lineage", failures, evidence);
}

function checkReclamation(run: ModelRun): ModelPropertyCheck {
  const failures: string[] = [];
  const evidence: string[] = [];
  let previous = run.initial;
  for (const transition of run.transitions) {
    if (transition.operation.kind === "reclaim") {
      const before = reachableModelObjectKeys(previous.store);
      const after = reachableModelObjectKeys(transition.state.store);
      for (const key of before) {
        evidence.push(`reachable=${key}`);
        if (!after.has(key) || !transition.state.store.objects.has(key)) {
          failures.push(`reachable=${key}:removed-by=${transition.operation.operationId}`);
        }
      }
    }
    previous = transition.state;
  }

  return modelPropertyCheck("reclamation-preserves-reachable-objects", failures, evidence);
}

function modelRecoveryRelevantStateEqual(left: ModelState, right: ModelState): boolean {
  const acknowledgementEvidence = (state: ModelState): ReadonlyMap<string, unknown> => {
    const objects = new Map<string, unknown>();
    for (const entry of state.store.durableTrace) {
      if (
        (entry.outcome === "applied" || entry.outcome === "crashed-after") &&
        entry.effect.kind === "put-immutable"
      ) {
        objects.set(entry.effect.object.key, entry.effect.object);
      }
    }
    return objects;
  };
  return (
    isDeepStrictEqual(left.assumptions, right.assumptions) &&
    isDeepStrictEqual(left.store.root, right.store.root) &&
    isDeepStrictEqual(left.store.objects, right.store.objects) &&
    isDeepStrictEqual(acknowledgementEvidence(left), acknowledgementEvidence(right)) &&
    isDeepStrictEqual(left.referenceLedger, right.referenceLedger) &&
    isDeepStrictEqual(left.attempts, right.attempts) &&
    isDeepStrictEqual(left.pendingCrash, right.pendingCrash) &&
    isDeepStrictEqual(left.warmCache, right.warmCache) &&
    isDeepStrictEqual(left.coverage, right.coverage) &&
    isDeepStrictEqual(left.unreclaimedByAttempt, right.unreclaimedByAttempt) &&
    left.unreclaimedAttempts === right.unreclaimedAttempts &&
    equalModelViews(reconstructModelCold(left.store).view, reconstructModelCold(right.store).view)
  );
}

/** Names the crash boundary a retry is recovering from, for evidence strings. */
function modelCrashEffectId(run: ModelRun, crashIndex: number, crashed: ModelTransition): string {
  const crash = run.transitions
    .slice(0, crashIndex)
    .toReversed()
    .find(
      ({ operation }) =>
        operation.kind === "crash" && operation.targetOperationId === crashed.operation.operationId,
    )?.operation;
  return crash?.kind === "crash"
    ? `${crash.targetOperationId}/${crash.durableEffectIndex}/${crash.boundary}`
    : `${crashed.operation.operationId}/unknown`;
}

/**
 * The observed retry of a crashed operation, paired with the state it ran
 * against so the check can recompute it independently.
 */
function findModelRetry(
  run: ModelRun,
  crashIndex: number,
  crashed: ModelTransition,
): { readonly retry: ModelTransition; readonly beforeRetry: ModelState } | null {
  const retryIndex = run.transitions.findIndex(
    ({ operation }, index) =>
      index > crashIndex &&
      operation.kind === "retry" &&
      operation.targetOperationId === crashed.operation.operationId,
  );
  const retry = run.transitions[retryIndex];
  if (retry === undefined || retry.operation.kind !== "retry") {
    return null;
  }
  return {
    retry,
    beforeRetry:
      retryIndex === 0 ? run.initial : (run.transitions[retryIndex - 1]?.state ?? run.initial),
  };
}

/**
 * Stage 1 — the observed retry must match an independent recomputation from
 * the same prior state, and must be recorded as what it actually was.
 */
function checkModelFirstRetry(
  crashEffectId: string,
  retry: ModelTransition,
  expectedRetry: ModelTransition,
): readonly string[] {
  const failures: string[] = [];
  if (retry.outcome === "rejected") {
    failures.push(`crash-effect=${crashEffectId}:first-retry-rejected`);
  }
  if (expectedRetry.outcome === "rejected" || retry.outcome !== expectedRetry.outcome) {
    failures.push(
      `crash-effect=${crashEffectId}:first-retry-outcome=${retry.outcome}:expected=${expectedRetry.outcome}`,
    );
  }
  if (retry.rejectionId !== expectedRetry.rejectionId) {
    failures.push(
      `crash-effect=${crashEffectId}:first-retry-rejection=${String(retry.rejectionId)}:expected=${String(expectedRetry.rejectionId)}`,
    );
  }
  if (!modelRecoveryRelevantStateEqual(retry.state, expectedRetry.state)) {
    failures.push(`crash-effect=${crashEffectId}:first-retry-state-mismatch`);
  }
  const retryAttempt = retry.state.attempts.get(retry.operation.operationId);
  if (retryAttempt?.outcome !== retry.outcome) {
    failures.push(
      `crash-effect=${crashEffectId}:first-retry-recorded=${String(retryAttempt?.outcome)}:transition=${retry.outcome}`,
    );
  }
  return failures;
}

/**
 * Stage 2 — retrying again from both the observed and the recomputed state
 * must agree, which is idempotence proper.
 */
function checkModelSecondRetry(
  crashEffectId: string,
  secondRetry: ModelTransition,
  expectedSecondRetry: ModelTransition,
): readonly string[] {
  const failures: string[] = [];
  if (
    secondRetry.outcome !== expectedSecondRetry.outcome ||
    secondRetry.rejectionId !== expectedSecondRetry.rejectionId
  ) {
    failures.push(
      `crash-effect=${crashEffectId}:second-retry-outcome=${secondRetry.outcome}:expected=${expectedSecondRetry.outcome}:rejection=${String(secondRetry.rejectionId)}:expected-rejection=${String(expectedSecondRetry.rejectionId)}`,
    );
  }
  if (!modelRecoveryRelevantStateEqual(secondRetry.state, expectedSecondRetry.state)) {
    failures.push(`crash-effect=${crashEffectId}:second-retry-state-mismatch`);
  }
  return failures;
}

/**
 * Stage 3 — one more retry past the settled point must change nothing.
 *
 * A `cas-lost` first retry has not settled yet: losing the CAS is a legitimate
 * outcome that the next retry resolves. So the settled point is one retry
 * later, and verification is the retry after that.
 */
function checkModelRetryStability(
  crashEffectId: string,
  retry: ModelTransition,
  secondRetry: ModelTransition,
): readonly string[] {
  const failures: string[] = [];
  const settled = retry.outcome === "cas-lost" ? secondRetry : retry;
  const verification =
    retry.outcome === "cas-lost"
      ? executeModelOperation(secondRetry.state, retry.operation)
      : secondRetry;
  if (
    verification.outcome !== settled.outcome ||
    verification.rejectionId !== settled.rejectionId
  ) {
    failures.push(`crash-effect=${crashEffectId}:retry-outcome-not-stable`);
  }
  if (!modelRecoveryRelevantStateEqual(settled.state, verification.state)) {
    failures.push(`crash-effect=${crashEffectId}:second-retry-changed-state`);
  }
  return failures;
}

function checkRecoveryIdempotence(run: ModelRun): ModelPropertyCheck {
  const failures: string[] = [];
  const evidence: string[] = [];
  for (const [crashIndex, crashed] of run.transitions.entries()) {
    if (crashed.outcome !== "crashed-before" && crashed.outcome !== "crashed-after") {
      continue;
    }
    const crashEffectId = modelCrashEffectId(run, crashIndex, crashed);
    evidence.push(`crash-effect=${crashEffectId}`);

    const found = findModelRetry(run, crashIndex, crashed);
    if (found === null) {
      evidence.push(`crash-effect=${crashEffectId}:retry-pending`);
      continue;
    }
    const { retry, beforeRetry } = found;

    const expectedRetry = executeModelOperation(beforeRetry, retry.operation);
    const secondRetry = executeModelOperation(retry.state, retry.operation);
    const expectedSecondRetry = executeModelOperation(expectedRetry.state, retry.operation);

    failures.push(
      ...checkModelFirstRetry(crashEffectId, retry, expectedRetry),
      ...checkModelSecondRetry(crashEffectId, secondRetry, expectedSecondRetry),
      ...checkModelRetryStability(crashEffectId, retry, secondRetry),
    );
  }

  return modelPropertyCheck("recovery-idempotent-after-every-crash-point", failures, evidence);
}

function modelActiveLevelCount(state: ModelState): number {
  const manifestKey = state.store.root.manifestKey;
  if (manifestKey === null) {
    return 0;
  }
  const manifest = state.store.objects.get(manifestKey);
  return manifest?.kind === "manifest"
    ? new Set(manifest.levels.map(({ level }) => level)).size
    : 0;
}

function modelActiveRunsPerLevel(state: ModelState): ReadonlyMap<number, number> {
  const counts = new Map<number, number>();
  const manifestKey = state.store.root.manifestKey;
  const manifest = manifestKey === null ? undefined : state.store.objects.get(manifestKey);
  if (manifest?.kind !== "manifest") {
    return counts;
  }
  for (const { level, runKeys } of manifest.levels) {
    counts.set(level, (counts.get(level) ?? 0) + runKeys.length);
  }
  return counts;
}

function modelCommittedSuffixEntryCount(state: ModelState): number {
  const manifestKey = state.store.root.manifestKey;
  const manifest = manifestKey === null ? undefined : state.store.objects.get(manifestKey);
  const foldedThrough =
    manifest?.kind === "manifest" ? manifest.foldedThrough : MODEL_NOTHING_FOLDED;
  const sequences = new Set<number>();
  for (const object of state.store.objects.values()) {
    if (
      object.kind !== "ack" ||
      object.sequence <= foldedThrough ||
      !isCanonicalModelSuffixAcknowledgement(object)
    ) {
      continue;
    }
    const log = state.store.objects.get(`log/${object.sequence}`);
    if (log === undefined || !isCanonicalModelSuffixLog(object, log)) {
      continue;
    }
    sequences.add(object.sequence);
  }
  return sequences.size;
}

function assertModelPhysicalShapeWithinAssumptions(
  state: ModelState,
  assumptions: ModelWorkloadAssumptions,
): void {
  for (const [level, count] of [...modelActiveRunsPerLevel(state)].toSorted(
    ([left], [right]) => left - right,
  )) {
    if (count > assumptions.maxRunsPerLevel) {
      throw new ModelAssumptionViolationError(
        `activeRuns[level=${level}]=${count} exceeds maxRunsPerLevel=${assumptions.maxRunsPerLevel}`,
      );
    }
  }
  const committedSuffixEntries = modelCommittedSuffixEntryCount(state);
  if (committedSuffixEntries > assumptions.maxCommittedSuffixEntries) {
    throw new ModelAssumptionViolationError(
      `committedSuffixEntries=${committedSuffixEntries} exceeds maxCommittedSuffixEntries=${assumptions.maxCommittedSuffixEntries}`,
    );
  }
}

function checkObjectBound(
  run: ModelRun,
  assumptions: ModelWorkloadAssumptions,
): ModelPropertyCheck {
  const observation: ModelObjectBoundObservation = {
    liveDocuments: reconstructModelReference(run.final.referenceLedger).size,
    activeLevels: modelActiveLevelCount(run.final),
    unreclaimedAttempts: run.final.unreclaimedAttempts,
  };
  try {
    assertModelPhysicalShapeWithinAssumptions(run.final, assumptions);
    const bound = calculateModelObjectBound(assumptions, observation);
    const objects = countModelObjects(run.final);
    return modelPropertyCheck(
      "total-object-count-is-bounded",
      objects <= bound ? [] : [`objects=${objects}:exceeds-bound=${bound}`],
      [
        `objects=${objects}`,
        `bound=${bound}`,
        `D=${observation.liveDocuments}`,
        `L=${observation.activeLevels}`,
        `C=${observation.unreclaimedAttempts}`,
        `R=${assumptions.maxRunsPerLevel}`,
        `S=${assumptions.maxCommittedSuffixEntries}`,
      ],
    );
  } catch (error) {
    if (error instanceof ModelAssumptionViolationError) {
      return {
        name: "total-object-count-is-bounded",
        ok: false,
        evidence: [`assumption-violation:${error.message}`],
      };
    }
    throw error;
  }
}

export const checkModelSafety = (
  run: ModelRun,
  assumptions: ModelWorkloadAssumptions,
): readonly ModelPropertyCheck[] => [
  checkAcknowledgedMutations(run),
  checkUnacknowledgedMutations(run, true),
  checkReconstructions(run),
  checkPublications(run),
  checkLostCasLineage(run),
  checkReclamation(run),
  checkRecoveryIdempotence(run),
  checkObjectBound(run, assumptions),
];

export const checkModelSafetyProperty = (
  name: ModelPropertyName,
  run: ModelRun,
  assumptions: ModelWorkloadAssumptions,
  requireNamedEvidence = true,
): ModelPropertyCheck => {
  switch (name) {
    case "acknowledged-mutations-never-lost": {
      return checkAcknowledgedMutations(run);
    }
    case "unacknowledged-mutations-never-visible": {
      return checkUnacknowledgedMutations(run, requireNamedEvidence);
    }
    case "cold-and-warm-equal-reference-replay": {
      return checkReconstructions(run);
    }
    case "publication-monotone-no-partial-run": {
      return checkPublications(run);
    }
    case "lost-cas-preserves-winning-lineage": {
      return checkLostCasLineage(run);
    }
    case "reclamation-preserves-reachable-objects": {
      return checkReclamation(run);
    }
    case "recovery-idempotent-after-every-crash-point": {
      return checkRecoveryIdempotence(run);
    }
    case "total-object-count-is-bounded": {
      return checkObjectBound(run, assumptions);
    }
    default: {
      throw new Error(`${name} is not a safety property`);
    }
  }
};
