import { describe, expect, test } from "vitest";
import {
  executeModelOperation,
  initialModelState,
  modelDurableEffectCount,
  runModelSchedule,
} from "./executor.ts";
import { reachableModelObjectKeys } from "./model-store.ts";
import {
  DEFAULT_MODEL_ASSUMPTIONS,
  MODEL_BASE_SHA,
  MODEL_OPERATION_KINDS,
  type ModelAppendLogOperation,
  type ModelEmitRunOperation,
  type ModelLosePublicationCasOperation,
  type ModelMergeRunsOperation,
  type ModelOperation,
  type ModelPublishRootOperation,
  type ModelState,
} from "./types.ts";

const firstMutation = {
  mutationId: "mutation-1",
  sequence: 1,
  documentId: "document-1",
  change: { kind: "put" as const, value: 41 },
};

const secondMutation = {
  mutationId: "mutation-2",
  sequence: 2,
  documentId: "document-2",
  change: { kind: "put" as const, value: 42 },
};

const overwriteFirstMutation = {
  mutationId: "overwrite-1",
  sequence: 2,
  documentId: "document-1",
  change: { kind: "put" as const, value: 42 },
};

const deleteFirstMutation = {
  mutationId: "delete-1",
  sequence: 2,
  documentId: "document-1",
  change: { kind: "delete" as const },
};

const appendFirst: ModelAppendLogOperation = {
  kind: "append-log",
  operationId: "append-1",
  mutation: firstMutation,
  acknowledgement: "acknowledge",
};

const emitFirst: ModelEmitRunOperation = {
  kind: "emit-run",
  operationId: "emit-1",
  runId: "run-1",
  level: 0,
  sequences: [1],
};

const publishFirst: ModelPublishRootOperation = {
  kind: "publish-root",
  operationId: "publish-1",
  publicationId: "publication-1",
  expectedGeneration: 0,
  runKeys: ["runs/run-1"],
  foldedThrough: 1,
  role: "tail",
};

const operationFixtures = [
  appendFirst,
  emitFirst,
  publishFirst,
  {
    kind: "merge-runs",
    operationId: "merge-1",
    mergeId: "merge-1",
    inputRunKeys: ["runs/run-1", "runs/run-2"],
    outputRunId: "run-merged",
    targetLevel: 1,
  },
  {
    kind: "lose-publication-cas",
    operationId: "lose-cas-1",
    winner: {
      publicationId: "winner",
      expectedGeneration: 0,
      runKeys: ["runs/run-1"],
      foldedThrough: 1,
      role: "tail",
    },
    loser: {
      publicationId: "loser",
      expectedGeneration: 0,
      runKeys: ["runs/run-1"],
      foldedThrough: 1,
      role: "base",
    },
  },
  {
    kind: "crash",
    operationId: "crash-1",
    targetOperationId: "append-1",
    durableEffectIndex: 1,
    boundary: "before",
  },
  { kind: "retry", operationId: "retry-1", targetOperationId: "append-1" },
  { kind: "reconstruct", operationId: "reconstruct-1", mode: "cold" },
  { kind: "reclaim", operationId: "reclaim-1", candidateKeys: ["runs/orphan"] },
] as const satisfies readonly ModelOperation[];

function execute(state: ModelState, operation: ModelOperation): ModelState {
  return executeModelOperation(state, operation).state;
}

