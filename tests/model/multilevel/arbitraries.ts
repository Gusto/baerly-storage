import * as fc from "fast-check";
import {
  executeModelOperation,
  initialModelState,
  modelDurableEffectCount,
  runModelSchedule,
} from "./executor.ts";
import { reachableModelObjectKeys } from "./model-store.ts";
import {
  DEFAULT_MODEL_ASSUMPTIONS,
  validateModelFullSuiteAssumptions,
  type ModelAppendLogOperation,
  type ModelCrashBoundary,
  type ModelMutation,
  type ModelOperation,
  type ModelPublicationInput,
  type ModelState,
  type ModelWorkloadAssumptions,
} from "./types.ts";

export interface ModelScenario {
  readonly assumptions: ModelWorkloadAssumptions;
  readonly operations: readonly ModelOperation[];
}

const modelDerivedCrashScheduleSources = new WeakMap<ModelScenario, number>();

export const modelDerivedCrashScheduleSourceOperations = (scenario: ModelScenario): number | null =>
  modelDerivedCrashScheduleSources.get(scenario) ?? null;

type ModelGeneratedAction =
  | "emit"
  | "merge"
  | "publish"
  | "cas"
  | "tail-base"
  | "base-tail"
  | "crash"
  | "reconstruct"
  | "reclaim";

interface ModelGeneratedRun {
  readonly key: string;
  readonly level: number;
  readonly sequences: readonly number[];
}

interface ModelScheduleBuilder {
  readonly assumptions: ModelWorkloadAssumptions;
  readonly operationLimit: number;
  readonly operations: ModelOperation[];
  readonly runsByLevel: Map<number, ModelGeneratedRun[]>;
  readonly suffixSequences: number[];
  readonly unrunSequences: number[];
  state: ModelState;
  generation: number;
  nextRun: number;
  nextPublication: number;
  nextCrash: number;
  nextReconstruct: number;
  nextReclaim: number;
}

function modelMutationWorkloadArbitrary(
  assumptions: ModelWorkloadAssumptions,
): fc.Arbitrary<readonly ModelMutation[]> {
  const documentCount = Math.max(0, Math.min(8, assumptions.maxLiveDocuments));
  const mutationCount = Math.max(
    0,
    Math.min(8, Math.max(0, assumptions.maxScheduleOperations - 2)),
  );
  if (documentCount === 0 || mutationCount === 0) {
    return fc.constant([]);
  }

  return fc
    .array(
      fc.record({
        documentIndex: fc.integer({ min: 0, max: documentCount - 1 }),
        change: fc.oneof(
          fc.record({ kind: fc.constant("put" as const), value: fc.integer() }),
          fc.constant({ kind: "delete" as const }),
        ),
      }),
      { minLength: 1, maxLength: mutationCount },
    )
    .map((entries) =>
      entries.map(({ documentIndex, change }, index): ModelMutation => ({
        mutationId: `mutation-${index + 1}`,
        sequence: index + 1,
        documentId: `doc-${documentIndex}`,
        change,
      })),
    );
}

function modelPublication(
  publicationId: string,
  expectedGeneration: number,
  runKeys: readonly string[],
  foldedThrough: number,
  role: "tail" | "base",
): ModelPublicationInput {
  return { publicationId, expectedGeneration, runKeys, foldedThrough, role };
}

function modelHasCapacity(builder: ModelScheduleBuilder, count: number): boolean {
  return builder.operations.length + count <= builder.operationLimit;
}

function modelApplyBuiltOperation(builder: ModelScheduleBuilder, operation: ModelOperation): void {
  builder.operations.push(operation);
  builder.state = executeModelOperation(builder.state, operation).state;
}

function modelOwnedReclaimCandidates(
  state: ModelState,
  protectedKeys: ReadonlySet<string>,
): readonly string[] {
  const reachableKeys = reachableModelObjectKeys(state.store);
  return [...state.unreclaimedByAttempt.values()]
    .filter((keys) =>
      Array.from(keys).every((key) => !reachableKeys.has(key) && !protectedKeys.has(key)),
    )
    .flatMap((keys) => Array.from(keys))
    .toSorted();
}

