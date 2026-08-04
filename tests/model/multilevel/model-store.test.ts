import { describe, expect, test } from "vitest";
import {
  applyModelDurableEffect,
  emptyModelStore,
  reachableModelObjectKeys,
} from "./model-store.ts";
import { reconstructModelCold } from "./reconstruct.ts";
import type {
  ModelDurableEffect,
  ModelLogObject,
  ModelManifestObject,
  ModelMutation,
  ModelStore,
} from "./types.ts";

const logObject: ModelLogObject = {
  kind: "log",
  key: "log/1",
  mutation: {
    mutationId: "mutation-1",
    sequence: 1,
    documentId: "document-1",
    change: { kind: "put", value: 41 },
  },
  contentKey: "content/document-1",
};

const manifestObject: ModelManifestObject = {
  kind: "manifest",
  key: "manifests/publication-1",
  generation: 1,
  predecessorKey: null,
  foldedThrough: 1,
  levels: [{ level: 0, runKeys: ["runs/run-1"] }],
};

const putLog: ModelDurableEffect = { kind: "put-immutable", object: logObject };

function apply(store: ModelStore, effect: ModelDurableEffect): ModelStore {
  return applyModelDurableEffect(store, effect, null).store;
}

function appendSuffixObjects(
  store: ModelStore,
  mutation: ModelMutation,
  acknowledged: boolean,
): ModelStore {
  let next = store;
  const contentKey = mutation.change.kind === "put" ? `content/${mutation.mutationId}` : null;
  if (mutation.change.kind === "put") {
    next = apply(next, {
      kind: "put-immutable",
      object: {
        kind: "content",
        key: contentKey as string,
        documentId: mutation.documentId,
        value: mutation.change.value,
      },
    });
  }
  next = apply(next, {
    kind: "put-immutable",
    object: {
      kind: "log",
      key: `log/${mutation.sequence}`,
      mutation,
      contentKey,
    },
  });
  return acknowledged
    ? apply(next, {
        kind: "put-immutable",
        object: {
          kind: "ack",
          key: `ack/${mutation.sequence}`,
          sequence: mutation.sequence,
          mutationId: mutation.mutationId,
        },
      })
    : next;
}

describe("immutable object writes", () => {
  test("replaying a structurally equal immutable put is idempotent", () => {
    const once = apply(emptyModelStore(), putLog);
    const replay = applyModelDurableEffect(
      once,
      {
        kind: "put-immutable",
        object: {
          ...logObject,
          mutation: { ...logObject.mutation, change: { kind: "put", value: 41 } },
        },
      },
      null,
    );

    expect(replay.outcome).toBe("applied");
    expect([...replay.store.objects.entries()]).toEqual([["log/1", logObject]]);
  });

  test("rejects a different immutable body at an occupied key", () => {
    const once = apply(emptyModelStore(), putLog);
    const conflict = applyModelDurableEffect(
      once,
      {
        kind: "put-immutable",
        object: {
          ...logObject,
          mutation: { ...logObject.mutation, change: { kind: "put", value: 99 } },
        },
      },
      null,
    );

    expect(conflict.outcome).toBe("conflict");
    expect(conflict.store.objects.get("log/1")).toEqual(logObject);
  });
});

test("a stale root CAS leaves the root pointer unchanged", () => {
  const store = emptyModelStore();
  const stale = applyModelDurableEffect(
    store,
    {
      kind: "cas-root",
      expectedEtag: "stale-etag",
      next: { generation: 1, etag: "root-1", manifestKey: manifestObject.key },
    },
    null,
  );

  expect(stale.outcome).toBe("conflict");
  expect(stale.store.root).toEqual({ generation: 0, etag: "root-0", manifestKey: null });
});

test("a CAS replay succeeds when the desired root pointer already landed", () => {
  const effect: ModelDurableEffect = {
    kind: "cas-root",
    expectedEtag: "root-0",
    next: { generation: 1, etag: "root-1", manifestKey: manifestObject.key },
  };
  const once = apply(emptyModelStore(), effect);
  const replay = applyModelDurableEffect(once, effect, null);

  expect(replay.outcome).toBe("applied");
  expect(replay.store.root).toEqual(effect.next);
});

