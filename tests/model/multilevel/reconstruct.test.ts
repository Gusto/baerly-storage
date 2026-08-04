import { expect, test } from "vitest";
import {
  equalModelViews,
  reconstructModelCold,
  reconstructModelReference,
  reconstructModelWarm,
} from "./reconstruct.ts";
import { executeModelOperation, initialModelState } from "./executor.ts";
import type {
  ModelMutation,
  ModelObject,
  ModelRunObject,
  ModelStore,
  ModelWarmCache,
} from "./types.ts";

const putA: ModelMutation = {
  mutationId: "put-a",
  sequence: 0,
  documentId: "a",
  change: { kind: "put", value: 1 },
};

const putB: ModelMutation = {
  mutationId: "put-b",
  sequence: 1,
  documentId: "b",
  change: { kind: "put", value: 2 },
};

const deleteA: ModelMutation = {
  mutationId: "delete-a",
  sequence: 2,
  documentId: "a",
  change: { kind: "delete" },
};

const unacknowledgedGhost: ModelMutation = {
  mutationId: "put-ghost",
  sequence: 3,
  documentId: "ghost",
  change: { kind: "put", value: 9 },
};

const foldedRun: ModelRunObject = {
  kind: "run",
  key: "runs/folded-0-1",
  level: 0,
  mutations: [putB, putA],
  complete: true,
};

const foldedStore: ModelStore = {
  root: {
    generation: 1,
    etag: "root/folded-0-1",
    manifestKey: "manifests/folded-0-1",
  },
  objects: new Map<string, ModelObject>([
    [foldedRun.key, foldedRun],
    [
      "manifests/folded-0-1",
      {
        kind: "manifest",
        key: "manifests/folded-0-1",
        generation: 1,
        predecessorKey: null,
        foldedThrough: 1,
        levels: [{ level: 0, runKeys: [foldedRun.key] }],
      },
    ],
    [
      "content/put-b",
      {
        kind: "content",
        key: "content/put-b",
        documentId: "b",
        value: 2,
      },
    ],
    [
      "log/2",
      {
        kind: "log",
        key: "log/2",
        mutation: deleteA,
        contentKey: null,
      },
    ],
    [
      "ack/2",
      {
        kind: "ack",
        key: "ack/2",
        sequence: 2,
        mutationId: deleteA.mutationId,
      },
    ],
    [
      "content/put-ghost",
      {
        kind: "content",
        key: "content/put-ghost",
        documentId: "ghost",
        value: 9,
      },
    ],
    [
      "log/3",
      {
        kind: "log",
        key: "log/3",
        mutation: unacknowledgedGhost,
        contentKey: "content/put-ghost",
      },
    ],
  ]),
  durableTrace: [],
};

const warmCache: ModelWarmCache = {
  rootGeneration: 1,
  runs: new Map([[foldedRun.key, foldedRun]]),
};

const entries = (view: ReadonlyMap<string, number>): readonly (readonly [string, number])[] => [
  ...view.entries(),
];

test("reference replay orders the acknowledged ledger and excludes an unacknowledged mutation", () => {
  const view = reconstructModelReference([deleteA, putB, putA]);

  expect(entries(view)).toEqual([["b", 2]]);
  expect(equalModelViews(view, new Map([["b", 2]]))).toBe(true);
  expect(equalModelViews(view, new Map([["b", 3]]))).toBe(false);
});

test("cold and warm reconstruction combine the folded run with only the acknowledged suffix", () => {
  const cold = reconstructModelCold(foldedStore);
  const warm = reconstructModelWarm(foldedStore, warmCache);

  expect(entries(cold.view)).toEqual([["b", 2]]);
  expect(entries(warm.view)).toEqual([["b", 2]]);
  expect(cold.findings).toEqual([]);
  expect(warm.findings).toEqual([]);
  expect([...cold.cache.runs.keys()]).toEqual([foldedRun.key]);
  expect([...warm.cache.runs.keys()]).toEqual([foldedRun.key]);
});

