import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  canonicalModelCoverageScenarios,
  enumerateModelCrashSchedules,
  modelScenarioArbitrary,
  type ModelScenario,
} from "./arbitraries.ts";
import { executeModelOperation, initialModelState, runModelSchedule } from "./executor.ts";
import { reachableModelObjectKeys } from "./model-store.ts";
import {
  MODEL_REJECTED_ARMS,
  classifyModelRejectedArm,
  type ModelRejectedArmId,
} from "./rejected-arms.ts";
import {
  DEFAULT_MODEL_ASSUMPTIONS,
  MINIMUM_MODEL_FULL_SUITE_ASSUMPTIONS,
  MODEL_NOTHING_FOLDED,
  MODEL_OPERATION_KINDS,
  type ModelOperation,
  type ModelState,
  type ModelWorkloadAssumptions,
} from "./types.ts";

/**
 * Golden pin for the exported minimum envelope. The envelope tests below assert
 * against the exported constant rather than a local copy, so that a widened
 * export cannot leave them silently reporting on an envelope nobody claimed.
 * This one test carries the literal values, so moving the export is a decision
 * that has to be made here rather than a change that lands unremarked.
 */
test("the exported minimum full-suite envelope is the one these tests pin", () => {
  expect(MINIMUM_MODEL_FULL_SUITE_ASSUMPTIONS).toEqual({
    maxLiveDocuments: 1,
    maxActiveLevels: 2,
    maxRunsPerLevel: 1,
    maxCommittedSuffixEntries: 1,
    maxConcurrentPublishers: 2,
    maxScheduleOperations: 4,
  } satisfies ModelWorkloadAssumptions);
});

function assertStateBounds(state: ModelState): void {
  const manifest =
    state.store.root.manifestKey === null
      ? null
      : state.store.objects.get(state.store.root.manifestKey);
  const levels = manifest?.kind === "manifest" ? manifest.levels : [];
  const foldedThrough =
    manifest?.kind === "manifest" ? manifest.foldedThrough : MODEL_NOTHING_FOLDED;
  const committedSuffixEntries = [...state.store.objects.values()].filter(
    (object) => object.kind === "ack" && object.sequence > foldedThrough,
  ).length;

  expect(levels.length).toBeLessThanOrEqual(state.assumptions.maxActiveLevels);
  expect(levels.every(({ runKeys }) => runKeys.length <= state.assumptions.maxRunsPerLevel)).toBe(
    true,
  );
  expect(committedSuffixEntries).toBeLessThanOrEqual(state.assumptions.maxCommittedSuffixEntries);
  expect(state.unreclaimedAttempts).toBeLessThanOrEqual(state.assumptions.maxConcurrentPublishers);
}

function assertScenarioBounds(scenario: ModelScenario): void {
  const { assumptions, operations } = scenario;
  const appends = operations.filter(
    (operation): operation is Extract<ModelOperation, { readonly kind: "append-log" }> =>
      operation.kind === "append-log",
  );
  const documentIds = new Set(appends.map(({ mutation }) => mutation.documentId));

  for (const operation of operations) {
    if (operation.kind === "publish-root" || operation.kind === "lose-publication-cas") {
      const publisherCount = operation.kind === "lose-publication-cas" ? 2 : 1;
      expect(publisherCount).toBeLessThanOrEqual(assumptions.maxConcurrentPublishers);
    }
  }

  expect(operations.length).toBeLessThanOrEqual(assumptions.maxScheduleOperations);
  expect(documentIds.size).toBeLessThanOrEqual(assumptions.maxLiveDocuments);
  expect([...documentIds].every((documentId) => /^doc-[0-7]$/.test(documentId))).toBe(true);
  expect(appends.map(({ mutation }) => mutation.sequence)).toEqual(
    appends.map((_, index) => index + 1),
  );

  const run = runModelSchedule(initialModelState(assumptions), operations);
  for (const modelState of [
    run.initial,
    ...run.transitions.map(({ state: transitionState }) => transitionState),
  ]) {
    assertStateBounds(modelState);
  }
}