test("delete removes only the exact object key", () => {
  const withObjects = apply(apply(emptyModelStore(), putLog), {
    kind: "put-immutable",
    object: { ...logObject, key: "log/10" },
  });
  const deleted = applyModelDurableEffect(
    withObjects,
    { kind: "delete-object", key: "log/1" },
    null,
  );

  expect([...deleted.store.objects.keys()]).toEqual(["log/10"]);
});

describe.each([
  {
    name: "immutable put",
    prepare: () => emptyModelStore(),
    effect: putLog,
    applied: (store: ModelStore) => store.objects.has("log/1"),
  },
  {
    name: "root CAS",
    prepare: () => emptyModelStore(),
    effect: {
      kind: "cas-root",
      expectedEtag: "root-0",
      next: { generation: 1, etag: "root-1", manifestKey: manifestObject.key },
    } satisfies ModelDurableEffect,
    applied: (store: ModelStore) => store.root.generation === 1,
  },
  {
    name: "object deletion",
    prepare: () => apply(emptyModelStore(), putLog),
    effect: { kind: "delete-object", key: "log/1" } satisfies ModelDurableEffect,
    applied: (store: ModelStore) => !store.objects.has("log/1"),
  },
])("$name crash boundaries", ({ prepare, effect, applied }) => {
  test("a before crash preserves the original durable store", () => {
    const original = prepare();
    const result = applyModelDurableEffect(original, effect, "before");

    expect(result.outcome).toBe("crashed-before");
    expect(result.store).toBe(original);
    expect(applied(result.store)).toBe(false);
  });

  test("an after crash returns the applied durable store", () => {
    const original = prepare();
    const result = applyModelDurableEffect(original, effect, "after");

    expect(result.outcome).toBe("crashed-after");
    expect(result.store).not.toBe(original);
    expect(applied(result.store)).toBe(true);
  });
});

describe.each([
  {
    name: "conflicting immutable put",
    prepare: () => apply(emptyModelStore(), putLog),
    effect: {
      kind: "put-immutable",
      object: {
        ...logObject,
        mutation: { ...logObject.mutation, change: { kind: "put", value: 99 } },
      },
    } satisfies ModelDurableEffect,
    durableValue: (store: ModelStore) => store.objects.get("log/1"),
    expectedValue: logObject,
  },
  {
    name: "stale root CAS",
    prepare: () => emptyModelStore(),
    effect: {
      kind: "cas-root",
      expectedEtag: "stale-etag",
      next: { generation: 1, etag: "root-1", manifestKey: manifestObject.key },
    } satisfies ModelDurableEffect,
    durableValue: (store: ModelStore) => store.root,
    expectedValue: { generation: 0, etag: "root-0", manifestKey: null },
  },
])("$name with an after crash", ({ prepare, effect, durableValue, expectedValue }) => {
  test("preserves the conflict outcome without applying the effect", () => {
    const result = applyModelDurableEffect(prepare(), effect, "after");

    expect(result.outcome).toBe("conflict");
    expect(result.traceEntry.outcome).toBe("conflict");
    expect(durableValue(result.store)).toEqual(expectedValue);
  });
});

test("reachability follows the published manifest and its run keys", () => {
  const runObject = {
    kind: "run" as const,
    key: "runs/run-1",
    level: 0,
    mutations: [logObject.mutation],
    complete: true as const,
  };
  let store = apply(emptyModelStore(), {
    kind: "put-immutable",
    object: {
      kind: "content",
      key: "content/mutation-1",
      documentId: "document-1",
      value: 41,
    },
  });
  store = apply(store, { kind: "put-immutable", object: runObject });
  store = apply(store, { kind: "put-immutable", object: manifestObject });
  store = apply(store, {
    kind: "cas-root",
    expectedEtag: "root-0",
    next: { generation: 1, etag: "root-1", manifestKey: manifestObject.key },
  });

  expect([...reachableModelObjectKeys(store)].toSorted()).toEqual([
    "content/mutation-1",
    "manifests/publication-1",
    "runs/run-1",
  ]);
});