test("reconstruction ignores reclaimed content for a suffix put superseded by a later put", () => {
  const firstPut: ModelMutation = {
    mutationId: "put-1",
    sequence: 1,
    documentId: "document-1",
    change: { kind: "put", value: 41 },
  };
  const overwrite: ModelMutation = {
    mutationId: "put-2",
    sequence: 2,
    documentId: "document-1",
    change: { kind: "put", value: 42 },
  };
  const first = executeModelOperation(initialModelState(), {
    kind: "append-log",
    operationId: "append-put-1",
    mutation: firstPut,
    acknowledgement: "acknowledge",
  });
  const overwritten = executeModelOperation(first.state, {
    kind: "append-log",
    operationId: "append-put-2",
    mutation: overwrite,
    acknowledgement: "acknowledge",
  });
  const reclaimed = executeModelOperation(overwritten.state, {
    kind: "reclaim",
    operationId: "reclaim-obsolete-put-1",
    candidateKeys: ["content/put-1"],
  });

  expect(reclaimed.outcome).toBe("applied");
  expect(reclaimed.state.store.objects.has("content/put-1")).toBe(false);
  const cold = reconstructModelCold(reclaimed.state.store);
  const warm = reconstructModelWarm(reclaimed.state.store, reclaimed.state.warmCache);

  expect(entries(cold.view)).toEqual([["document-1", 42]]);
  expect(entries(warm.view)).toEqual([["document-1", 42]]);
  expect(cold.findings).toEqual([]);
  expect(warm.findings).toEqual([]);
});

test("reconstruction ignores reclaimed content for a suffix put superseded by a delete", () => {
  const firstPut: ModelMutation = {
    mutationId: "put-1",
    sequence: 1,
    documentId: "document-1",
    change: { kind: "put", value: 41 },
  };
  const deletion: ModelMutation = {
    mutationId: "delete-2",
    sequence: 2,
    documentId: "document-1",
    change: { kind: "delete" },
  };
  const first = executeModelOperation(initialModelState(), {
    kind: "append-log",
    operationId: "append-put-1",
    mutation: firstPut,
    acknowledgement: "acknowledge",
  });
  const deleted = executeModelOperation(first.state, {
    kind: "append-log",
    operationId: "append-delete-2",
    mutation: deletion,
    acknowledgement: "acknowledge",
  });
  const reclaimed = executeModelOperation(deleted.state, {
    kind: "reclaim",
    operationId: "reclaim-deleted-put-1",
    candidateKeys: ["content/put-1"],
  });

  expect(reclaimed.outcome).toBe("applied");
  expect(reclaimed.state.store.objects.has("content/put-1")).toBe(false);
  const cold = reconstructModelCold(reclaimed.state.store);
  const warm = reconstructModelWarm(reclaimed.state.store, reclaimed.state.warmCache);

  expect(entries(cold.view)).toEqual([]);
  expect(entries(warm.view)).toEqual([]);
  expect(cold.findings).toEqual([]);
  expect(warm.findings).toEqual([]);
});

test.each([
  {
    condition: "missing",
    content: null,
    finding: "missing-reachable-content",
  },
  {
    condition: "malformed",
    content: {
      kind: "content" as const,
      key: "content/folded-live-put",
      documentId: "wrong-document",
      value: 99,
    },
    finding: "malformed-reachable-content",
  },
])(
  "cold and warm reject a final folded put whose content is $condition",
  ({ content, finding }) => {
    const livePut: ModelMutation = {
      mutationId: "folded-live-put",
      sequence: 1,
      documentId: "document-1",
      change: { kind: "put", value: 42 },
    };
    const run: ModelRunObject = {
      kind: "run",
      key: "runs/folded-live-put",
      level: 0,
      mutations: [livePut],
      complete: true,
    };
    const objects = new Map<string, ModelObject>([
      [run.key, run],
      [
        "manifests/folded-live-put",
        {
          kind: "manifest",
          key: "manifests/folded-live-put",
          generation: 1,
          predecessorKey: null,
          foldedThrough: 1,
          levels: [{ level: 0, runKeys: [run.key] }],
        },
      ],
    ]);
    if (content !== null) {
      objects.set(content.key, content);
    }
    const store: ModelStore = {
      root: {
        generation: 1,
        etag: "root/folded-live-put",
        manifestKey: "manifests/folded-live-put",
      },
      objects,
      durableTrace: [],
    };

    const cold = reconstructModelCold(store);
    const warm = reconstructModelWarm(store, { rootGeneration: 1, runs: new Map() });

    expect(entries(cold.view)).toEqual([]);
    expect(entries(warm.view)).toEqual([]);
    expect(cold.findings).toContain(finding);
    expect(warm.findings).toContain(finding);
  },
);

