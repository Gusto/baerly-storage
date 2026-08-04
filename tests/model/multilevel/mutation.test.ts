import { expect, test } from "vitest";
import { initialModelState, runModelSchedule, type ModelRun } from "./executor.ts";
import { checkModelSafety } from "./invariants.ts";
import {
  DEFAULT_MODEL_ASSUMPTIONS,
  type ModelMutation,
  type ModelObject,
  type ModelOperation,
  type ModelState,
} from "./types.ts";

const acknowledgedPut: ModelMutation = {
  mutationId: "acknowledged-put",
  sequence: 1,
  documentId: "row",
  change: { kind: "put", value: 41 },
};

const droppedGhost: ModelMutation = {
  mutationId: "dropped-ghost",
  sequence: 1,
  documentId: "ghost",
  change: { kind: "put", value: 99 },
};

function runLiteralSchedule(
  operations: readonly ModelOperation[],
  assumptions = DEFAULT_MODEL_ASSUMPTIONS,
): ModelRun {
  const hasDroppedEvidence = operations.some(
    (operation) => operation.kind === "append-log" && operation.acknowledgement === "drop",
  );
  return runModelSchedule(initialModelState(assumptions), [
    ...operations,
    ...(hasDroppedEvidence
      ? []
      : ([
          {
            kind: "append-log",
            operationId: "append-mutation-proof-dropped",
            mutation: {
              mutationId: "mutation-proof-dropped",
              sequence: 1_000_000,
              documentId: "mutation-proof-ghost",
              change: { kind: "delete" },
            },
            acknowledgement: "drop",
          },
          {
            kind: "reclaim",
            operationId: "reclaim-mutation-proof-dropped",
            candidateKeys: ["log/1000000"],
          },
        ] as const)),
  ]);
}

function withObjects(state: ModelState, objects: ReadonlyMap<string, ModelObject>): ModelState {
  return { ...state, store: { ...state.store, objects } };
}

function replaceTransitionState(
  run: ModelRun,
  transitionIndex: number,
  state: ModelState,
  replaceFinal = false,
): ModelRun {
  return {
    ...run,
    final: replaceFinal ? state : run.final,
    transitions: run.transitions.map((transition, index) =>
      index === transitionIndex ? { ...transition, state } : transition,
    ),
  };
}

function expectOnlySafetyFailure(
  passing: ModelRun,
  mutated: ModelRun,
  expectedName:
    | "acknowledged-mutations-never-lost"
    | "unacknowledged-mutations-never-visible"
    | "cold-and-warm-equal-reference-replay"
    | "publication-monotone-no-partial-run"
    | "lost-cas-preserves-winning-lineage"
    | "reclamation-preserves-reachable-objects"
    | "recovery-idempotent-after-every-crash-point"
    | "total-object-count-is-bounded",
): void {
  const before = checkModelSafety(passing, passing.initial.assumptions);
  const after = checkModelSafety(mutated, passing.initial.assumptions);

  expect(before.filter(({ ok }) => !ok)).toEqual([]);
  expect(after.filter(({ ok }) => !ok).map(({ name }) => name)).toEqual([expectedName]);
}

test("dropping an acknowledged row makes acknowledged-mutations-never-lost fail", () => {
  const passing = runLiteralSchedule([
    {
      kind: "append-log",
      operationId: "append-acknowledged",
      mutation: acknowledgedPut,
      acknowledgement: "acknowledge",
    },
  ]);
  const emptied = withObjects(passing.final, new Map());
  const mutated: ModelRun = { ...passing, final: { ...emptied, referenceLedger: [] } };

  expectOnlySafetyFailure(passing, mutated, "acknowledged-mutations-never-lost");
});