function modelPressureReclaimCandidates(builder: ModelScheduleBuilder): readonly string[] {
  const stagedRunKeys = new Set(modelRuns(builder).map(({ key }) => key));
  return modelOwnedReclaimCandidates(builder.state, stagedRunKeys);
}

function modelPushBoundedOperation(
  builder: ModelScheduleBuilder,
  operation: ModelOperation,
): boolean {
  if (!modelHasCapacity(builder, 1)) {
    return false;
  }
  const nextState = executeModelOperation(builder.state, operation).state;
  if (
    nextState.unreclaimedAttempts <= builder.assumptions.maxConcurrentPublishers &&
    !modelCrashPrefixExceedsOwnerBound(builder.state, operation)
  ) {
    modelApplyBuiltOperation(builder, operation);
    return true;
  }
  if (!modelHasCapacity(builder, 2)) {
    return false;
  }

  const candidateKeys = modelPressureReclaimCandidates(builder);
  if (candidateKeys.length === 0) {
    return false;
  }
  const reclaim: ModelOperation = {
    kind: "reclaim",
    operationId: `reclaim-pressure-${builder.nextReclaim}`,
    candidateKeys,
  };
  const reclaimed = executeModelOperation(builder.state, reclaim);
  if (reclaimed.outcome !== "applied") {
    return false;
  }
  const reclaimedNextState = executeModelOperation(reclaimed.state, operation).state;
  if (
    reclaimedNextState.unreclaimedAttempts > builder.assumptions.maxConcurrentPublishers ||
    modelCrashPrefixExceedsOwnerBound(reclaimed.state, operation)
  ) {
    return false;
  }

  builder.nextReclaim += 1;
  modelApplyBuiltOperation(builder, reclaim);
  modelApplyBuiltOperation(builder, operation);
  return true;
}

function modelCrashPrefixExceedsOwnerBound(state: ModelState, operation: ModelOperation): boolean {
  const effectCount = modelDurableEffectCount(state, operation);
  for (let durableEffectIndex = 0; durableEffectIndex < effectCount; durableEffectIndex += 1) {
    for (const boundary of ["before", "after"] as const) {
      const armed = executeModelOperation(state, {
        kind: "crash",
        operationId: `bound-probe-${operation.operationId}-${durableEffectIndex}-${boundary}`,
        targetOperationId: operation.operationId,
        durableEffectIndex,
        boundary,
      });
      const target = executeModelOperation(armed.state, operation);
      if (
        (target.outcome === "crashed-before" || target.outcome === "crashed-after") &&
        target.state.unreclaimedAttempts > state.assumptions.maxConcurrentPublishers
      ) {
        return true;
      }
    }
  }
  return false;
}

function modelRuns(builder: ModelScheduleBuilder): readonly ModelGeneratedRun[] {
  return [...builder.runsByLevel.entries()]
    .toSorted(([left], [right]) => left - right)
    .flatMap(([, runs]) => runs);
}

function modelEmitRun(builder: ModelScheduleBuilder): boolean {
  const levelRuns = builder.runsByLevel.get(0) ?? [];
  if (
    builder.unrunSequences.length === 0 ||
    builder.assumptions.maxActiveLevels < 1 ||
    levelRuns.length >= builder.assumptions.maxRunsPerLevel ||
    !modelHasCapacity(builder, 1)
  ) {
    return false;
  }
  const runId = `generated-${builder.nextRun}`;
  const sequences = [...builder.unrunSequences];
  const operation: ModelOperation = {
    kind: "emit-run",
    operationId: `emit-${runId}`,
    runId,
    level: 0,
    sequences,
  };
  if (!modelPushBoundedOperation(builder, operation)) {
    return false;
  }
  builder.nextRun += 1;
  levelRuns.push({ key: `runs/${runId}`, level: 0, sequences });
  builder.runsByLevel.set(0, levelRuns);
  builder.unrunSequences.length = 0;
  return true;
}