test("cold and warm reconstruction report a missing published run even when it was cached", () => {
  const objects = new Map(foldedStore.objects);
  objects.delete(foldedRun.key);
  const missingRunStore: ModelStore = { ...foldedStore, objects };

  const cold = reconstructModelCold(missingRunStore);
  const warm = reconstructModelWarm(missingRunStore, warmCache);

  expect(cold.findings).toContain("missing-reachable-run");
  expect(warm.findings).toContain("missing-reachable-run");
  expect(cold.cache.runs.size).toBe(0);
  expect(warm.cache.runs.size).toBe(0);
});

test("reconstruction sorts levels and run keys and applies each mutation ID only once", () => {
  const firstPut: ModelMutation = {
    mutationId: "shared-mutation",
    sequence: 0,
    documentId: "x",
    change: { kind: "put", value: 1 },
  };
  const unrelatedPut: ModelMutation = {
    mutationId: "unrelated-mutation",
    sequence: 1,
    documentId: "y",
    change: { kind: "put", value: 2 },
  };
  const duplicatePut: ModelMutation = {
    mutationId: "shared-mutation",
    sequence: 3,
    documentId: "x",
    change: { kind: "put", value: 9 },
  };
  const levelZeroRun: ModelRunObject = {
    kind: "run",
    key: "runs/middle",
    level: 0,
    mutations: [firstPut],
    complete: true,
  };
  const levelTwoA: ModelRunObject = {
    kind: "run",
    key: "runs/a",
    level: 2,
    mutations: [unrelatedPut],
    complete: true,
  };
  const levelTwoZ: ModelRunObject = {
    kind: "run",
    key: "runs/z",
    level: 2,
    mutations: [duplicatePut],
    complete: true,
  };
  const store: ModelStore = {
    root: { generation: 7, etag: "root/ordered", manifestKey: "manifests/ordered" },
    objects: new Map<string, ModelObject>([
      [
        "content/shared-mutation",
        { kind: "content", key: "content/shared-mutation", documentId: "x", value: 1 },
      ],
      [
        "content/unrelated-mutation",
        { kind: "content", key: "content/unrelated-mutation", documentId: "y", value: 2 },
      ],
      [levelZeroRun.key, levelZeroRun],
      [levelTwoA.key, levelTwoA],
      [levelTwoZ.key, levelTwoZ],
      [
        "manifests/ordered",
        {
          kind: "manifest" as const,
          key: "manifests/ordered",
          generation: 7,
          predecessorKey: null,
          foldedThrough: 3,
          levels: [
            { level: 2, runKeys: [levelTwoZ.key, levelTwoA.key] },
            { level: 0, runKeys: [levelZeroRun.key] },
          ],
        },
      ],
    ]),
    durableTrace: [],
  };

  const result = reconstructModelCold(store);

  expect(entries(result.view)).toEqual([
    ["x", 1],
    ["y", 2],
  ]);
  expect([...result.cache.runs.keys()]).toEqual([levelZeroRun.key, levelTwoA.key, levelTwoZ.key]);
});

test("reconstruction rejects an incomplete reachable run", () => {
  const objects = new Map(foldedStore.objects);
  objects.set(foldedRun.key, { ...foldedRun, complete: false } as unknown as ModelObject);
  const incompleteRunStore: ModelStore = { ...foldedStore, objects };

  const result = reconstructModelCold(incompleteRunStore);

  expect(result.findings).toContain("malformed-reachable-run");
  expect(result.cache.runs.size).toBe(0);
});