function classifiedRejections(scenario: ModelScenario): readonly ModelRejectedArmId[] {
  const rejectionIds: ModelRejectedArmId[] = [];
  let state = initialModelState(scenario.assumptions);
  for (const operation of scenario.operations) {
    const rejectionId = classifyModelRejectedArm(state, operation);
    if (rejectionId !== null) {
      expect(MODEL_REJECTED_ARMS).toContain(rejectionId);
      rejectionIds.push(rejectionId);
    }
    state = executeModelOperation(state, operation).state;
  }
  return rejectionIds;
}

describe("generated multilevel model scenarios", () => {
  test("preserves all workload assumptions and append numbering while shrinking", () => {
    fc.assert(
      fc.property(modelScenarioArbitrary(), (scenario) => {
        assertScenarioBounds(scenario);
        expect(classifiedRejections(scenario)).toEqual([]);
      }),
      {
        numRuns: Number(process.env["FC_NUM_RUNS"] ?? 200),
        seed: 20_260_803,
      },
    );
  });

  test("covers all nine operation kinds without depending on random samples", () => {
    const samples = fc.sample(modelScenarioArbitrary(), { numRuns: 200, seed: 20_260_803 });
    const operationKinds = new Set(
      [...samples, ...canonicalModelCoverageScenarios()].flatMap(({ operations }) =>
        operations.map(({ kind }) => kind),
      ),
    );

    expect(operationKinds).toEqual(new Set(MODEL_OPERATION_KINDS));
  });

  test("varies central choices instead of injecting one canned action bundle", () => {
    const samples = fc.sample(modelScenarioArbitrary(), { numRuns: 500, seed: 20_260_803 });
    const multiMutationSamples = samples.filter(
      ({ operations }) => operations.filter(({ kind }) => kind === "append-log").length >= 2,
    );

    expect(
      multiMutationSamples.some(({ operations }) => {
        const kinds = new Set(operations.map(({ kind }) => kind));
        const roles = new Set(
          operations.flatMap((operation) =>
            operation.kind === "publish-root" ? [operation.role] : [],
          ),
        );
        return (
          !kinds.has("merge-runs") ||
          !kinds.has("lose-publication-cas") ||
          !kinds.has("crash") ||
          !roles.has("tail") ||
          !roles.has("base")
        );
      }),
    ).toBe(true);
  });

  test("preserves the committed suffix when CAS folds only part of the workload", () => {
    const assumptions = { ...DEFAULT_MODEL_ASSUMPTIONS, maxRunsPerLevel: 1 };

    fc.assert(
      fc.property(modelScenarioArbitrary(assumptions), (scenario) => {
        assertScenarioBounds(scenario);
        expect(classifiedRejections(scenario)).toEqual([]);
      }),
      { numRuns: 200, seed: 20_260_803 },
    );
  });

  test("generates merges into every eligible successor level", () => {
    const targetLevels = new Set(
      fc
        .sample(modelScenarioArbitrary(), { numRuns: 2_000, seed: 20_260_803 })
        .flatMap(({ operations }) =>
          operations.flatMap((operation) =>
            operation.kind === "merge-runs" ? [operation.targetLevel] : [],
          ),
        ),
    );

    expect(targetLevels).toEqual(new Set([1, 2]));
  });
});

test("canonical scenarios exercise publication outcomes, both maintenance orders, and exact IDs", () => {
  const scenarios = canonicalModelCoverageScenarios();
  const coverage = scenarios.map((scenario) =>
    runModelSchedule(initialModelState(scenario.assumptions), scenario.operations),
  );
  const operationIds = scenarios.flatMap(({ operations }) =>
    operations.flatMap((operation) => {
      if (operation.kind === "lose-publication-cas") {
        return [operation.winner.publicationId, operation.loser.publicationId];
      }
      return [operation.operationId];
    }),
  );

  expect(operationIds).toEqual(
    expect.arrayContaining([
      "tail-publish",
      "base-merge-before-tail",
      "winner-publish",
      "loser-publish",
    ]),
  );
  expect(
    new Set(coverage.flatMap(({ final }) => Array.from(final.coverage.publicationOutcomes))),
  ).toEqual(new Set(["win", "lose"]));
  expect(
    new Set(coverage.flatMap(({ final }) => Array.from(final.coverage.maintenanceOrders))),
  ).toEqual(new Set(["tail-before-base", "base-before-tail"]));
});