function modelMergeRuns(builder: ModelScheduleBuilder): boolean {
  const sourceLevel = [...builder.runsByLevel.entries()]
    .toSorted(([left], [right]) => left - right)
    .find(
      ([level, runs]) =>
        runs.length >= 2 &&
        level + 1 < builder.assumptions.maxActiveLevels &&
        (builder.runsByLevel.get(level + 1)?.length ?? 0) < builder.assumptions.maxRunsPerLevel,
    )?.[0];
  if (sourceLevel === undefined || !modelHasCapacity(builder, 1)) {
    return false;
  }
  const inputs = builder.runsByLevel.get(sourceLevel) ?? [];
  const targetLevel = sourceLevel + 1;
  const outputs = builder.runsByLevel.get(targetLevel) ?? [];
  const selected = inputs.slice(0, 2);
  const runId = `generated-${builder.nextRun}`;
  const sequences = [...new Set(selected.flatMap(({ sequences: values }) => values))].toSorted(
    (left, right) => left - right,
  );
  const operation: ModelOperation = {
    kind: "merge-runs",
    operationId: `merge-${runId}`,
    mergeId: runId,
    inputRunKeys: selected.map(({ key }) => key),
    outputRunId: runId,
    targetLevel,
  };
  if (!modelPushBoundedOperation(builder, operation)) {
    return false;
  }
  builder.nextRun += 1;
  builder.runsByLevel.set(sourceLevel, inputs.slice(2));
  outputs.push({ key: `runs/${runId}`, level: targetLevel, sequences });
  builder.runsByLevel.set(targetLevel, outputs);
  return true;
}

// The `0` floor is a generator-side simplification, not the empty sentinel:
// generated mutations are numbered from 1 (see `modelMutationWorkloadArbitrary`),
// so a publication that folds nothing and one that folds sequence 0 are
// indistinguishable here — and neither is reachable, because no generated
// schedule ever acknowledges a sequence-0 entry. Consumers reading a *missing*
// manifest use `MODEL_NOTHING_FOLDED` instead, which does distinguish them.
// Widening the generated sequence domain to include 0 would make this floor
// load-bearing and is deliberately left as a separate coverage change.
function modelFoldedThrough(builder: ModelScheduleBuilder): number {
  return Math.max(0, ...modelRuns(builder).flatMap(({ sequences }) => sequences));
}

function modelRemoveFoldedSuffix(builder: ModelScheduleBuilder, foldedThrough: number): void {
  const retained = builder.suffixSequences.filter((sequence) => sequence > foldedThrough);
  builder.suffixSequences.splice(0, builder.suffixSequences.length, ...retained);
}

function modelPublishRoot(builder: ModelScheduleBuilder, role: "tail" | "base"): boolean {
  const runs = modelRuns(builder);
  if (
    runs.length === 0 ||
    builder.assumptions.maxConcurrentPublishers < 1 ||
    !modelHasCapacity(builder, 1)
  ) {
    return false;
  }
  const publicationId = `${role}-generated-${builder.nextPublication}`;
  const foldedThrough = modelFoldedThrough(builder);
  const operation: ModelOperation = {
    kind: "publish-root",
    operationId: publicationId,
    ...modelPublication(
      publicationId,
      builder.generation,
      runs.map(({ key }) => key),
      foldedThrough,
      role,
    ),
  };
  if (!modelPushBoundedOperation(builder, operation)) {
    return false;
  }
  builder.nextPublication += 1;
  builder.generation += 1;
  modelRemoveFoldedSuffix(builder, foldedThrough);
  return true;
}

function modelLoseCas(builder: ModelScheduleBuilder): boolean {
  const runs = modelRuns(builder);
  if (
    runs.length === 0 ||
    builder.assumptions.maxConcurrentPublishers < 2 ||
    !modelHasCapacity(builder, 1)
  ) {
    return false;
  }
  const publicationId = `winner-generated-${builder.nextPublication}`;
  const foldedThrough = modelFoldedThrough(builder);
  const winner = modelPublication(
    publicationId,
    builder.generation,
    runs.map(({ key }) => key),
    foldedThrough,
    "tail",
  );
  const operation: ModelOperation = {
    kind: "lose-publication-cas",
    operationId: `cas-generated-${builder.nextPublication + 1}`,
    winner,
    loser: {
      ...winner,
      publicationId: `loser-generated-${builder.nextPublication + 1}`,
      role: "base",
    },
  };
  if (!modelPushBoundedOperation(builder, operation)) {
    return false;
  }
  builder.nextPublication += 1;
  builder.generation += 1;
  modelRemoveFoldedSuffix(builder, foldedThrough);
  return true;
}