test("reconstruction reports missing and malformed content reached from acknowledged puts", () => {
  const acknowledgedPut: ModelMutation = {
    mutationId: "acknowledged-put",
    sequence: 0,
    documentId: "present",
    change: { kind: "put", value: 4 },
  };
  const missingContentStore: ModelStore = {
    root: { generation: 0, etag: "root-0", manifestKey: null },
    objects: new Map([
      [
        "log/0",
        {
          kind: "log",
          key: "log/0",
          mutation: acknowledgedPut,
          contentKey: "content/acknowledged-put",
        },
      ],
      [
        "ack/0",
        {
          kind: "ack",
          key: "ack/0",
          sequence: 0,
          mutationId: acknowledgedPut.mutationId,
        },
      ],
    ]),
    durableTrace: [],
  };
  const malformedContentStore: ModelStore = {
    ...missingContentStore,
    objects: new Map([
      ...missingContentStore.objects,
      [
        "content/acknowledged-put",
        {
          kind: "content" as const,
          key: "content/acknowledged-put",
          documentId: "wrong-document",
          value: 99,
        },
      ],
    ]),
  };

  const missing = reconstructModelCold(missingContentStore);
  const malformed = reconstructModelCold(malformedContentStore);

  expect(missing.findings).toContain("missing-reachable-content");
  expect(entries(missing.view)).toEqual([]);
  expect(malformed.findings).toContain("malformed-reachable-content");
  expect(entries(malformed.view)).toEqual([]);
});

test("reconstruction rejects a final suffix put redirected to a non-derived content key", () => {
  const redirectedPut: ModelMutation = {
    mutationId: "redirected-put",
    sequence: 0,
    documentId: "document-1",
    change: { kind: "put", value: 42 },
  };
  const store: ModelStore = {
    root: { generation: 0, etag: "root-0", manifestKey: null },
    objects: new Map<string, ModelObject>([
      [
        "content/alias",
        { kind: "content", key: "content/alias", documentId: "document-1", value: 42 },
      ],
      [
        "log/0",
        {
          kind: "log",
          key: "log/0",
          mutation: redirectedPut,
          contentKey: "content/alias",
        },
      ],
      ["ack/0", { kind: "ack", key: "ack/0", sequence: 0, mutationId: redirectedPut.mutationId }],
    ]),
    durableTrace: [],
  };

  const result = reconstructModelCold(store);

  expect(result.findings).toContain("malformed-reachable-log");
  expect(result.findings).not.toContain("missing-reachable-content");
  expect(entries(result.view)).toEqual([]);
});

test("warm reconstruction discards a cached run that disagrees with durable storage", () => {
  const staleCachedRun: ModelRunObject = {
    ...foldedRun,
    mutations: [{ ...putB, change: { kind: "put", value: 99 } }],
  };
  const staleCache: ModelWarmCache = {
    rootGeneration: 1,
    runs: new Map([[staleCachedRun.key, staleCachedRun]]),
  };

  const result = reconstructModelWarm(foldedStore, staleCache);

  expect(entries(result.view)).toEqual([["b", 2]]);
  expect(result.cache.runs.get(foldedRun.key)).toBe(foldedRun);
});

test("warm reconstruction reuses a distinct cached run that agrees with durable storage", () => {
  const equivalentCachedRun: ModelRunObject = {
    ...foldedRun,
    mutations: foldedRun.mutations.map((mutation) => ({
      ...mutation,
      change: { ...mutation.change },
    })),
  };
  const equivalentCache: ModelWarmCache = {
    rootGeneration: 1,
    runs: new Map([[equivalentCachedRun.key, equivalentCachedRun]]),
  };

  const result = reconstructModelWarm(foldedStore, equivalentCache);

  expect(result.cache.runs.get(foldedRun.key)).toBe(equivalentCachedRun);
});

test("warm reconstruction does not reuse a run cached for another root generation", () => {
  const staleGenerationRun: ModelRunObject = {
    ...foldedRun,
    mutations: foldedRun.mutations.map((mutation) => ({
      ...mutation,
      change: { ...mutation.change },
    })),
  };
  const staleGenerationCache: ModelWarmCache = {
    rootGeneration: 0,
    runs: new Map([[staleGenerationRun.key, staleGenerationRun]]),
  };

  const result = reconstructModelWarm(foldedStore, staleGenerationCache);

  expect(result.cache.runs.get(foldedRun.key)).toBe(foldedRun);
  expect(result.cache.runs.get(foldedRun.key)).not.toBe(staleGenerationRun);
});