function unreclaimedOwnership(
  state: ModelState,
): readonly (readonly [string, readonly string[]])[] {
  return [...state.unreclaimedByAttempt]
    .map(([operationId, keys]) => [operationId, [...keys].toSorted()] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
}

function stateWithFirstRun(): ModelState {
  return execute(execute(initialModelState(), appendFirst), emitFirst);
}

function stateWithFirstPublishedRun(): ModelState {
  return execute(stateWithFirstRun(), {
    ...publishFirst,
    foldedThrough: 0,
  });
}

function stateWithPriorPublicationRace(): ModelState {
  return execute(stateWithFirstPublishedRun(), {
    kind: "lose-publication-cas",
    operationId: "race-after-publication",
    winner: {
      publicationId: "race-winner",
      expectedGeneration: 1,
      runKeys: ["runs/run-1"],
      foldedThrough: 0,
      role: "tail",
    },
    loser: {
      publicationId: "race-loser",
      expectedGeneration: 1,
      runKeys: ["runs/run-1"],
      foldedThrough: 0,
      role: "base",
    },
  });
}

function stateWithFoldedRunAndSuffix(): ModelState {
  const putA = {
    mutationId: "put-a",
    sequence: 0,
    documentId: "a",
    change: { kind: "put" as const, value: 1 },
  };
  const putB = {
    mutationId: "put-b",
    sequence: 1,
    documentId: "b",
    change: { kind: "put" as const, value: 2 },
  };
  const deleteA = {
    mutationId: "delete-a",
    sequence: 2,
    documentId: "a",
    change: { kind: "delete" as const },
  };
  let state = initialModelState();
  for (const [operationId, mutation] of [
    ["append-a", putA],
    ["append-b", putB],
    ["append-delete-a", deleteA],
  ] as const) {
    state = execute(state, {
      kind: "append-log",
      operationId,
      mutation,
      acknowledgement: "acknowledge",
    });
  }
  state = execute(state, {
    kind: "append-log",
    operationId: "append-unacknowledged-ghost",
    mutation: {
      mutationId: "put-ghost",
      sequence: 3,
      documentId: "ghost",
      change: { kind: "put", value: 9 },
    },
    acknowledgement: "drop",
  });
  state = execute(state, {
    kind: "emit-run",
    operationId: "emit-folded",
    runId: "folded",
    level: 0,
    sequences: [0, 1],
  });
  return execute(state, {
    kind: "publish-root",
    operationId: "publish-folded",
    publicationId: "folded",
    expectedGeneration: 0,
    runKeys: ["runs/folded"],
    foldedThrough: 1,
    role: "tail",
  });
}

describe("model contract", () => {
  test("exposes the exact nine operation kinds and one typed fixture per kind", () => {
    expect(MODEL_OPERATION_KINDS).toEqual([
      "append-log",
      "emit-run",
      "publish-root",
      "merge-runs",
      "lose-publication-cas",
      "crash",
      "retry",
      "reconstruct",
      "reclaim",
    ]);
    expect(operationFixtures.map(({ kind }) => kind)).toEqual(MODEL_OPERATION_KINDS);
  });

  test("uses the bounded executable defaults", () => {
    expect(DEFAULT_MODEL_ASSUMPTIONS).toEqual({
      maxLiveDocuments: 8,
      maxActiveLevels: 3,
      maxRunsPerLevel: 2,
      maxCommittedSuffixEntries: 6,
      maxConcurrentPublishers: 2,
      maxScheduleOperations: 40,
    });
  });

  // Asserting `MODEL_BASE_SHA` against its own literal proved nothing — it
  // could not fail, including when the recorded baseline went stale. Whether
  // `main` has moved somewhere that invalidates the modeled design is a human
  // judgment made at rebaseline time (see this directory's README), and a
  // git-ancestry check is not available: CI checks out shallow. What is
  // mechanically checkable is the shape, which is what silently corrupts a
  // report's `baseSha` when someone pastes an abbreviated SHA.
  test("records a well-formed full-length base commit", () => {
    expect(MODEL_BASE_SHA).toMatch(/^[0-9a-f]{40}$/);
  });
});

test("append writes content, numbered log, and separate acknowledgement objects", () => {
  const transition = executeModelOperation(initialModelState(), appendFirst);

  expect(transition.outcome).toBe("applied");
  expect([...transition.state.store.objects.keys()]).toEqual([
    "content/mutation-1",
    "log/1",
    "ack/1",
  ]);
  expect(transition.state.store.objects.get("log/1")).toEqual({
    kind: "log",
    key: "log/1",
    mutation: firstMutation,
    contentKey: "content/mutation-1",
  });
  expect(transition.state.referenceLedger).toEqual([firstMutation]);
});

test("emit writes a complete immutable run from the selected log sequences", () => {
  const transition = executeModelOperation(execute(initialModelState(), appendFirst), emitFirst);

  expect(transition.outcome).toBe("applied");
  expect(transition.state.store.objects.get("runs/run-1")).toEqual({
    kind: "run",
    key: "runs/run-1",
    level: 0,
    mutations: [firstMutation],
    complete: true,
  });
});

test("emit rejects an unacknowledged log before it enters a run", () => {
  const unacknowledgedGhost = {
    mutationId: "put-ghost",
    sequence: 3,
    documentId: "ghost",
    change: { kind: "put" as const, value: 9 },
  };
  const appended = executeModelOperation(initialModelState(), {
    kind: "append-log",
    operationId: "append-unacknowledged-ghost",
    mutation: unacknowledgedGhost,
    acknowledgement: "drop",
  });

  const emitted = executeModelOperation(appended.state, {
    kind: "emit-run",
    operationId: "emit-unacknowledged-ghost",
    runId: "unacknowledged-ghost",
    level: 0,
    sequences: [3],
  });

  expect(emitted.outcome).toBe("rejected");
  expect(emitted.rejectionId).toBe("emit/missing-ack/3");
  expect(emitted.state.store.objects.has("runs/unacknowledged-ghost")).toBe(false);
});

test("publish rejects a complete run containing an unacknowledged mutation", () => {
  const unacknowledgedGhost = {
    mutationId: "put-ghost",
    sequence: 3,
    documentId: "ghost",
    change: { kind: "put" as const, value: 9 },
  };
  const appended = executeModelOperation(initialModelState(), {
    kind: "append-log",
    operationId: "append-unacknowledged-ghost",
    mutation: unacknowledgedGhost,
    acknowledgement: "drop",
  }).state;
  const objects = new Map(appended.store.objects);
  objects.set("runs/unacknowledged-ghost", {
    kind: "run",
    key: "runs/unacknowledged-ghost",
    level: 0,
    mutations: [unacknowledgedGhost],
    complete: true,
  });
  const stateWithForgedRun: ModelState = {
    ...appended,
    store: { ...appended.store, objects },
  };

  const published = executeModelOperation(stateWithForgedRun, {
    kind: "publish-root",
    operationId: "publish-unacknowledged-ghost",
    publicationId: "unacknowledged-ghost",
    expectedGeneration: 0,
    runKeys: ["runs/unacknowledged-ghost"],
    foldedThrough: 3,
    role: "tail",
  });

  expect(published.outcome).toBe("rejected");
  expect(published.rejectionId).toBe(
    "publish/unacknowledged-mutation/runs/unacknowledged-ghost/put-ghost",
  );
  expect(published.state.store.root.manifestKey).toBeNull();
});

test("merge writes one complete immutable run in sequence order", () => {
  let state = stateWithFirstRun();
  state = execute(state, {
    kind: "append-log",
    operationId: "append-2",
    mutation: secondMutation,
    acknowledgement: "acknowledge",
  });
  state = execute(state, {
    kind: "emit-run",
    operationId: "emit-2",
    runId: "run-2",
    level: 0,
    sequences: [2],
  });
  const merge: ModelMergeRunsOperation = {
    kind: "merge-runs",
    operationId: "merge-1",
    mergeId: "merge-1",
    inputRunKeys: ["runs/run-2", "runs/run-1"],
    outputRunId: "run-merged",
    targetLevel: 1,
  };

  const transition = executeModelOperation(state, merge);

  expect(transition.outcome).toBe("applied");
  expect(transition.state.store.objects.get("runs/run-merged")).toEqual({
    kind: "run",
    key: "runs/run-merged",
    level: 1,
    mutations: [firstMutation, secondMutation],
    complete: true,
  });
});

// `tail-fold-and-base-merge-run-in-both-orders` is only non-vacuous if the two
// shapes it counts are the real ones. Before these, the suite asserted that both
// orders get reached and nothing about what qualifies as either, so dropping a
// clause from the tail-fold shape — `foldedThrough > 0`, say — left the whole
// suite green while letting a publication that folded nothing satisfy the
// property. Each test below was confirmed to fail against a mutant of the clause
// it names — dropped `foldedThrough > 0`, dropped `role === "tail"`, dropped
// `inputRunKeys.length > 0`, and swapped recorded orders — so none of them is the
// redundant restatement of its neighbour that it can look like.
describe("maintenance-order coverage counts only real folds and merges", () => {
  const mergeAfter = (state: ModelState, inputRunKeys: readonly string[]): ModelState =>
    execute(state, {
      kind: "merge-runs",
      operationId: `merge-after-${inputRunKeys.length}`,
      mergeId: `merge-after-${inputRunKeys.length}`,
      inputRunKeys,
      outputRunId: "run-merged",
      targetLevel: 1,
    });

  const publishAfter = (
    state: ModelState,
    publication: Partial<ModelPublishRootOperation>,
  ): ModelState =>
    execute(state, {
      ...publishFirst,
      operationId: "publish-after",
      publicationId: "publication-after",
      expectedGeneration: state.store.root.generation,
      ...publication,
    });

  test("a tail fold then a base merge records tail-before-base", () => {
    // Not `stateWithFirstPublishedRun()`, which pins `foldedThrough: 0` and so
    // publishes without folding.
    const folded = publishAfter(stateWithFirstRun(), {});
    const merged = mergeAfter(folded, ["runs/run-1"]);

    expect([...merged.coverage.maintenanceOrders]).toEqual(["tail-before-base"]);
  });

  test("a base merge then a tail fold records base-before-tail", () => {
    const merged = mergeAfter(stateWithFirstRun(), ["runs/run-1"]);
    const folded = publishAfter(merged, { runKeys: ["runs/run-merged"], foldedThrough: 1 });

    expect([...folded.coverage.maintenanceOrders]).toEqual(["base-before-tail"]);
  });

  test("a publication that folds nothing is not a tail fold", () => {
    const publishedNothing = publishAfter(stateWithFirstRun(), { foldedThrough: 0 });
    const merged = mergeAfter(publishedNothing, ["runs/run-1"]);

    expect([...merged.coverage.maintenanceOrders]).toEqual([]);
  });

  test("a base-role publication is not a tail fold", () => {
    const publishedAsBase = publishAfter(stateWithFirstRun(), { role: "base" });
    const merged = mergeAfter(publishedAsBase, ["runs/run-1"]);

    expect([...merged.coverage.maintenanceOrders]).toEqual([]);
  });

  test("a merge that consumed no inputs is not a base merge", () => {
    const mergedNothing = mergeAfter(stateWithFirstRun(), []);
    const folded = publishAfter(mergedNothing, { runKeys: ["runs/run-1"], foldedThrough: 1 });

    expect([...folded.coverage.maintenanceOrders]).toEqual([]);
  });
});

test("merge rejects an empty-input output above the configured level range", () => {
  const transition = executeModelOperation(initialModelState(), {
    kind: "merge-runs",
    operationId: "reject-level-overflow",
    mergeId: "reject-level-overflow",
    inputRunKeys: [],
    outputRunId: "overflow-output",
    targetLevel: 3,
  });

  expect(transition.outcome).toBe("rejected");
  expect(transition.rejectionId).toBe("merge-level-overflow");
  expect(transition.state.store.objects.has("runs/overflow-output")).toBe(false);
});

test("registered missing-run rejections expose their classified IDs", () => {
  const missingPublish = executeModelOperation(initialModelState(), {
    kind: "publish-root",
    operationId: "reject-missing-publish",
    publicationId: "reject-missing-publish",
    expectedGeneration: 0,
    runKeys: ["runs/missing"],
    foldedThrough: 0,
    role: "tail",
  });
  const missingMerge = executeModelOperation(initialModelState(), {
    kind: "merge-runs",
    operationId: "reject-missing-merge",
    mergeId: "reject-missing-merge",
    inputRunKeys: ["runs/missing"],
    outputRunId: "missing-output",
    targetLevel: 1,
  });

  expect(missingPublish).toMatchObject({
    outcome: "rejected",
    rejectionId: "publish-incomplete-run",
  });
  expect(missingMerge).toMatchObject({
    outcome: "rejected",
    rejectionId: "merge-missing-run",
  });
});

test.each(["before", "after"] as const)(
  "a matching %s crash arm is invalidated by a registered zero-effect rejection",
  (boundary) => {
    const crashOperationId = `invalid-registered-${boundary}`;
    const targetOperationId = `reject-missing-publish-${boundary}`;
    const armed = executeModelOperation(initialModelState(), {
      kind: "crash",
      operationId: crashOperationId,
      targetOperationId,
      durableEffectIndex: 0,
      boundary,
    }).state;
    const rejected = executeModelOperation(armed, {
      kind: "publish-root",
      operationId: targetOperationId,
      publicationId: targetOperationId,
      expectedGeneration: 0,
      runKeys: ["runs/missing"],
      foldedThrough: 0,
      role: "tail",
    });

    expect(rejected).toMatchObject({
      outcome: "rejected",
      rejectionId: "publish-incomplete-run",
      durableEffects: [],
    });
    expect(rejected.state.pendingCrash).toBeNull();
    expect([...rejected.state.coverage.rejectedArms]).toEqual([
      `crash/invalid-effect-index/${crashOperationId}`,
      "publish-incomplete-run",
    ]);
    expect(rejected.state.coverage.crashBoundaries).toEqual(new Set());
    expect(rejected.state.store).toBe(armed.store);
    expect(rejected.state.referenceLedger).toBe(armed.referenceLedger);
    expect(rejected.state.warmCache).toBe(armed.warmCache);
    expect(rejected.state.unreclaimedByAttempt).toBe(armed.unreclaimedByAttempt);
    expect(rejected.state.unreclaimedAttempts).toBe(armed.unreclaimedAttempts);

    const retry = executeModelOperation(rejected.state, {
      kind: "retry",
      operationId: `retry-${targetOperationId}`,
      targetOperationId,
    });
    expect(retry).toMatchObject({ outcome: "rejected", rejectionId: "retry-without-crash" });
    expect(retry.state.coverage.crashBoundaries).toEqual(new Set());

    const replacement = executeModelOperation(retry.state, {
      kind: "crash",
      operationId: `replacement-${boundary}`,
      targetOperationId: `replacement-target-${boundary}`,
      durableEffectIndex: 0,
      boundary,
    });
    expect(replacement.outcome).toBe("applied");
    const replacementTarget = executeModelOperation(replacement.state, {
      ...appendFirst,
      operationId: `replacement-target-${boundary}`,
    });
    expect(replacementTarget.outcome).toBe(
      boundary === "before" ? "crashed-before" : "crashed-after",
    );
  },
);

test("a mismatched pending arm survives a registered rejection and crashes its real target", () => {
  const crash = {
    kind: "crash" as const,
    operationId: "pending-for-real-target",
    targetOperationId: "real-target",
    durableEffectIndex: 0,
    boundary: "before" as const,
  };
  const armed = executeModelOperation(initialModelState(), crash).state;
  const rejected = executeModelOperation(armed, {
    kind: "publish-root",
    operationId: "unrelated-registered-rejection",
    publicationId: "unrelated-registered-rejection",
    expectedGeneration: 0,
    runKeys: ["runs/missing"],
    foldedThrough: 0,
    role: "tail",
  });

  expect(rejected.outcome).toBe("rejected");
  expect(rejected.state.pendingCrash).toBe(crash);
  expect([...rejected.state.coverage.rejectedArms]).toEqual(["publish-incomplete-run"]);

  const target = executeModelOperation(rejected.state, {
    ...appendFirst,
    operationId: "real-target",
  });
  expect(target.outcome).toBe("crashed-before");
  expect(target.state.pendingCrash).toBeNull();
  expect([...target.state.coverage.crashBoundaries]).toEqual(["real-target/0/before"]);
});

test("a registered rejection without a pending arm records only its registered evidence", () => {
  const state = initialModelState();
  const rejected = executeModelOperation(state, {
    kind: "publish-root",
    operationId: "registered-without-crash",
    publicationId: "registered-without-crash",
    expectedGeneration: 0,
    runKeys: ["runs/missing"],
    foldedThrough: 0,
    role: "tail",
  });

  expect(rejected).toMatchObject({
    outcome: "rejected",
    rejectionId: "publish-incomplete-run",
    durableEffects: [],
  });
  expect(rejected.state.pendingCrash).toBeNull();
  expect([...rejected.state.coverage.rejectedArms]).toEqual(["publish-incomplete-run"]);
  expect(rejected.state.store).toBe(state.store);
});

test("publish writes a manifest and advances the root generation through CAS", () => {
  const transition = executeModelOperation(stateWithFirstRun(), publishFirst);

  expect(transition.outcome).toBe("applied");
  expect(transition.state.store.root).toEqual({
    generation: 1,
    etag: "root/publication-1",
    manifestKey: "manifests/publication-1",
  });
  expect(transition.state.store.objects.get("manifests/publication-1")).toEqual({
    kind: "manifest",
    key: "manifests/publication-1",
    generation: 1,
    predecessorKey: null,
    foldedThrough: 1,
    levels: [{ level: 0, runKeys: ["runs/run-1"] }],
  });
});

test("publish accepts a previously acknowledged mutation after its folded log and ack are reclaimed", () => {
  let state = execute(stateWithFirstRun(), publishFirst);
  state = execute(state, {
    kind: "reclaim",
    operationId: "reclaim-folded-log",
    candidateKeys: ["ack/1", "log/1"],
  });
  expect(state.store.objects.has("content/mutation-1")).toBe(true);
  state = execute(state, {
    kind: "merge-runs",
    operationId: "merge-reclaimed-log-run",
    mergeId: "merge-reclaimed-log-run",
    inputRunKeys: ["runs/run-1"],
    outputRunId: "run-after-reclaim",
    targetLevel: 1,
  });

  const published = executeModelOperation(state, {
    kind: "publish-root",
    operationId: "publish-after-reclaim",
    publicationId: "publication-after-reclaim",
    expectedGeneration: 1,
    runKeys: ["runs/run-after-reclaim"],
    foldedThrough: 1,
    role: "base",
  });

  expect(published.outcome).toBe("applied");
  expect(published.state.store.root.manifestKey).toBe("manifests/publication-after-reclaim");
});

test("lost publication CAS retains the winning root and both immutable manifests", () => {
  const operation: ModelLosePublicationCasOperation = operationFixtures[4];
  const transition = executeModelOperation(stateWithFirstRun(), operation);

  expect(transition.outcome).toBe("cas-lost");
  expect(transition.state.store.root.manifestKey).toBe("manifests/winner");
  expect(transition.state.store.objects.has("manifests/winner")).toBe(true);
  expect(transition.state.store.objects.has("manifests/loser")).toBe(true);
  expect([...transition.state.coverage.publicationOutcomes].toSorted()).toEqual(["lose", "win"]);
});

test("retry recognizes a composite winner that landed before a crash and preserves its loser", () => {
  const operation: ModelLosePublicationCasOperation = {
    ...operationFixtures[4],
    operationId: "composite-publication",
  };
  const armed = executeModelOperation(stateWithFirstRun(), {
    kind: "crash",
    operationId: "crash-after-composite-winner",
    targetOperationId: operation.operationId,
    durableEffectIndex: 2,
    boundary: "after",
  }).state;
  const crashed = executeModelOperation(armed, operation);

  expect(crashed.outcome).toBe("crashed-after");
  expect(crashed.state.store.root.manifestKey).toBe("manifests/winner");
  const retryOperation = {
    kind: "retry" as const,
    operationId: "retry-composite-publication",
    targetOperationId: operation.operationId,
  };
  const recovered = executeModelOperation(crashed.state, retryOperation);

  expect(recovered.outcome).toBe("cas-lost");
  expect(recovered.rejectionId).toBeNull();
  expect(recovered.state.store.root.manifestKey).toBe("manifests/winner");
  expect(recovered.state.store.objects.has("manifests/loser")).toBe(true);

  const repeated = executeModelOperation(recovered.state, retryOperation);
  expect(repeated.outcome).toBe("cas-lost");
  expect(repeated.rejectionId).toBeNull();
  expect(repeated.state.store.root).toEqual(recovered.state.store.root);
  expect(repeated.state.store.objects).toEqual(recovered.state.store.objects);
});

test("an after-crash arm on a losing CAS preserves CAS loss and rejects the arm", () => {
  const armed = executeModelOperation(stateWithFirstRun(), {
    kind: "crash",
    operationId: "after-losing-cas",
    targetOperationId: "target-lost-cas",
    durableEffectIndex: 3,
    boundary: "after",
  }).state;
  const transition = executeModelOperation(armed, {
    ...operationFixtures[4],
    operationId: "target-lost-cas",
  });

  expect(transition.outcome).toBe("cas-lost");
  expect(transition.state.pendingCrash).toBeNull();
  expect([...transition.state.coverage.rejectedArms]).toEqual([
    "crash/unapplied-effect/after-losing-cas",
  ]);
  expect(transition.state.store.root.manifestKey).toBe("manifests/winner");
});

test("crash arms one exact durable effect and preserves earlier effects", () => {
  const armed = executeModelOperation(initialModelState(), {
    kind: "crash",
    operationId: "crash-append",
    targetOperationId: "target-append",
    durableEffectIndex: 1,
    boundary: "before",
  });
  const transition = executeModelOperation(armed.state, {
    ...appendFirst,
    operationId: "target-append",
  });

  expect(transition.outcome).toBe("crashed-before");
  expect([...transition.state.store.objects.keys()]).toEqual(["content/mutation-1"]);
  expect(transition.state.pendingCrash).toBeNull();
  expect([...transition.state.coverage.crashBoundaries]).toEqual(["target-append/1/before"]);
});

// `modelCrashPrefixExceedsOwnerBound` in `arbitraries.ts` enumerates every crash
// boundary of an operation before the generator commits to it. It used to bound
// that loop with the literal `4` — correct only because the composite CAS is
// today's widest operation, and silently short of the last boundary the day one
// gets wider. It derives the bound from `modelDurableEffectCount` now, so these
// pin the derivation itself: an under-reporting count would under-probe just as
// quietly.
describe("durable effect count", () => {
  test("reports the effects each operation kind really attempts", () => {
    const runWithSecondRun = () => {
      let state = stateWithFirstRun();
      state = execute(state, {
        kind: "append-log",
        operationId: "append-2",
        mutation: secondMutation,
        acknowledgement: "acknowledge",
      });
      return execute(state, {
        kind: "emit-run",
        operationId: "emit-2",
        runId: "run-2",
        level: 0,
        sequences: [2],
      });
    };

    const cases: readonly (readonly [string, ModelState, ModelOperation])[] = [
      ["append with content", initialModelState(), appendFirst],
      [
        "append of a delete, which writes no content",
        initialModelState(),
        { ...appendFirst, operationId: "append-delete", mutation: deleteFirstMutation },
      ],
      [
        "unacknowledged append",
        initialModelState(),
        { ...appendFirst, operationId: "append-dropped", acknowledgement: "drop" },
      ],
      ["emit", execute(initialModelState(), appendFirst), emitFirst],
      ["publish", stateWithFirstRun(), publishFirst],
      [
        "merge",
        runWithSecondRun(),
        {
          kind: "merge-runs",
          operationId: "merge-1",
          mergeId: "merge-1",
          inputRunKeys: ["runs/run-2", "runs/run-1"],
          outputRunId: "run-merged",
          targetLevel: 1,
        },
      ],
      ["composite CAS", stateWithFirstRun(), operationFixtures[4]],
      [
        "reclaim",
        stateWithFirstRun(),
        { kind: "reclaim", operationId: "reclaim-1", candidateKeys: ["runs/run-1"] },
      ],
    ];

    // Compared as one labelled table rather than per-case assertions, so a
    // divergence names the kind that diverged instead of reporting a bare number.
    const derived = cases.map(([label, state, operation]) => {
      const transition = executeModelOperation(state, operation);
      return {
        label,
        outcome: transition.outcome,
        derivedCount: modelDurableEffectCount(state, operation),
        attemptedCount: transition.durableEffects.length,
      };
    });

    // Every case runs to completion, so the effects attempted are the effects
    // there were, and the identity below is the strong claim it reads as.
    // `cas-lost` still attempts all four: the loser's root CAS is the last
    // effect, so losing it is not a mid-way stop.
    expect(derived.map(({ outcome }) => outcome)).toEqual([
      "applied",
      "applied",
      "applied",
      "applied",
      "applied",
      "applied",
      "cas-lost",
      "applied",
    ]);
    expect(derived.map(({ label, derivedCount }) => [label, derivedCount])).toEqual(
      derived.map(({ label, attemptedCount }) => [label, attemptedCount]),
    );

    // The exact widths, which is what the probe loop's literal `4` was asserting
    // without saying so: the composite CAS is the widest operation, at winner and
    // loser manifest plus winner and loser root CAS. Widening any operation past
    // it — or narrowing the CAS — fails here rather than under-probing in silence.
    expect(derived.map(({ label, derivedCount }) => [label, derivedCount])).toEqual([
      ["append with content", 3],
      ["append of a delete, which writes no content", 2],
      ["unacknowledged append", 2],
      ["emit", 1],
      ["publish", 2],
      ["merge", 1],
      ["composite CAS", 4],
      ["reclaim", 1],
    ]);
  });

  test("reports no boundary for an operation that attempts nothing", () => {
    // A rejected operation and a control operation both write nothing, so both
    // have no crash boundary to probe — and the probe loop must not run a pass
    // that `modelStateAfterCrashIndexValidation` would only reject.
    const rejectedEmit: ModelEmitRunOperation = { ...emitFirst, sequences: [99] };
    expect(executeModelOperation(initialModelState(), rejectedEmit).outcome).toBe("rejected");
    expect(modelDurableEffectCount(initialModelState(), rejectedEmit)).toBe(0);
    expect(modelDurableEffectCount(initialModelState(), operationFixtures[7])).toBe(0);
  });
});

test("a crash after the final acknowledgement advances the committed reference ledger", () => {
  const armed = executeModelOperation(initialModelState(), {
    kind: "crash",
    operationId: "crash-after-final-ack",
    targetOperationId: "append-through-ack",
    durableEffectIndex: 2,
    boundary: "after",
  }).state;
  const crashed = executeModelOperation(armed, {
    ...appendFirst,
    operationId: "append-through-ack",
  });

  expect(crashed.outcome).toBe("crashed-after");
  expect(crashed.state.referenceLedger).toEqual([firstMutation]);
});

test("a publication crash adopts staged runs without exceeding the owner bound", () => {
  let state = stateWithFirstRun();
  state = execute(state, {
    kind: "append-log",
    operationId: "append-2",
    mutation: secondMutation,
    acknowledgement: "acknowledge",
  });
  state = execute(state, {
    kind: "emit-run",
    operationId: "emit-2",
    runId: "run-2",
    level: 0,
    sequences: [2],
  });
  state = execute(state, {
    kind: "crash",
    operationId: "crash-after-publication-manifest",
    targetOperationId: "publish-two-runs",
    durableEffectIndex: 0,
    boundary: "after",
  });

  const crashed = executeModelOperation(state, {
    kind: "publish-root",
    operationId: "publish-two-runs",
    publicationId: "publish-two-runs",
    expectedGeneration: 0,
    runKeys: ["runs/run-1", "runs/run-2"],
    foldedThrough: 2,
    role: "tail",
  });

  expect(crashed.outcome).toBe("crashed-after");
  expect(crashed.state.unreclaimedAttempts).toBe(1);
  expect(unreclaimedOwnership(crashed.state)).toEqual([
    ["publish-two-runs", ["manifests/publish-two-runs", "runs/run-1", "runs/run-2"]],
  ]);
});

test.each([-1, 1.5, 3])(
  "an invalid crash effect index %s is cleared and recorded when the target executes",
  (durableEffectIndex) => {
    const armed = executeModelOperation(initialModelState(), {
      kind: "crash",
      operationId: `invalid-arm-${durableEffectIndex}`,
      targetOperationId: "target-append",
      durableEffectIndex,
      boundary: "before",
    }).state;
    const target = executeModelOperation(armed, {
      ...appendFirst,
      operationId: "target-append",
    });

    expect(target.outcome).toBe("applied");
    expect(target.state.pendingCrash).toBeNull();
    expect([...target.state.coverage.rejectedArms]).toEqual([
      `crash/invalid-effect-index/invalid-arm-${durableEffectIndex}`,
    ]);
    const rearmed = executeModelOperation(target.state, {
      kind: "crash",
      operationId: `replacement-arm-${durableEffectIndex}`,
      targetOperationId: "next-append",
      durableEffectIndex: 0,
      boundary: "after",
    });
    expect(rearmed.outcome).toBe("applied");
  },
);

test("a crash arm targeting an operation with no durable effects is cleared and recorded", () => {
  const armed = executeModelOperation(initialModelState(), {
    kind: "crash",
    operationId: "invalid-reconstruct-arm",
    targetOperationId: "target-reconstruct",
    durableEffectIndex: 0,
    boundary: "after",
  }).state;
  const target = executeModelOperation(armed, {
    kind: "reconstruct",
    operationId: "target-reconstruct",
    mode: "cold",
  });

  expect(target.outcome).toBe("applied");
  expect(target.state.pendingCrash).toBeNull();
  expect([...target.state.coverage.rejectedArms]).toEqual([
    "crash/invalid-effect-index/invalid-reconstruct-arm",
  ]);
});

test("retry replays the crashed operation without duplicate objects or acknowledgements", () => {
  const state = executeModelOperation(initialModelState(), {
    kind: "crash",
    operationId: "crash-after-ack",
    targetOperationId: "target-append",
    durableEffectIndex: 2,
    boundary: "after",
  }).state;
  const crashed = executeModelOperation(state, { ...appendFirst, operationId: "target-append" });

  expect(crashed.outcome).toBe("crashed-after");
  const retried = executeModelOperation(crashed.state, {
    kind: "retry",
    operationId: "retry-append",
    targetOperationId: "target-append",
  });

  expect(retried.outcome).toBe("applied");
  expect([...retried.state.store.objects.keys()]).toEqual(["content/mutation-1", "log/1", "ack/1"]);
  expect(retried.state.referenceLedger).toEqual([firstMutation]);

  const repeated = executeModelOperation(retried.state, {
    kind: "retry",
    operationId: "retry-append",
    targetOperationId: "target-append",
  });
  expect(repeated.outcome).toBe("applied");
  expect([...repeated.state.store.objects.keys()]).toEqual([
    "content/mutation-1",
    "log/1",
    "ack/1",
  ]);
  expect(repeated.state.referenceLedger).toEqual([firstMutation]);
});

test("retry replays a publication whose root CAS landed before the crash", () => {
  const armed = executeModelOperation(stateWithFirstRun(), {
    kind: "crash",
    operationId: "crash-after-publish-cas",
    targetOperationId: "target-publish",
    durableEffectIndex: 1,
    boundary: "after",
  }).state;
  const crashed = executeModelOperation(armed, {
    ...publishFirst,
    operationId: "target-publish",
  });

  expect(crashed.outcome).toBe("crashed-after");
  expect(crashed.state.store.root.manifestKey).toBe("manifests/publication-1");
  const retried = executeModelOperation(crashed.state, {
    kind: "retry",
    operationId: "retry-publish",
    targetOperationId: "target-publish",
  });

  expect(retried.outcome).toBe("applied");
  expect(retried.state.store.root).toEqual({
    generation: 1,
    etag: "root/publication-1",
    manifestKey: "manifests/publication-1",
  });
  expect(
    [...retried.state.store.objects.keys()].filter((key) => key === "manifests/publication-1"),
  ).toEqual(["manifests/publication-1"]);
});

test("attempts map a retry operation ID to the retry operation", () => {
  const appended = executeModelOperation(initialModelState(), appendFirst).state;
  const retryOperation = {
    kind: "retry" as const,
    operationId: "retry-append",
    targetOperationId: "append-1",
  };
  const retried = executeModelOperation(appended, retryOperation);

  expect(retried.outcome).toBe("rejected");
  expect(retried.rejectionId).toBe("retry-without-crash");
  expect(retried.state.attempts.get("retry-append")?.operation).toEqual(retryOperation);
});

test("retry rejects another retry as its target", () => {
  const appended = executeModelOperation(initialModelState(), appendFirst).state;
  const retried = executeModelOperation(appended, {
    kind: "retry",
    operationId: "retry-append",
    targetOperationId: "append-1",
  }).state;
  const retryOfRetry = executeModelOperation(retried, {
    kind: "retry",
    operationId: "retry-retry",
    targetOperationId: "retry-append",
  });

  expect(retryOfRetry.outcome).toBe("rejected");
  expect(retryOfRetry.rejectionId).toBe("retry-without-crash");
});

test.each(["cold", "warm", "reference"] as const)(
  "%s reconstruct returns the logical view without changing durable or reference state",
  (mode) => {
    const state = stateWithFoldedRunAndSuffix();
    const transition = executeModelOperation(state, {
      kind: "reconstruct",
      operationId: `reconstruct-${mode}`,
      mode,
    });

    expect(transition.outcome).toBe("applied");
    expect(transition.reconstructionMode).toBe(mode);
    expect(transition.durableEffects).toEqual([]);
    expect([...(transition.reconstruction?.view ?? [])]).toEqual([["b", 2]]);
    expect(transition.reconstruction?.findings).toEqual([]);
    expect(transition.state.store).toBe(state.store);
    expect(transition.state.referenceLedger).toBe(state.referenceLedger);
  },
);

test.each(["cold", "warm"] as const)(
  "%s reconstruct surfaces a missing reachable run through the transition",
  (mode) => {
    const state = stateWithFoldedRunAndSuffix();
    const objects = new Map(state.store.objects);
    objects.delete("runs/folded");
    const missingRunState: ModelState = {
      ...state,
      store: { ...state.store, objects },
    };

    const transition = executeModelOperation(missingRunState, {
      kind: "reconstruct",
      operationId: `reconstruct-missing-${mode}`,
      mode,
    });

    expect(transition.reconstruction?.findings).toContain("missing-reachable-run");
    expect(transition.state.store).toBe(missingRunState.store);
    expect(transition.state.referenceLedger).toBe(missingRunState.referenceLedger);
  },
);

// The three assertions above hold for every mode because this fixture's ledger
// and its durable objects agree, so on their own they would also pass if the
// executor ignored `operation.mode` and always reconstructed cold. These pin the
// dispatch itself: each mode is identified by something only that path does, and
// each was confirmed to fail against a mutant of the path it names.
describe("reconstruct dispatches on the operation mode", () => {
  test("reference reads the reference ledger and not the durable store", () => {
    const state = stateWithFoldedRunAndSuffix();
    const emptyStore: ModelState = {
      ...state,
      store: { ...state.store, objects: new Map() },
    };

    const reference = executeModelOperation(emptyStore, {
      kind: "reconstruct",
      operationId: "reconstruct-reference-empty-store",
      mode: "reference",
    });
    const cold = executeModelOperation(emptyStore, {
      kind: "reconstruct",
      operationId: "reconstruct-cold-empty-store",
      mode: "cold",
    });

    expect([...(reference.reconstruction?.view ?? [])]).toEqual([["b", 2]]);
    expect([...(cold.reconstruction?.view ?? [])]).toEqual([]);
  });

  test("warm consults the warm cache and cold ignores it", () => {
    const state = stateWithFoldedRunAndSuffix();
    const durableRun = state.store.objects.get("runs/folded");
    if (durableRun?.kind !== "run") {
      throw new Error("fixture must publish a folded run");
    }
    // Deep-equal to the durable run but a distinct instance, so whichever one
    // comes back names the path that produced it.
    const cachedRun = structuredClone(durableRun);
    const warmState: ModelState = {
      ...state,
      warmCache: {
        rootGeneration: state.store.root.generation,
        runs: new Map([["runs/folded", cachedRun]]),
      },
    };

    const warm = executeModelOperation(warmState, {
      kind: "reconstruct",
      operationId: "reconstruct-warm-cached",
      mode: "warm",
    });
    const cold = executeModelOperation(warmState, {
      kind: "reconstruct",
      operationId: "reconstruct-cold-cached",
      mode: "cold",
    });

    expect(warm.reconstruction?.cache.runs.get("runs/folded")).toBe(cachedRun);
    expect(cold.reconstruction?.cache.runs.get("runs/folded")).toBe(durableRun);
    expect([...(warm.reconstruction?.view ?? [])]).toEqual([["b", 2]]);
    expect([...(cold.reconstruction?.view ?? [])]).toEqual([["b", 2]]);
  });

  test("reference leaves the warm cache untouched", () => {
    const state = stateWithFoldedRunAndSuffix();

    const reference = executeModelOperation(state, {
      kind: "reconstruct",
      operationId: "reconstruct-keeps-cache",
      mode: "reference",
    });

    expect(reference.state.warmCache).toBe(state.warmCache);
  });
});

test("scheduled reconstruct transitions retain their reconstruction result", () => {
  const run = runModelSchedule(stateWithFoldedRunAndSuffix(), [
    { kind: "reconstruct", operationId: "scheduled-reference", mode: "reference" },
  ]);

  expect([...(run.transitions[0]?.reconstruction?.view ?? [])]).toEqual([["b", 2]]);
});

test("reclaim deletes unreachable candidates and rejects any reachable candidate", () => {
  const raced = executeModelOperation(stateWithFirstRun(), operationFixtures[4]).state;
  expect([...reachableModelObjectKeys(raced.store)]).toContain("manifests/winner");
  expect([...reachableModelObjectKeys(raced.store)]).not.toContain("manifests/loser");

  const reclaimed = executeModelOperation(raced, {
    kind: "reclaim",
    operationId: "reclaim-loser",
    candidateKeys: ["manifests/loser"],
  });
  expect(reclaimed.outcome).toBe("applied");
  expect(reclaimed.state.store.objects.has("manifests/loser")).toBe(false);

  const rejected = executeModelOperation(reclaimed.state, {
    kind: "reclaim",
    operationId: "reclaim-winner",
    candidateKeys: ["manifests/winner"],
  });
  expect(rejected.outcome).toBe("rejected");
  expect(rejected.rejectionId).toBe("reclaim-reachable-object");
  expect(rejected.state.store.objects.has("manifests/winner")).toBe(true);
});

test("reclaim cannot delete an acknowledged append suffix or its dependencies", () => {
  const appended = executeModelOperation(initialModelState(), appendFirst).state;
  const transition = executeModelOperation(appended, {
    kind: "reclaim",
    operationId: "reclaim-acknowledged-suffix",
    candidateKeys: ["ack/1", "log/1", "content/mutation-1"],
  });

  expect(transition.outcome).toBe("rejected");
  expect([...transition.state.store.objects.keys()]).toEqual([
    "content/mutation-1",
    "log/1",
    "ack/1",
  ]);
  expect(transition.state.referenceLedger).toEqual([firstMutation]);
  expect(transition.state.unreclaimedAttempts).toBe(0);
});

describe("content version reachability", () => {
  test("an acknowledged put owns the content version it supersedes", () => {
    const first = execute(initialModelState(), appendFirst);
    const overwritten = execute(first, {
      kind: "append-log",
      operationId: "overwrite-first",
      mutation: overwriteFirstMutation,
      acknowledgement: "acknowledge",
    });

    expect([...reachableModelObjectKeys(overwritten.store)].toSorted()).toEqual([
      "ack/1",
      "ack/2",
      "content/overwrite-1",
      "log/1",
      "log/2",
    ]);
    expect(overwritten.unreclaimedAttempts).toBe(1);
    expect(unreclaimedOwnership(overwritten)).toEqual([
      ["overwrite-first", ["content/mutation-1"]],
    ]);
  });

  test("an acknowledged delete owns the prior live content version", () => {
    const first = execute(initialModelState(), appendFirst);
    const deleted = execute(first, {
      kind: "append-log",
      operationId: "delete-first",
      mutation: deleteFirstMutation,
      acknowledgement: "acknowledge",
    });

    expect([...reachableModelObjectKeys(deleted.store)].toSorted()).toEqual([
      "ack/1",
      "ack/2",
      "log/1",
      "log/2",
    ]);
    expect(deleted.unreclaimedAttempts).toBe(1);
    expect(unreclaimedOwnership(deleted)).toEqual([["delete-first", ["content/mutation-1"]]]);
  });

  test("an unacknowledged overwrite cannot displace the latest committed content", () => {
    let state = execute(initialModelState(), appendFirst);
    state = execute(state, {
      kind: "append-log",
      operationId: "overwrite-first",
      mutation: overwriteFirstMutation,
      acknowledgement: "acknowledge",
    });
    state = execute(state, {
      kind: "append-log",
      operationId: "drop-overwrite",
      mutation: {
        mutationId: "dropped-overwrite",
        sequence: 3,
        documentId: "document-1",
        change: { kind: "put", value: 43 },
      },
      acknowledgement: "drop",
    });

    expect([...reachableModelObjectKeys(state.store)].toSorted()).toEqual([
      "ack/1",
      "ack/2",
      "content/overwrite-1",
      "log/1",
      "log/2",
    ]);
    expect(state.unreclaimedAttempts).toBe(2);
    expect(unreclaimedOwnership(state)).toEqual([
      ["drop-overwrite", ["content/dropped-overwrite", "log/3"]],
      ["overwrite-first", ["content/mutation-1"]],
    ]);
  });

  test("repeated acknowledged overwrites create one live owner per obsolete version", () => {
    let state = execute(initialModelState(), appendFirst);
    state = execute(state, {
      kind: "append-log",
      operationId: "overwrite-first",
      mutation: overwriteFirstMutation,
      acknowledgement: "acknowledge",
    });
    state = execute(state, {
      kind: "append-log",
      operationId: "overwrite-second",
      mutation: {
        mutationId: "overwrite-2",
        sequence: 3,
        documentId: "document-1",
        change: { kind: "put", value: 43 },
      },
      acknowledgement: "acknowledge",
    });

    expect(
      [...reachableModelObjectKeys(state.store)].filter((key) => key.startsWith("content/")),
    ).toEqual(["content/overwrite-2"]);
    expect(state.unreclaimedAttempts).toBe(2);
    expect(unreclaimedOwnership(state)).toEqual([
      ["overwrite-first", ["content/mutation-1"]],
      ["overwrite-second", ["content/overwrite-1"]],
    ]);
  });

  test("published run content remains reachable after folded log reclamation", () => {
    let state = execute(stateWithFirstRun(), publishFirst);

    expect([...reachableModelObjectKeys(state.store)].toSorted()).toEqual([
      "content/mutation-1",
      "manifests/publication-1",
      "runs/run-1",
    ]);
    expect(unreclaimedOwnership(state)).toEqual([["publish-1", ["ack/1", "log/1"]]]);

    state = execute(state, {
      kind: "reclaim",
      operationId: "reclaim-folded-log",
      candidateKeys: ["ack/1", "log/1"],
    });
    expect([...reachableModelObjectKeys(state.store)].toSorted()).toEqual([
      "content/mutation-1",
      "manifests/publication-1",
      "runs/run-1",
    ]);
    expect(state.unreclaimedAttempts).toBe(0);

    const rejected = executeModelOperation(state, {
      kind: "reclaim",
      operationId: "reclaim-live-content",
      candidateKeys: ["content/mutation-1"],
    });
    expect(rejected.outcome).toBe("rejected");
    expect(rejected.rejectionId).toBe("reclaim-reachable-object");
  });

  test.each([
    {
      boundary: "before" as const,
      outcome: "crashed-before",
      reachableContent: "content/mutation-1",
      orphanKeys: ["content/overwrite-1", "log/2"],
    },
    {
      boundary: "after" as const,
      outcome: "crashed-after",
      reachableContent: "content/overwrite-1",
      orphanKeys: ["content/mutation-1"],
    },
  ])(
    "an overwrite crashing $boundary its acknowledgement changes content only after commit",
    ({ boundary, outcome, reachableContent, orphanKeys }) => {
      const armed = execute(execute(initialModelState(), appendFirst), {
        kind: "crash",
        operationId: `crash-${boundary}-overwrite-ack`,
        targetOperationId: "overwrite-with-crash",
        durableEffectIndex: 2,
        boundary,
      });
      const transition = executeModelOperation(armed, {
        kind: "append-log",
        operationId: "overwrite-with-crash",
        mutation: overwriteFirstMutation,
        acknowledgement: "acknowledge",
      });

      expect(transition.outcome).toBe(outcome);
      expect([...reachableModelObjectKeys(transition.state.store)]).toContain(reachableContent);
      expect(
        [...reachableModelObjectKeys(transition.state.store)].filter((key) =>
          key.startsWith("content/"),
        ),
      ).toEqual([reachableContent]);
      expect(unreclaimedOwnership(transition.state)).toEqual([
        ["overwrite-with-crash", orphanKeys],
      ]);
    },
  );

  test("reclaim deletes obsolete content without deleting suffix history or live content", () => {
    let state = execute(initialModelState(), appendFirst);
    state = execute(state, {
      kind: "append-log",
      operationId: "overwrite-first",
      mutation: overwriteFirstMutation,
      acknowledgement: "acknowledge",
    });

    const reclaimed = executeModelOperation(state, {
      kind: "reclaim",
      operationId: "reclaim-obsolete-content",
      candidateKeys: ["content/mutation-1"],
    });

    expect(reclaimed.outcome).toBe("applied");
    expect([...reclaimed.state.store.objects.keys()].toSorted()).toEqual([
      "ack/1",
      "ack/2",
      "content/overwrite-1",
      "log/1",
      "log/2",
    ]);
    expect(reclaimed.state.unreclaimedAttempts).toBe(0);
    expect(unreclaimedOwnership(reclaimed.state)).toEqual([]);
  });
});

describe("unreclaimed attempt accounting", () => {
  test("attributes a first publication's folded acknowledged suffix to one publication attempt", () => {
    let state = initialModelState();
    const mutations = [
      firstMutation,
      secondMutation,
      {
        mutationId: "mutation-3",
        sequence: 3,
        documentId: "document-3",
        change: { kind: "put" as const, value: 43 },
      },
    ];
    for (const mutation of mutations) {
      state = execute(state, {
        kind: "append-log",
        operationId: `append-${mutation.sequence}`,
        mutation,
        acknowledgement: "acknowledge",
      });
    }
    state = execute(state, {
      kind: "emit-run",
      operationId: "emit-folded-suffix",
      runId: "folded-suffix",
      level: 0,
      sequences: [1, 2, 3],
    });
    state = execute(state, {
      kind: "publish-root",
      operationId: "publish-folded-suffix",
      publicationId: "folded-suffix",
      expectedGeneration: 0,
      runKeys: ["runs/folded-suffix"],
      foldedThrough: 3,
      role: "tail",
    });

    expect(state.unreclaimedAttempts).toBe(1);
    expect(unreclaimedOwnership(state)).toEqual([
      ["publish-folded-suffix", ["ack/1", "ack/2", "ack/3", "log/1", "log/2", "log/3"]],
    ]);

    state = execute(state, {
      kind: "reclaim",
      operationId: "reclaim-folded-suffix",
      candidateKeys: ["ack/1", "ack/2", "ack/3", "log/1", "log/2", "log/3"],
    });
    expect(state.unreclaimedAttempts).toBe(0);
    expect(unreclaimedOwnership(state)).toEqual([]);
  });

  test("counts each superseded publication but not the first publication", () => {
    let state = initialModelState();
    const mutations = [
      firstMutation,
      secondMutation,
      {
        mutationId: "mutation-3",
        sequence: 3,
        documentId: "document-3",
        change: { kind: "put" as const, value: 43 },
      },
    ];
    for (const mutation of mutations) {
      state = execute(state, {
        kind: "append-log",
        operationId: `append-${mutation.sequence}`,
        mutation,
        acknowledgement: "acknowledge",
      });
    }
    state = execute(state, {
      kind: "emit-run",
      operationId: "emit-shared",
      runId: "shared",
      level: 0,
      sequences: [1, 2, 3],
    });

    const counts: number[] = [];
    for (let generation = 0; generation < 10; generation += 1) {
      state = execute(state, {
        kind: "publish-root",
        operationId: `publish-${generation}`,
        publicationId: `publication-${generation}`,
        expectedGeneration: generation,
        runKeys: ["runs/shared"],
        foldedThrough: 0,
        role: "tail",
      });
      counts.push(state.unreclaimedAttempts);
    }

    expect(counts).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(unreclaimedOwnership(state)).toEqual(
      Array.from({ length: 9 }, (_, index) => [
        `publish-${index + 1}`,
        [`manifests/publication-${index}`],
      ]),
    );
  });

  test("lost CAS counts its losing artifacts and the superseded prior publication", () => {
    const state = stateWithPriorPublicationRace();

    expect(state.unreclaimedAttempts).toBe(2);
    expect([...reachableModelObjectKeys(state.store)]).not.toContain("manifests/publication-1");
    expect([...reachableModelObjectKeys(state.store)]).not.toContain("manifests/race-loser");
    expect(unreclaimedOwnership(state)).toEqual([
      ["race-loser", ["manifests/race-loser"]],
      ["race-winner", ["manifests/publication-1"]],
    ]);
  });

  test("reclaiming predecessor and loser artifacts restores the live count to zero", () => {
    const state = stateWithPriorPublicationRace();
    expect(state.unreclaimedAttempts).toBe(2);
    const transition = executeModelOperation(state, {
      kind: "reclaim",
      operationId: "reclaim-race-artifacts",
      candidateKeys: ["manifests/publication-1", "manifests/race-loser"],
    });

    expect(transition.outcome).toBe("applied");
    expect(transition.state.store.objects.has("manifests/publication-1")).toBe(false);
    expect(transition.state.store.objects.has("manifests/race-loser")).toBe(false);
    expect(transition.state.unreclaimedAttempts).toBe(0);
    expect(unreclaimedOwnership(transition.state)).toEqual([]);
  });

  test("a dropped append is one completed attempt responsible for orphan objects", () => {
    const transition = executeModelOperation(initialModelState(), {
      ...appendFirst,
      operationId: "append-dropped",
      acknowledgement: "drop",
    });

    expect(transition.state.unreclaimedAttempts).toBe(1);
    expect(unreclaimedOwnership(transition.state)).toEqual([
      ["append-dropped", ["content/mutation-1", "log/1"]],
    ]);
  });

  test("publishing an emitted run removes its attempt from the live count", () => {
    const appended = execute(initialModelState(), appendFirst);
    const emitted = execute(appended, emitFirst);
    const published = execute(emitted, { ...publishFirst, foldedThrough: 0 });

    expect(appended.unreclaimedAttempts).toBe(0);
    expect(emitted.unreclaimedAttempts).toBe(1);
    expect(published.unreclaimedAttempts).toBe(0);
    expect(unreclaimedOwnership(emitted)).toEqual([["emit-1", ["runs/run-1"]]]);
    expect(unreclaimedOwnership(published)).toEqual([]);
  });

  test("idempotent publication replay does not duplicate live ownership", () => {
    const armed = execute(stateWithFirstRun(), {
      kind: "crash",
      operationId: "crash-after-fold-cas",
      targetOperationId: "target-fold",
      durableEffectIndex: 1,
      boundary: "after",
    });
    const crashed = execute(armed, {
      ...publishFirst,
      operationId: "target-fold",
    });
    const ownershipAfterCrash = unreclaimedOwnership(crashed);

    const retried = execute(crashed, {
      kind: "retry",
      operationId: "retry-fold",
      targetOperationId: "target-fold",
    });

    expect(crashed.unreclaimedAttempts).toBe(1);
    expect(ownershipAfterCrash).toEqual([["target-fold", ["ack/1", "log/1"]]]);
    expect(retried.unreclaimedAttempts).toBe(1);
    expect(unreclaimedOwnership(retried)).toEqual(ownershipAfterCrash);
  });

  test("a reachable object loses its old owner before a later publication orphans it again", () => {
    let state = stateWithFirstPublishedRun();
    state = execute(state, {
      kind: "append-log",
      operationId: "append-2",
      mutation: secondMutation,
      acknowledgement: "acknowledge",
    });
    state = execute(state, {
      kind: "emit-run",
      operationId: "emit-2",
      runId: "run-2",
      level: 0,
      sequences: [2],
    });
    state = execute(state, {
      kind: "publish-root",
      operationId: "publish-run-2",
      publicationId: "run-2",
      expectedGeneration: 1,
      runKeys: ["runs/run-2"],
      foldedThrough: 0,
      role: "tail",
    });
    expect(unreclaimedOwnership(state)).toContainEqual([
      "publish-run-2",
      ["manifests/publication-1", "runs/run-1"],
    ]);

    state = execute(state, {
      kind: "publish-root",
      operationId: "republish-run-1",
      publicationId: "run-1-again",
      expectedGeneration: 2,
      runKeys: ["runs/run-1"],
      foldedThrough: 0,
      role: "tail",
    });
    expect(unreclaimedOwnership(state)).toContainEqual([
      "publish-run-2",
      ["manifests/publication-1"],
    ]);

    state = execute(state, {
      kind: "publish-root",
      operationId: "publish-run-2-again",
      publicationId: "run-2-again",
      expectedGeneration: 3,
      runKeys: ["runs/run-2"],
      foldedThrough: 0,
      role: "tail",
    });
    expect(unreclaimedOwnership(state)).toContainEqual([
      "publish-run-2-again",
      ["manifests/run-1-again", "runs/run-1"],
    ]);
  });

  test("merge and replacement publication transfer responsibility to retired attempts", () => {
    let state = stateWithFirstRun();
    state = execute(state, {
      kind: "append-log",
      operationId: "append-2",
      mutation: secondMutation,
      acknowledgement: "acknowledge",
    });
    state = execute(state, {
      kind: "emit-run",
      operationId: "emit-2",
      runId: "run-2",
      level: 0,
      sequences: [2],
    });
    expect(state.unreclaimedAttempts).toBe(2);

    state = execute(state, {
      kind: "publish-root",
      operationId: "publish-input-runs",
      publicationId: "input-runs",
      expectedGeneration: 0,
      runKeys: ["runs/run-1", "runs/run-2"],
      foldedThrough: 0,
      role: "tail",
    });
    expect(state.unreclaimedAttempts).toBe(0);

    state = execute(state, {
      kind: "merge-runs",
      operationId: "merge-input-runs",
      mergeId: "merge-input-runs",
      inputRunKeys: ["runs/run-1", "runs/run-2"],
      outputRunId: "merged",
      targetLevel: 1,
    });
    expect(state.unreclaimedAttempts).toBe(1);

    state = execute(state, {
      kind: "publish-root",
      operationId: "publish-merged-run",
      publicationId: "merged-run",
      expectedGeneration: 1,
      runKeys: ["runs/merged"],
      foldedThrough: 2,
      role: "base",
    });
    expect(state.unreclaimedAttempts).toBe(1);
    expect(unreclaimedOwnership(state)).toEqual([
      [
        "publish-merged-run",
        ["ack/1", "ack/2", "log/1", "log/2", "manifests/input-runs", "runs/run-1", "runs/run-2"],
      ],
    ]);
  });
});

test("runModelSchedule preserves the initial state and records every transition", () => {
  const initial = initialModelState();
  const run = runModelSchedule(initial, [appendFirst, emitFirst]);

  expect(run.initial).toBe(initial);
  expect(run.transitions.map(({ operation }) => operation.operationId)).toEqual([
    "append-1",
    "emit-1",
  ]);
  expect(run.final.store.objects.has("runs/run-1")).toBe(true);
});