function modelMaintenance(builder: ModelScheduleBuilder, first: "tail" | "base"): boolean {
  if (!modelHasCapacity(builder, 2) || modelRuns(builder).length === 0) {
    return false;
  }
  const second = first === "tail" ? "base" : "tail";
  return modelPublishRoot(builder, first) && modelPublishRoot(builder, second);
}

function modelCrashReclaim(builder: ModelScheduleBuilder, boundary: ModelCrashBoundary): boolean {
  if (!modelHasCapacity(builder, 3)) {
    return false;
  }
  const index = builder.nextCrash++;
  const targetOperationId = `reclaim-crash-target-${index}`;
  modelApplyBuiltOperation(builder, {
    kind: "crash",
    operationId: `crash-generated-${index}`,
    targetOperationId,
    durableEffectIndex: 0,
    boundary,
  });
  modelApplyBuiltOperation(builder, {
    kind: "reclaim",
    operationId: targetOperationId,
    candidateKeys: [`runs/orphan-crash-${index}`],
  });
  modelApplyBuiltOperation(builder, {
    kind: "retry",
    operationId: `retry-generated-${index}`,
    targetOperationId,
  });
  return true;
}

function modelReconstruct(builder: ModelScheduleBuilder, choice: number): boolean {
  if (!modelHasCapacity(builder, 1)) {
    return false;
  }
  const modes = ["cold", "warm", "reference"] as const;
  modelApplyBuiltOperation(builder, {
    kind: "reconstruct",
    operationId: `reconstruct-generated-${builder.nextReconstruct++}`,
    mode: modes[choice % modes.length] as (typeof modes)[number],
  });
  return true;
}

function modelReclaim(builder: ModelScheduleBuilder): boolean {
  if (!modelHasCapacity(builder, 1)) {
    return false;
  }
  const index = builder.nextReclaim++;
  modelApplyBuiltOperation(builder, {
    kind: "reclaim",
    operationId: `reclaim-generated-${index}`,
    candidateKeys: [`runs/orphan-generated-${index}`],
  });
  return true;
}

function modelValidActions(builder: ModelScheduleBuilder): readonly ModelGeneratedAction[] {
  const actions: ModelGeneratedAction[] = ["reconstruct", "reclaim"];
  const levelZeroRuns = builder.runsByLevel.get(0) ?? [];
  if (
    builder.unrunSequences.length > 0 &&
    builder.assumptions.maxActiveLevels > 0 &&
    levelZeroRuns.length < builder.assumptions.maxRunsPerLevel
  ) {
    actions.push("emit", "emit", "emit", "emit");
  }
  const hasEligibleMerge = [...builder.runsByLevel.entries()].some(
    ([level, runs]) =>
      runs.length >= 2 &&
      level + 1 < builder.assumptions.maxActiveLevels &&
      (builder.runsByLevel.get(level + 1)?.length ?? 0) < builder.assumptions.maxRunsPerLevel,
  );
  if (hasEligibleMerge) {
    actions.push("merge", "merge", "merge", "merge");
  }
  if (modelRuns(builder).length > 0 && builder.assumptions.maxConcurrentPublishers > 0) {
    actions.push("publish", "tail-base", "base-tail");
    if (builder.assumptions.maxConcurrentPublishers > 1) {
      actions.push("cas");
    }
  }
  if (modelHasCapacity(builder, 3)) {
    actions.push("crash");
  }
  return actions;
}