test("exposing ghost makes unacknowledged-mutations-never-visible fail", () => {
  const passing = runLiteralSchedule([
    {
      kind: "append-log",
      operationId: "append-dropped-ghost",
      mutation: droppedGhost,
      acknowledgement: "drop",
    },
  ]);
  const objects = new Map(passing.final.store.objects);
  objects.set("runs/ghost", {
    kind: "run",
    key: "runs/ghost",
    level: 0,
    mutations: [droppedGhost],
    complete: true,
  });
  objects.set("manifests/ghost", {
    kind: "manifest",
    key: "manifests/ghost",
    generation: 1,
    predecessorKey: null,
    foldedThrough: 1,
    levels: [{ level: 0, runKeys: ["runs/ghost"] }],
  });
  const final: ModelState = {
    ...withObjects(passing.final, objects),
    referenceLedger: [droppedGhost],
    store: {
      ...passing.final.store,
      objects,
      root: { generation: 1, etag: "root/ghost", manifestKey: "manifests/ghost" },
    },
  };

  expectOnlySafetyFailure(passing, { ...passing, final }, "unacknowledged-mutations-never-visible");
});

test("deleting a reachable empty run makes cold-and-warm-equal-reference-replay fail", () => {
  const passing = runLiteralSchedule([
    { kind: "emit-run", operationId: "emit-empty", runId: "empty", level: 0, sequences: [] },
    {
      kind: "publish-root",
      operationId: "publish-empty",
      publicationId: "empty",
      expectedGeneration: 0,
      runKeys: ["runs/empty"],
      foldedThrough: 0,
      role: "tail",
    },
  ]);
  const objects = new Map(passing.final.store.objects);
  objects.delete("runs/empty");
  const mutated: ModelRun = { ...passing, final: withObjects(passing.final, objects) };

  expectOnlySafetyFailure(passing, mutated, "cold-and-warm-equal-reference-replay");
});

test("giving the current manifest a mismatched identity makes publication safety fail", () => {
  const passing = runLiteralSchedule([
    { kind: "emit-run", operationId: "emit-empty", runId: "empty", level: 0, sequences: [] },
    {
      kind: "publish-root",
      operationId: "publish-empty",
      publicationId: "empty",
      expectedGeneration: 0,
      runKeys: ["runs/empty"],
      foldedThrough: 0,
      role: "tail",
    },
  ]);
  const objects = new Map(passing.final.store.objects);
  const manifest = objects.get("manifests/empty");
  expect(manifest?.kind).toBe("manifest");
  if (manifest?.kind !== "manifest") {
    return;
  }
  objects.set("manifests/empty", {
    ...manifest,
    key: "manifests/other",
  });
  const state = withObjects(passing.final, objects);
  const mutated = replaceTransitionState(passing, 1, state);

  expectOnlySafetyFailure(passing, mutated, "publication-monotone-no-partial-run");
});

test("attaching the losing run makes lost-cas-preserves-winning-lineage fail", () => {
  const loserMutation: ModelMutation = {
    mutationId: "loser-put",
    sequence: 2,
    documentId: "loser-row",
    change: { kind: "put", value: 42 },
  };
  const passing = runLiteralSchedule(
    [
      {
        kind: "append-log",
        operationId: "append-winner",
        mutation: acknowledgedPut,
        acknowledgement: "acknowledge",
      },
      {
        kind: "append-log",
        operationId: "append-loser",
        mutation: loserMutation,
        acknowledgement: "acknowledge",
      },
      {
        kind: "emit-run",
        operationId: "emit-winner",
        runId: "winner",
        level: 0,
        sequences: [1],
      },
      {
        kind: "emit-run",
        operationId: "emit-loser",
        runId: "loser",
        level: 0,
        sequences: [2],
      },
      {
        kind: "lose-publication-cas",
        operationId: "concurrent-publish",
        winner: {
          publicationId: "winner",
          expectedGeneration: 0,
          runKeys: ["runs/winner"],
          foldedThrough: 1,
          role: "tail",
        },
        loser: {
          publicationId: "loser",
          expectedGeneration: 0,
          runKeys: ["runs/loser"],
          foldedThrough: 2,
          role: "base",
        },
      },
    ],
    { ...DEFAULT_MODEL_ASSUMPTIONS, maxConcurrentPublishers: 3 },
  );
  const objects = new Map(passing.final.store.objects);
  const winnerManifest = objects.get("manifests/winner");
  expect(winnerManifest?.kind).toBe("manifest");
  if (winnerManifest?.kind !== "manifest") {
    return;
  }
  objects.set("manifests/winner", {
    ...winnerManifest,
    levels: [{ level: 0, runKeys: ["runs/winner", "runs/loser"] }],
  });
  const state = withObjects(passing.final, objects);
  const mutated = replaceTransitionState(passing, 4, state, true);

  expectOnlySafetyFailure(passing, mutated, "lost-cas-preserves-winning-lineage");
});