test("reachability retains acknowledged suffix objects above foldedThrough", () => {
  const secondLog: ModelLogObject = {
    kind: "log",
    key: "log/2",
    mutation: {
      mutationId: "mutation-2",
      sequence: 2,
      documentId: "document-2",
      change: { kind: "put", value: 42 },
    },
    contentKey: "content/mutation-2",
  };
  let store = apply(emptyModelStore(), {
    kind: "put-immutable",
    object: {
      kind: "content",
      key: "content/mutation-2",
      documentId: "document-2",
      value: 42,
    },
  });
  store = apply(store, { kind: "put-immutable", object: secondLog });
  store = apply(store, {
    kind: "put-immutable",
    object: {
      kind: "ack",
      key: "ack/2",
      sequence: 2,
      mutationId: "mutation-2",
    },
  });
  store = apply(store, {
    kind: "put-immutable",
    object: { ...manifestObject, foldedThrough: 1, levels: [] },
  });
  store = apply(store, {
    kind: "cas-root",
    expectedEtag: "root-0",
    next: { generation: 1, etag: "root-1", manifestKey: manifestObject.key },
  });

  expect([...reachableModelObjectKeys(store)].toSorted()).toEqual([
    "ack/2",
    "content/mutation-2",
    "log/2",
    "manifests/publication-1",
  ]);
});

test("suffix reachability keeps log and ack history but only the latest committed content", () => {
  const firstPut: ModelMutation = {
    mutationId: "put-1",
    sequence: 1,
    documentId: "document-1",
    change: { kind: "put", value: 1 },
  };
  const secondPut: ModelMutation = {
    mutationId: "put-2",
    sequence: 2,
    documentId: "document-1",
    change: { kind: "put", value: 2 },
  };
  const droppedPut: ModelMutation = {
    mutationId: "put-dropped",
    sequence: 3,
    documentId: "document-1",
    change: { kind: "put", value: 3 },
  };
  const committedDelete: ModelMutation = {
    mutationId: "delete-4",
    sequence: 4,
    documentId: "document-1",
    change: { kind: "delete" },
  };

  let store = appendSuffixObjects(emptyModelStore(), firstPut, true);
  store = appendSuffixObjects(store, secondPut, true);
  expect([...reachableModelObjectKeys(store)].toSorted()).toEqual([
    "ack/1",
    "ack/2",
    "content/put-2",
    "log/1",
    "log/2",
  ]);

  store = appendSuffixObjects(store, droppedPut, false);
  expect([...reachableModelObjectKeys(store)].toSorted()).toEqual([
    "ack/1",
    "ack/2",
    "content/put-2",
    "log/1",
    "log/2",
  ]);

  store = appendSuffixObjects(store, committedDelete, true);
  expect([...reachableModelObjectKeys(store)].toSorted()).toEqual([
    "ack/1",
    "ack/2",
    "ack/4",
    "log/1",
    "log/2",
    "log/4",
  ]);
});

test("published runs and the committed suffix jointly select the latest content", () => {
  const foldedPut: ModelMutation = {
    mutationId: "folded-put",
    sequence: 1,
    documentId: "document-1",
    change: { kind: "put", value: 1 },
  };
  const suffixPut: ModelMutation = {
    mutationId: "suffix-put",
    sequence: 2,
    documentId: "document-1",
    change: { kind: "put", value: 2 },
  };
  const run = {
    kind: "run" as const,
    key: "runs/folded",
    level: 0,
    mutations: [foldedPut],
    complete: true as const,
  };
  const manifest: ModelManifestObject = {
    ...manifestObject,
    foldedThrough: 1,
    levels: [{ level: 0, runKeys: [run.key] }],
  };
  let store = appendSuffixObjects(emptyModelStore(), foldedPut, true);
  store = apply(store, { kind: "put-immutable", object: run });
  store = apply(store, { kind: "put-immutable", object: manifest });
  store = apply(store, {
    kind: "cas-root",
    expectedEtag: "root-0",
    next: { generation: 1, etag: "root-1", manifestKey: manifest.key },
  });
  store = appendSuffixObjects(store, suffixPut, true);

  expect([...reachableModelObjectKeys(store)].toSorted()).toEqual([
    "ack/2",
    "content/suffix-put",
    "log/2",
    "manifests/publication-1",
    "runs/folded",
  ]);
});