function modelApplyAction(
  builder: ModelScheduleBuilder,
  action: ModelGeneratedAction,
  choice: number,
): boolean {
  switch (action) {
    case "emit": {
      return modelEmitRun(builder);
    }
    case "merge": {
      return modelMergeRuns(builder);
    }
    case "publish": {
      return modelPublishRoot(builder, choice % 2 === 0 ? "tail" : "base");
    }
    case "cas": {
      return modelLoseCas(builder);
    }
    case "tail-base": {
      return modelMaintenance(builder, "tail");
    }
    case "base-tail": {
      return modelMaintenance(builder, "base");
    }
    case "crash": {
      return modelCrashReclaim(builder, choice % 2 === 0 ? "before" : "after");
    }
    case "reconstruct": {
      return modelReconstruct(builder, choice);
    }
    case "reclaim": {
      return modelReclaim(builder);
    }
  }
}

function modelFoldForPressure(builder: ModelScheduleBuilder): boolean {
  if (builder.suffixSequences.length < builder.assumptions.maxCommittedSuffixEntries) {
    return true;
  }
  // Fold the unrun sequences into a level-0 run. The usual reason that fails is
  // a level 0 already at `maxRunsPerLevel`, which a merge drains into the
  // successor level, so retry the emit once that room exists. All three calls
  // are allowed to fail: whether the fold relieved enough pressure to admit the
  // append is decided by the guards below, not by any one of these outcomes.
  const emitted = modelEmitRun(builder);
  if (!emitted) {
    const drainedLevelZero = modelMergeRuns(builder);
    if (drainedLevelZero) {
      modelEmitRun(builder);
    }
  }
  if (builder.unrunSequences.length > 0 && modelRuns(builder).length > 0) {
    if (!modelPublishRoot(builder, "tail")) {
      return false;
    }
    if (!modelEmitRun(builder)) {
      return false;
    }
  }
  if (builder.unrunSequences.length > 0) {
    return false;
  }
  if (!modelPublishRoot(builder, "tail")) {
    return false;
  }
  modelReclaim(builder);
  return builder.suffixSequences.length < builder.assumptions.maxCommittedSuffixEntries;
}

function modelAppendMutation(builder: ModelScheduleBuilder, mutation: ModelMutation): boolean {
  if (!modelHasCapacity(builder, 1)) {
    return false;
  }
  const underSuffixPressure =
    builder.suffixSequences.length >= builder.assumptions.maxCommittedSuffixEntries;
  if (underSuffixPressure && !modelFoldForPressure(builder)) {
    return false;
  }
  // The pressure fold appends its own operations, so the capacity checked above
  // can be spent by the time the append itself is pushed. Re-test rather than
  // relying on the pre-fold result.
  if (!modelHasCapacity(builder, 1)) {
    return false;
  }
  const operation: ModelAppendLogOperation = {
    kind: "append-log",
    operationId: `append-${mutation.sequence}`,
    mutation,
    acknowledgement: "acknowledge",
  };
  if (!modelPushBoundedOperation(builder, operation)) {
    return false;
  }
  builder.suffixSequences.push(mutation.sequence);
  builder.unrunSequences.push(mutation.sequence);
  return true;
}

function buildModelGeneratedOperations(
  assumptions: ModelWorkloadAssumptions,
  mutations: readonly ModelMutation[],
  choices: readonly number[],
): readonly ModelOperation[] {
  const builder: ModelScheduleBuilder = {
    assumptions,
    operationLimit: Math.max(0, assumptions.maxScheduleOperations - 2),
    operations: [],
    runsByLevel: new Map(),
    suffixSequences: [],
    unrunSequences: [],
    state: initialModelState(assumptions),
    generation: 0,
    nextRun: 0,
    nextPublication: 0,
    nextCrash: 0,
    nextReconstruct: 0,
    nextReclaim: 0,
  };

  for (const [index, mutation] of mutations.entries()) {
    if (!modelAppendMutation(builder, mutation)) {
      break;
    }
    const choice = choices[index] ?? 0;
    const actions = modelValidActions(builder);
    modelApplyAction(builder, actions[choice % actions.length] as ModelGeneratedAction, choice);
  }

  for (const choice of choices.slice(mutations.length)) {
    const actions = modelValidActions(builder);
    if (
      !modelApplyAction(builder, actions[choice % actions.length] as ModelGeneratedAction, choice)
    ) {
      break;
    }
  }
  return builder.operations;
}