test("warm traversal visits every published level and evicts unreachable cached runs", () => {
  const lowMutation: ModelMutation = {
    mutationId: "warm-low",
    sequence: 1,
    documentId: "low",
    change: { kind: "put", value: 1 },
  };
  const highMutation: ModelMutation = {
    mutationId: "warm-high",
    sequence: 2,
    documentId: "high",
    change: { kind: "put", value: 2 },
  };
  const lowRun: ModelRunObject = {
    kind: "run",
    key: "runs/warm-low",
    level: 0,
    mutations: [lowMutation],
    complete: true,
  };
  const highRun: ModelRunObject = {
    kind: "run",
    key: "runs/warm-high",
    level: 2,
    mutations: [highMutation],
    complete: true,
  };
  const cachedLow = { ...lowRun, mutations: [{ ...lowMutation }] };
  const cachedHigh = { ...highRun, mutations: [{ ...highMutation }] };
  const staleRun: ModelRunObject = {
    kind: "run",
    key: "runs/stale",
    level: 1,
    mutations: [],
    complete: true,
  };
  const store: ModelStore = {
    root: { generation: 4, etag: "root/warm-levels", manifestKey: "manifests/warm-levels" },
    objects: new Map<string, ModelObject>([
      [
        "content/warm-low",
        { kind: "content", key: "content/warm-low", documentId: "low", value: 1 },
      ],
      [
        "content/warm-high",
        { kind: "content", key: "content/warm-high", documentId: "high", value: 2 },
      ],
      [lowRun.key, lowRun],
      [highRun.key, highRun],
      [
        "manifests/warm-levels",
        {
          kind: "manifest",
          key: "manifests/warm-levels",
          generation: 4,
          predecessorKey: null,
          foldedThrough: 2,
          levels: [
            { level: 2, runKeys: [highRun.key] },
            { level: 0, runKeys: [lowRun.key] },
          ],
        },
      ],
    ]),
    durableTrace: [],
  };
  const cache: ModelWarmCache = {
    rootGeneration: 4,
    runs: new Map([
      [cachedHigh.key, cachedHigh],
      [staleRun.key, staleRun],
      [cachedLow.key, cachedLow],
    ]),
  };

  const result = reconstructModelWarm(store, cache);

  expect(entries(result.view)).toEqual([
    ["low", 1],
    ["high", 2],
  ]);
  expect(result.findings).toEqual([]);
  expect([...result.cache.runs.keys()]).toEqual([lowRun.key, highRun.key]);
  expect(result.cache.runs.get(lowRun.key)).toBe(cachedLow);
  expect(result.cache.runs.get(highRun.key)).toBe(cachedHigh);
  expect(result.cache.runs.has(staleRun.key)).toBe(false);
});

test("reconstruction reports a malformed acknowledgement instead of filtering it out", () => {
  const malformedAcknowledgementStore: ModelStore = {
    root: { generation: 0, etag: "root-0", manifestKey: null },
    objects: new Map([
      [
        "ack/not-a-sequence",
        {
          kind: "ack" as const,
          key: "ack/not-a-sequence",
          sequence: Number.NaN,
          mutationId: "malformed-ack",
        },
      ],
    ]),
    durableTrace: [],
  };

  expect(reconstructModelCold(malformedAcknowledgementStore).findings).toContain(
    "malformed-reachable-ack",
  );
});

test("reconstruction reports a malformed manifest level instead of throwing", () => {
  const malformedManifestStore: ModelStore = {
    root: { generation: 1, etag: "root-malformed", manifestKey: "manifests/malformed" },
    objects: new Map([
      [
        "manifests/malformed",
        {
          kind: "manifest" as const,
          key: "manifests/malformed",
          generation: 1,
          predecessorKey: null,
          foldedThrough: 0,
          levels: [null],
        } as unknown as ModelObject,
      ],
    ]),
    durableTrace: [],
  };

  const result = reconstructModelCold(malformedManifestStore);

  expect(result.findings).toContain("malformed-reachable-manifest");
  expect(entries(result.view)).toEqual([]);
});