test("canonical sources fit and execute within the exact minimum full-suite envelope", () => {
  const scenarios = canonicalModelCoverageScenarios(MINIMUM_MODEL_FULL_SUITE_ASSUMPTIONS);

  expect(
    scenarios.every(
      ({ operations }) =>
        operations.length <= MINIMUM_MODEL_FULL_SUITE_ASSUMPTIONS.maxScheduleOperations,
    ),
  ).toBe(true);
  expect(
    scenarios.some(({ operations }) =>
      operations.some(({ operationId }) => operationId.startsWith("pressure-")),
    ),
  ).toBe(false);
  expect(
    scenarios.some(({ operations }) =>
      operations.some(({ operationId }) => operationId === "publish-three-levels"),
    ),
  ).toBe(false);
  for (const scenario of scenarios) {
    assertScenarioBounds(scenario);
  }

  const tailBeforeBase = scenarios.find(({ operations }) =>
    operations.some(({ operationId }) => operationId === "base-merge-after-tail"),
  );
  const baseBeforeTail = scenarios.find(({ operations }) =>
    operations.some(({ operationId }) => operationId === "base-merge-before-tail"),
  );
  expect(tailBeforeBase?.operations.map(({ kind }) => kind)).toEqual([
    "append-log",
    "emit-run",
    "publish-root",
    "merge-runs",
  ]);
  expect(baseBeforeTail?.operations.map(({ kind }) => kind)).toEqual([
    "append-log",
    "emit-run",
    "merge-runs",
    "publish-root",
  ]);
});

test("includes pressure only when the source cap reaches six operations", () => {
  const hasPressure = (maxScheduleOperations: number): boolean =>
    canonicalModelCoverageScenarios({
      ...MINIMUM_MODEL_FULL_SUITE_ASSUMPTIONS,
      maxScheduleOperations,
    }).some(({ operations }) =>
      operations.some(({ operationId }) => operationId === "pressure-publish-3"),
    );

  expect(hasPressure(4)).toBe(false);
  expect(hasPressure(5)).toBe(false);
  expect(hasPressure(6)).toBe(true);
});

test("the optional three-level witness reuses doc-0 under D=1", () => {
  const assumptions = {
    ...MINIMUM_MODEL_FULL_SUITE_ASSUMPTIONS,
    maxActiveLevels: 3,
    maxRunsPerLevel: 2,
    maxCommittedSuffixEntries: 2,
    maxScheduleOperations: 27,
  };
  const scenario = canonicalModelCoverageScenarios(assumptions).find(({ operations }) =>
    operations.some(({ operationId }) => operationId === "publish-three-levels"),
  );

  expect(scenario).toBeDefined();
  if (scenario === undefined) {
    return;
  }
  expect(
    new Set(
      scenario.operations.flatMap((operation) =>
        operation.kind === "append-log" ? [operation.mutation.documentId] : [],
      ),
    ),
  ).toEqual(new Set(["doc-0"]));
  expect(scenario.operations).toHaveLength(27);
  assertScenarioBounds(scenario);
});

test("canonical execution publishes three active levels within every bound", () => {
  const scenario = canonicalModelCoverageScenarios().find(({ operations }) =>
    operations.some(({ operationId }) => operationId === "publish-three-levels"),
  );

  expect(scenario).toBeDefined();
  if (scenario === undefined) {
    return;
  }
  assertScenarioBounds(scenario);
  const run = runModelSchedule(initialModelState(scenario.assumptions), scenario.operations);
  const manifestKey = run.final.store.root.manifestKey;
  const manifest = manifestKey === null ? undefined : run.final.store.objects.get(manifestKey);

  expect(manifest?.kind).toBe("manifest");
  if (manifest?.kind !== "manifest") {
    return;
  }
  expect(manifest.levels.map(({ level }) => level)).toEqual([0, 1, 2]);
  expect(manifest.levels.every(({ runKeys }) => runKeys.length === 1)).toBe(true);
});