test("reachability excludes superseded predecessor manifests and their retired runs", () => {
  const currentRun = {
    kind: "run" as const,
    key: "runs/current",
    level: 0,
    mutations: [logObject.mutation],
    complete: true as const,
  };
  const retiredRun = { ...currentRun, key: "runs/retired" };
  const retiredManifest: ModelManifestObject = {
    ...manifestObject,
    key: "manifests/retired",
    levels: [{ level: 0, runKeys: [retiredRun.key] }],
  };
  const currentManifest: ModelManifestObject = {
    ...manifestObject,
    key: "manifests/current",
    generation: 2,
    predecessorKey: retiredManifest.key,
    levels: [{ level: 0, runKeys: [currentRun.key] }],
  };
  let store = apply(emptyModelStore(), { kind: "put-immutable", object: retiredRun });
  store = apply(store, { kind: "put-immutable", object: currentRun });
  store = apply(store, { kind: "put-immutable", object: retiredManifest });
  store = apply(store, { kind: "put-immutable", object: currentManifest });
  store = apply(store, {
    kind: "cas-root",
    expectedEtag: "root-0",
    next: { generation: 2, etag: "root-current", manifestKey: currentManifest.key },
  });

  expect([...reachableModelObjectKeys(store)].toSorted()).toEqual([
    "content/mutation-1",
    "manifests/current",
    "runs/current",
  ]);
});

// Sequence 0 is a valid point in the model domain, and "nothing has been
// folded" must not be spelled the same way as "sequence 0 has been folded".
// Reachability once defaulted `foldedThrough` to 0 while reconstruction and
// the committed-suffix count defaulted to -1, so an acknowledged sequence-0
// entry with no manifest was reclaimable and simultaneously served by
// reconstruction. Both tests below fail against that default.
describe("sequence-0 suffix entries with no published manifest", () => {
  function storeWithAcknowledgedSequenceZero(): ModelStore {
    const mutation: ModelMutation = {
      mutationId: "mutation-0",
      sequence: 0,
      documentId: "document-0",
      change: { kind: "put", value: 7 },
    };
    let store = apply(emptyModelStore(), {
      kind: "put-immutable",
      object: {
        kind: "content",
        key: "content/mutation-0",
        documentId: "document-0",
        value: 7,
      },
    });
    store = apply(store, {
      kind: "put-immutable",
      object: { kind: "log", key: "log/0", mutation, contentKey: "content/mutation-0" },
    });
    return apply(store, {
      kind: "put-immutable",
      object: { kind: "ack", key: "ack/0", sequence: 0, mutationId: "mutation-0" },
    });
  }

  test("stay reachable", () => {
    const store = storeWithAcknowledgedSequenceZero();

    expect(store.root.manifestKey).toBeNull();
    expect([...reachableModelObjectKeys(store)].toSorted()).toEqual([
      "ack/0",
      "content/mutation-0",
      "log/0",
    ]);
  });

  test("are not reclaimable while cold reconstruction still serves them", () => {
    const store = storeWithAcknowledgedSequenceZero();
    const reachable = reachableModelObjectKeys(store);
    const { view, findings } = reconstructModelCold(store);

    expect(findings).toEqual([]);
    expect(view.get("document-0")).toBe(7);
    // Anything the reconstructed view depends on must survive reclamation.
    expect(reachable.has("content/mutation-0")).toBe(true);
  });
});