test("deleting a reachable run during reclaim makes reclamation safety fail", () => {
  const passing = runLiteralSchedule([
    { kind: "emit-run", operationId: "emit-live", runId: "live", level: 0, sequences: [] },
    {
      kind: "publish-root",
      operationId: "publish-live",
      publicationId: "live",
      expectedGeneration: 0,
      runKeys: ["runs/live"],
      foldedThrough: 0,
      role: "tail",
    },
    { kind: "reclaim", operationId: "reclaim-orphan", candidateKeys: ["runs/orphan"] },
  ]);
  const objects = new Map(passing.final.store.objects);
  objects.delete("runs/live");
  const state = withObjects(passing.final, objects);
  const mutated = replaceTransitionState(passing, 2, state);

  expectOnlySafetyFailure(passing, mutated, "reclamation-preserves-reachable-objects");
});

test("recording the first retry as rejected makes recovery idempotence fail", () => {
  const passing = runLiteralSchedule([
    {
      kind: "emit-run",
      operationId: "emit-before-crash",
      runId: "before-crash",
      level: 0,
      sequences: [],
    },
    {
      kind: "crash",
      operationId: "crash-after-publish-cas",
      targetOperationId: "publish-crash",
      durableEffectIndex: 1,
      boundary: "after",
    },
    {
      kind: "publish-root",
      operationId: "publish-crash",
      publicationId: "crash",
      expectedGeneration: 0,
      runKeys: ["runs/before-crash"],
      foldedThrough: 0,
      role: "tail",
    },
    { kind: "retry", operationId: "retry-publish", targetOperationId: "publish-crash" },
  ]);
  const retry = passing.transitions[3];
  expect(retry).toBeDefined();
  if (retry === undefined) {
    return;
  }
  const mutated: ModelRun = {
    ...passing,
    transitions: passing.transitions.map((transition, index) =>
      index === 3
        ? { ...transition, outcome: "rejected", rejectionId: "retry/mutated-rejection" }
        : transition,
    ),
  };

  expectOnlySafetyFailure(passing, mutated, "recovery-idempotent-after-every-crash-point");
});

test("adding one physical object above the exact bound makes object safety fail", () => {
  const executed = runLiteralSchedule([]);
  const boundedObjects = new Map<string, ModelObject>();
  for (let index = 0; index < 13; index += 1) {
    const key = `content/within-bound-${index}`;
    boundedObjects.set(key, {
      kind: "content",
      key,
      documentId: `within-bound-${index}`,
      value: index,
    });
  }
  const passing: ModelRun = {
    ...executed,
    final: withObjects(executed.final, boundedObjects),
  };
  const objects = new Map(passing.final.store.objects);
  objects.set("content/one-over-bound", {
    kind: "content",
    key: "content/one-over-bound",
    documentId: "one-over-bound",
    value: 1,
  });
  const mutated: ModelRun = { ...passing, final: withObjects(passing.final, objects) };

  expectOnlySafetyFailure(passing, mutated, "total-object-count-is-bounded");
});