test("canonical scenarios hit every and only registered rejected arm", () => {
  const scenarios = canonicalModelCoverageScenarios();
  const rejectionIds = new Set(scenarios.flatMap(classifiedRejections));

  expect(rejectionIds).toEqual(new Set(MODEL_REJECTED_ARMS));

  for (const scenario of scenarios) {
    let state = initialModelState(scenario.assumptions);
    for (const operation of scenario.operations) {
      const classification = classifyModelRejectedArm(state, operation);
      const transition = executeModelOperation(state, operation);
      if (classification !== null) {
        expect(transition.outcome).toBe("rejected");
        expect(transition.rejectionId).toBe(classification);
        expect(transition.state.coverage.rejectedArms.has(classification)).toBe(true);
      }
      state = transition.state;
    }
  }
});

test("canonical ownership pressure reclaims two attempts before a third publication", () => {
  const scenario = canonicalModelCoverageScenarios().find(({ operations }) =>
    operations.some(({ operationId }) => operationId === "pressure-publish-3"),
  );

  expect(scenario).toBeDefined();
  if (scenario === undefined) {
    return;
  }
  const reclaimIndex = scenario.operations.findIndex(
    ({ operationId }) => operationId === "pressure-reclaim",
  );
  const reclaim = scenario.operations[reclaimIndex];
  const beforeReclaim = runModelSchedule(
    initialModelState(scenario.assumptions),
    scenario.operations.slice(0, reclaimIndex),
  ).final;
  const expectedCandidateKeys = [...beforeReclaim.unreclaimedByAttempt.values()]
    .flatMap((keys) => Array.from(keys))
    .toSorted();
  const reachableKeys = reachableModelObjectKeys(beforeReclaim.store);

  expect(reclaim?.kind).toBe("reclaim");
  if (reclaim?.kind !== "reclaim") {
    return;
  }
  expect(reachableKeys.has("content/mutation-1")).toBe(true);
  expect(reclaim.candidateKeys).toEqual(expectedCandidateKeys);
  expect(reclaim.candidateKeys.every((key) => !reachableKeys.has(key))).toBe(true);

  const run = runModelSchedule(initialModelState(scenario.assumptions), scenario.operations);
  const pressureTransitions = run.transitions.filter(({ operation }) =>
    operation.operationId.startsWith("pressure-"),
  );

  expect(pressureTransitions.map(({ operation }) => operation.operationId)).toEqual([
    "pressure-publish-1",
    "pressure-publish-2",
    "pressure-reclaim",
    "pressure-publish-3",
  ]);
  expect(pressureTransitions[2]?.outcome).toBe("applied");
  expect(pressureTransitions.map(({ state }) => state.unreclaimedAttempts)).toEqual([1, 2, 0, 1]);
  expect(pressureTransitions[2]?.state.store.objects.has("content/mutation-1")).toBe(true);
  expect(
    run.transitions.every(
      ({ state }) => state.unreclaimedAttempts <= state.assumptions.maxConcurrentPublishers,
    ),
  ).toBe(true);
});

test("crash enumeration emits before and after variants followed by retry for every effect", () => {
  const scenario: ModelScenario = {
    assumptions: DEFAULT_MODEL_ASSUMPTIONS,
    operations: [
      {
        kind: "append-log",
        operationId: "append-delete",
        mutation: {
          mutationId: "mutation-1",
          sequence: 1,
          documentId: "doc-0",
          change: { kind: "delete" },
        },
        acknowledgement: "acknowledge",
      },
      { kind: "reconstruct", operationId: "reconstruct-after-delete", mode: "cold" },
    ],
  };

  const schedules = enumerateModelCrashSchedules(scenario);

  expect(schedules).toHaveLength(4);
  expect(
    schedules.map(({ operations }) =>
      operations.map((operation) =>
        operation.kind === "crash"
          ? `${operation.targetOperationId}/${operation.durableEffectIndex}/${operation.boundary}`
          : operation.kind,
      ),
    ),
  ).toEqual([
    ["append-delete/0/before", "append-log", "retry", "reconstruct"],
    ["append-delete/0/after", "append-log", "retry", "reconstruct"],
    ["append-delete/1/before", "append-log", "retry", "reconstruct"],
    ["append-delete/1/after", "append-log", "retry", "reconstruct"],
  ]);
  for (const crashScenario of schedules) {
    assertScenarioBounds(crashScenario);
    const operations = crashScenario.operations;
    expect(operations[2]).toMatchObject({ kind: "retry", targetOperationId: "append-delete" });
  }
});