export const modelScenarioArbitrary = (
  assumptions: ModelWorkloadAssumptions = DEFAULT_MODEL_ASSUMPTIONS,
): fc.Arbitrary<ModelScenario> =>
  modelMutationWorkloadArbitrary(assumptions).chain((mutations) => {
    const maxChoices = Math.max(0, Math.min(20, assumptions.maxScheduleOperations));
    return fc
      .array(fc.nat({ max: 1_000 }), { minLength: Math.min(8, maxChoices), maxLength: maxChoices })
      .map((choices) => ({
        assumptions,
        operations: buildModelGeneratedOperations(assumptions, mutations, choices),
      }));
  });

export const modelScenarioWithDroppedAppendArbitrary = (
  assumptions: ModelWorkloadAssumptions = DEFAULT_MODEL_ASSUMPTIONS,
): fc.Arbitrary<ModelScenario> => {
  if (
    assumptions.maxLiveDocuments < 1 ||
    assumptions.maxConcurrentPublishers < 1 ||
    assumptions.maxScheduleOperations < 2
  ) {
    throw new RangeError(
      "dropped-append evidence requires one document, publisher, and two operations",
    );
  }
  return modelScenarioArbitrary(assumptions).map((scenario) => ({
    assumptions,
    operations: [
      {
        kind: "append-log" as const,
        operationId: "append-required-dropped",
        mutation: {
          mutationId: "required-dropped",
          sequence: 0,
          documentId: "doc-0",
          change: { kind: "put" as const, value: 9 },
        },
        acknowledgement: "drop" as const,
      },
      {
        kind: "reclaim" as const,
        operationId: "reclaim-required-dropped",
        candidateKeys: ["content/required-dropped", "log/0"],
      },
      ...scenario.operations,
    ],
  }));
};

const canonicalMutation = (sequence: number, documentId = "doc-0"): ModelMutation => ({
  mutationId: `mutation-${sequence}`,
  sequence,
  documentId,
  change: { kind: "put", value: sequence },
});

const canonicalAppend = (sequence: number): ModelAppendLogOperation => ({
  kind: "append-log",
  operationId: `append-${sequence}`,
  mutation: canonicalMutation(sequence),
  acknowledgement: "acknowledge",
});

const canonicalRunSetup = (): readonly ModelOperation[] => [
  canonicalAppend(1),
  {
    kind: "emit-run",
    operationId: "emit-canonical",
    runId: "canonical",
    level: 0,
    sequences: [1],
  },
];