test("expanded canonical CAS schedules crash only applied effects and retry without rejection", () => {
  const scenario = canonicalModelCoverageScenarios().find(({ operations }) =>
    operations.some(({ kind }) => kind === "lose-publication-cas"),
  );
  expect(scenario).toBeDefined();
  if (scenario === undefined) {
    return;
  }
  const sourceRun = runModelSchedule(initialModelState(scenario.assumptions), scenario.operations);
  const casOperation = scenario.operations.find(({ kind }) => kind === "lose-publication-cas");
  expect(casOperation).toBeDefined();
  const appliedCasEffects = sourceRun.final.store.durableTrace.filter(
    ({ operationId, outcome }) =>
      operationId === casOperation?.operationId &&
      (outcome === "applied" || outcome === "crashed-after"),
  );

  expect(appliedCasEffects.map(({ effectIndex }) => effectIndex)).toEqual([0, 1, 2]);
  const schedules = enumerateModelCrashSchedules(scenario);
  expect(schedules).toHaveLength(14);

  const winnerCasSchedules = schedules.filter(({ operations }) =>
    operations.some(
      (operation) =>
        operation.kind === "crash" &&
        operation.targetOperationId === "concurrent-publication" &&
        operation.durableEffectIndex === 2,
    ),
  );
  expect(winnerCasSchedules).toHaveLength(2);
  expect(
    winnerCasSchedules.map(({ operations }) => {
      const crashIndex = operations.findIndex(({ kind }) => kind === "crash");
      return operations[crashIndex + 1]?.kind;
    }),
  ).toEqual(["lose-publication-cas", "lose-publication-cas"]);

  for (const expanded of schedules) {
    const run = runModelSchedule(initialModelState(expanded.assumptions), expanded.operations);
    const crashIndex = expanded.operations.findIndex(({ kind }) => kind === "crash");
    const crash = expanded.operations[crashIndex];
    const target = run.transitions[crashIndex + 1];
    const retry = run.transitions[crashIndex + 2];

    expect(crash?.kind).toBe("crash");
    if (crash?.kind !== "crash") {
      continue;
    }
    expect(target?.outcome).toBe(crash.boundary === "before" ? "crashed-before" : "crashed-after");
    expect(["applied", "cas-lost"]).toContain(retry?.outcome);
    expect(retry?.rejectionId).toBeNull();
    expect(classifiedRejections(expanded)).toEqual([]);
  }
});

test("crash enumeration adds controls beyond an irreducible 40-operation source", () => {
  const scenario: ModelScenario = {
    assumptions: DEFAULT_MODEL_ASSUMPTIONS,
    operations: [
      {
        kind: "append-log",
        operationId: "append-source",
        mutation: {
          mutationId: "mutation-1",
          sequence: 1,
          documentId: "doc-0",
          change: { kind: "delete" },
        },
        acknowledgement: "acknowledge",
      },
      {
        kind: "emit-run",
        operationId: "emit-source",
        runId: "source",
        level: 0,
        sequences: [1],
      },
      ...Array.from({ length: 38 }, (_, index): ModelOperation => ({
        kind: "publish-root",
        operationId: `publish-${index}`,
        publicationId: `publish-${index}`,
        expectedGeneration: index,
        runKeys: ["runs/source"],
        foldedThrough: 1,
        role: index % 2 === 0 ? "tail" : "base",
      })),
    ],
  };

  const schedules = enumerateModelCrashSchedules(scenario);

  expect(scenario.operations).toHaveLength(40);
  expect(schedules).toHaveLength(158);
  expect(schedules.every(({ operations }) => operations.length === 42)).toBe(true);
  for (const { operations } of schedules) {
    const crashIndex = operations.findIndex(({ kind }) => kind === "crash");
    const crash = operations[crashIndex];
    const target = operations[crashIndex + 1];
    const retry = operations[crashIndex + 2];
    expect(crash).toMatchObject({ kind: "crash", targetOperationId: target?.operationId });
    expect(retry).toMatchObject({ kind: "retry", targetOperationId: target?.operationId });
  }
});