function canonicalThreeLevelScenario(assumptions: ModelWorkloadAssumptions): ModelScenario | null {
  if (
    assumptions.maxActiveLevels < 3 ||
    assumptions.maxRunsPerLevel < 2 ||
    assumptions.maxLiveDocuments < 1 ||
    assumptions.maxCommittedSuffixEntries < 2 ||
    assumptions.maxConcurrentPublishers < 2 ||
    assumptions.maxScheduleOperations < 27
  ) {
    return null;
  }
  const operations: ModelOperation[] = [];
  let state = initialModelState(assumptions);
  const activeRuns = new Map<number, string[]>();

  const apply = (operation: ModelOperation): void => {
    operations.push(operation);
    state = executeModelOperation(state, operation).state;
  };
  const appendAndEmit = (sequence: number): void => {
    const append = canonicalAppend(sequence);
    apply({
      ...append,
      mutation: { ...append.mutation, change: { kind: "delete" } },
    });
    const runId = `three-level-0-${sequence}`;
    apply({
      kind: "emit-run",
      operationId: `emit-${runId}`,
      runId,
      level: 0,
      sequences: [sequence],
    });
    activeRuns.set(0, [...(activeRuns.get(0) ?? []), `runs/${runId}`]);
  };
  const mergeLevel = (sourceLevel: number, outputRunId: string): void => {
    const inputs = activeRuns.get(sourceLevel) ?? [];
    apply({
      kind: "merge-runs",
      operationId: `merge-${outputRunId}`,
      mergeId: outputRunId,
      inputRunKeys: inputs.slice(0, 2),
      outputRunId,
      targetLevel: sourceLevel + 1,
    });
    activeRuns.set(sourceLevel, inputs.slice(2));
    activeRuns.set(sourceLevel + 1, [
      ...(activeRuns.get(sourceLevel + 1) ?? []),
      `runs/${outputRunId}`,
    ]);
  };
  const publishAndReclaim = (publicationId: string, foldedThrough: number): void => {
    const runKeys = [...activeRuns.entries()]
      .toSorted(([left], [right]) => left - right)
      .flatMap(([, keys]) => keys);
    apply({
      kind: "publish-root",
      operationId: publicationId,
      ...modelPublication(
        publicationId,
        state.store.root.generation,
        runKeys,
        foldedThrough,
        "tail",
      ),
    });
    const candidateKeys = modelOwnedReclaimCandidates(state, new Set(runKeys));
    if (candidateKeys.length > 0) {
      apply({
        kind: "reclaim",
        operationId: `reclaim-${publicationId}`,
        candidateKeys,
      });
    }
  };

  appendAndEmit(1);
  appendAndEmit(2);
  mergeLevel(0, "three-level-1-a");
  publishAndReclaim("publish-three-level-stage-1", 2);
  appendAndEmit(3);
  appendAndEmit(4);
  mergeLevel(0, "three-level-1-b");
  publishAndReclaim("publish-three-level-stage-2", 4);
  mergeLevel(1, "three-level-2");
  publishAndReclaim("publish-three-level-stage-3", 4);
  appendAndEmit(5);
  appendAndEmit(6);
  mergeLevel(0, "three-level-1-c");
  publishAndReclaim("publish-three-level-stage-4", 6);
  appendAndEmit(7);

  const finalRunKeys = [...activeRuns.entries()]
    .toSorted(([left], [right]) => left - right)
    .flatMap(([, keys]) => keys);
  apply({
    kind: "publish-root",
    operationId: "publish-three-levels",
    ...modelPublication(
      "publish-three-levels",
      state.store.root.generation,
      finalRunKeys,
      7,
      "tail",
    ),
  });
  return { assumptions, operations };
}

export const canonicalModelCoverageScenarios = (
  assumptions: ModelWorkloadAssumptions = DEFAULT_MODEL_ASSUMPTIONS,
): readonly ModelScenario[] => {
  validateModelFullSuiteAssumptions(assumptions);
  const scenario = (operations: readonly ModelOperation[]): ModelScenario => ({
    assumptions,
    operations,
  });
  const canonicalRun = ["runs/canonical"];
  const pressurePrefix: readonly ModelOperation[] = [
    ...canonicalRunSetup(),
    {
      kind: "publish-root",
      operationId: "pressure-publish-1",
      ...modelPublication("pressure-publish-1", 0, canonicalRun, 1, "tail"),
    },
    {
      kind: "publish-root",
      operationId: "pressure-publish-2",
      ...modelPublication("pressure-publish-2", 1, canonicalRun, 1, "base"),
    },
  ];
  const pressureState = runModelSchedule(initialModelState(assumptions), pressurePrefix).final;
  const pressureCandidateKeys = modelOwnedReclaimCandidates(pressureState, new Set(canonicalRun));
  const threeLevelScenario = canonicalThreeLevelScenario(assumptions);

  return [
    scenario([
      ...canonicalRunSetup(),
      {
        kind: "lose-publication-cas",
        operationId: "concurrent-publication",
        winner: modelPublication("winner-publish", 0, canonicalRun, 1, "tail"),
        loser: modelPublication("loser-publish", 0, canonicalRun, 1, "base"),
      },
    ]),
    scenario([
      ...canonicalRunSetup(),
      {
        kind: "publish-root",
        operationId: "tail-publish",
        ...modelPublication("tail-publish", 0, canonicalRun, 1, "tail"),
      },
      {
        kind: "merge-runs",
        operationId: "base-merge-after-tail",
        mergeId: "base-merge-after-tail",
        inputRunKeys: canonicalRun,
        outputRunId: "base-after-tail",
        targetLevel: 1,
      },
    ]),
    scenario([
      ...canonicalRunSetup(),
      {
        kind: "merge-runs",
        operationId: "base-merge-before-tail",
        mergeId: "base-merge-before-tail",
        inputRunKeys: canonicalRun,
        outputRunId: "base-before-tail",
        targetLevel: 1,
      },
      {
        kind: "publish-root",
        operationId: "tail-publish",
        ...modelPublication("tail-publish", 0, ["runs/base-before-tail"], 1, "tail"),
      },
    ]),
    ...(assumptions.maxScheduleOperations < 6
      ? []
      : [
          scenario([
            ...pressurePrefix,
            {
              kind: "reclaim",
              operationId: "pressure-reclaim",
              candidateKeys: pressureCandidateKeys,
            },
            {
              kind: "publish-root",
              operationId: "pressure-publish-3",
              ...modelPublication("pressure-publish-3", 2, canonicalRun, 1, "tail"),
            },
          ]),
        ]),
    scenario([
      {
        kind: "crash",
        operationId: "canonical-crash",
        targetOperationId: "append-1",
        durableEffectIndex: 0,
        boundary: "before",
      },
      canonicalAppend(1),
      { kind: "retry", operationId: "canonical-retry", targetOperationId: "append-1" },
    ]),
    scenario([
      {
        kind: "publish-root",
        operationId: "reject-incomplete-publish",
        ...modelPublication("reject-incomplete-publish", 0, ["runs/incomplete"], 0, "tail"),
      },
    ]),
    scenario([
      {
        kind: "merge-runs",
        operationId: "reject-missing-merge",
        mergeId: "reject-missing-merge",
        inputRunKeys: ["runs/missing"],
        outputRunId: "missing-output",
        targetLevel: 1,
      },
    ]),
    scenario([
      {
        kind: "merge-runs",
        operationId: "reject-overflow-merge",
        mergeId: "reject-overflow-merge",
        inputRunKeys: [],
        outputRunId: "overflow-output",
        targetLevel: assumptions.maxActiveLevels,
      },
    ]),
    scenario([
      canonicalAppend(1),
      { kind: "retry", operationId: "reject-retry", targetOperationId: "append-1" },
    ]),
    scenario([
      canonicalAppend(1),
      {
        kind: "reclaim",
        operationId: "reject-reachable-reclaim",
        candidateKeys: ["log/1"],
      },
    ]),
    ...(threeLevelScenario === null ? [] : [threeLevelScenario]),
  ];
};

export const enumerateModelCrashSchedules = (scenario: ModelScenario): readonly ModelScenario[] => {
  const operations = scenario.operations.filter(({ kind }) => kind !== "crash" && kind !== "retry");
  const run = runModelSchedule(initialModelState(scenario.assumptions), operations);
  const schedules: ModelScenario[] = [];
  const appliedEffects = new Set(
    run.final.store.durableTrace
      .filter(({ outcome }) => outcome === "applied" || outcome === "crashed-after")
      .map(({ operationId, effectIndex }) => `${operationId}/${effectIndex}`),
  );

  for (const transition of run.transitions) {
    for (const effectIndex of transition.durableEffects.keys()) {
      if (!appliedEffects.has(`${transition.operation.operationId}/${effectIndex}`)) {
        continue;
      }
      for (const boundary of ["before", "after"] as const) {
        const source = transition.operation;
        const operationIndex = operations.findIndex(
          ({ operationId }) => operationId === source.operationId,
        );
        const crashScenario: ModelScenario = {
          assumptions: scenario.assumptions,
          operations: [
            ...operations.slice(0, operationIndex),
            {
              kind: "crash",
              operationId: `crash-${source.operationId}-${effectIndex}-${boundary}`,
              targetOperationId: source.operationId,
              durableEffectIndex: effectIndex,
              boundary,
            },
            source,
            {
              kind: "retry",
              operationId: `retry-${source.operationId}-${effectIndex}-${boundary}`,
              targetOperationId: source.operationId,
            },
            ...operations.slice(operationIndex + 1),
          ],
        };
        modelDerivedCrashScheduleSources.set(crashScenario, operations.length);
        schedules.push(crashScenario);
      }
    }
  }
  return schedules;
};
