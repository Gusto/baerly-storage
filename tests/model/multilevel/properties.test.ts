import * as fc from "fast-check";
import { describe, expect, test } from "vitest";
import {
  canonicalModelCoverageScenarios,
  enumerateModelCrashSchedules,
  type ModelScenario,
} from "./arbitraries.ts";
import { initialModelState, runModelSchedule, type ModelRun } from "./executor.ts";
import { checkModelSafety, checkModelSafetyProperty } from "./invariants.ts";
import {
  calculateModelObjectBound,
  countModelObjects,
  ModelAssumptionViolationError,
} from "./object-count.ts";
import {
  checkModelStructure,
  isModelSafetyProperty,
  modelPropertyDefinitions,
  MODEL_PROPERTIES,
  MODEL_PROPERTY_NAMES,
} from "./property-suite.ts";
import {
  DEFAULT_MODEL_ASSUMPTIONS,
  MINIMUM_MODEL_FULL_SUITE_ASSUMPTIONS,
  type ModelContentObject,
  type ModelManifestObject,
  type ModelObject,
  type ModelOperation,
  type ModelState,
  type ModelWorkloadAssumptions,
} from "./types.ts";

const expectedPropertyNames = [
  "acknowledged-mutations-never-lost",
  "unacknowledged-mutations-never-visible",
  "cold-and-warm-equal-reference-replay",
  "publication-monotone-no-partial-run",
  "lost-cas-preserves-winning-lineage",
  "reclamation-preserves-reachable-objects",
  "recovery-idempotent-after-every-crash-point",
  "total-object-count-is-bounded",
  "every-durable-operation-is-a-crash-boundary",
  "every-publication-can-win-or-lose-cas",
  "tail-fold-and-base-merge-run-in-both-orders",
  "every-rejected-arm-is-exercised",
] as const;

/**
 * The exported envelope, not a copy of it. `arbitraries.test.ts` holds the
 * single golden pin of its literal values; the per-field table below asserts
 * the validator's rejection message rather than restating the envelope.
 */
const EXACT_MINIMUM_ASSUMPTIONS: ModelWorkloadAssumptions = MINIMUM_MODEL_FULL_SUITE_ASSUMPTIONS;

function totalObjectCountDefinition(assumptions: ModelWorkloadAssumptions) {
  const definition = modelPropertyDefinitions(assumptions).find(
    ({ name }) => name === "total-object-count-is-bounded",
  );
  if (definition === undefined) {
    throw new Error("missing total-object-count-is-bounded definition");
  }
  return definition;
}

function modelRunWithObjects(objects: ReadonlyMap<string, ModelObject>): ModelRun {
  const initial = initialModelState(EXACT_MINIMUM_ASSUMPTIONS);
  const final = { ...initial, store: { ...initial.store, objects } };
  return { initial, final, transitions: [] };
}

test("registers the exact twelve model properties in contract order", () => {
  expect(MODEL_PROPERTY_NAMES).toEqual(expectedPropertyNames);
  expect(MODEL_PROPERTIES.map(({ name }) => name)).toEqual(expectedPropertyNames);
});

test("builds every property arbitrary from the supplied workload assumptions", () => {
  const assumptions = {
    ...DEFAULT_MODEL_ASSUMPTIONS,
    maxLiveDocuments: 2,
    maxRunsPerLevel: 3,
    maxCommittedSuffixEntries: 4,
    maxConcurrentPublishers: 3,
    maxScheduleOperations: 32,
  };
  const definitions = modelPropertyDefinitions(assumptions);
  const safetySamples = definitions
    .filter(({ name }) => isModelSafetyProperty(name))
    .map(({ arbitrary }) => fc.sample(arbitrary, { seed: 20_260_803, numRuns: 10 }));

  expect(definitions.map(({ name }) => name)).toEqual(MODEL_PROPERTY_NAMES);
  for (const scenarios of safetySamples.slice(1)) {
    expect(scenarios).toEqual(safetySamples[0]);
  }
  for (const [index, definition] of definitions.entries()) {
    const scenarios =
      safetySamples[index] ?? fc.sample(definition.arbitrary, { seed: 20_260_803, numRuns: 10 });
    expect(scenarios.every((scenario) => scenario.assumptions === assumptions)).toBe(true);
    expect(
      scenarios.every(
        (scenario) => scenario.operations.length <= assumptions.maxScheduleOperations,
      ),
    ).toBe(true);
  }
});

describe("full-suite assumption envelope", () => {
  test("accepts the exact minimum without clamping any field", () => {
    const definitions = modelPropertyDefinitions(EXACT_MINIMUM_ASSUMPTIONS);

    expect(definitions.map(({ name }) => name)).toEqual(MODEL_PROPERTY_NAMES);
    for (const definition of definitions) {
      const scenario = fc.sample(definition.arbitrary, { seed: 20_260_803, numRuns: 1 })[0];
      expect(scenario?.assumptions).toBe(EXACT_MINIMUM_ASSUMPTIONS);
      expect(scenario?.operations.length).toBeLessThanOrEqual(4);
      if (scenario !== undefined) {
        const result = definition.check(scenario);
        expect(result.ok, `${definition.name}: ${result.evidence.join("\n")}`).toBe(true);
      }
    }
  });

  test.each([
    ["maxLiveDocuments", 1],
    ["maxActiveLevels", 2],
    ["maxRunsPerLevel", 1],
    ["maxCommittedSuffixEntries", 1],
    ["maxConcurrentPublishers", 2],
    ["maxScheduleOperations", 4],
  ] as const)("rejects %s one below its minimum", (field, fieldMinimum) => {
    const value = fieldMinimum - 1;
    expect(() =>
      modelPropertyDefinitions({ ...EXACT_MINIMUM_ASSUMPTIONS, [field]: value }),
    ).toThrowError(`invalid full-suite assumption ${field}=${value}; minimum=${fieldMinimum}`);
  });

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["1.5", 1.5],
  ] as const)("rejects noninteger maxLiveDocuments=%s", (label, value) => {
    expect(() =>
      modelPropertyDefinitions({ ...EXACT_MINIMUM_ASSUMPTIONS, maxLiveDocuments: value }),
    ).toThrowError(`invalid full-suite assumption maxLiveDocuments=${label}; minimum=1`);
  });
});

test("the unacknowledged property always executes and reports a dropped append", () => {
  const definition = MODEL_PROPERTIES.find(
    ({ name }) => name === "unacknowledged-mutations-never-visible",
  );

  expect(definition).toBeDefined();
  if (definition === undefined) {
    return;
  }
  const scenarios = fc.sample(definition.arbitrary, { numRuns: 100, seed: 20_260_803 });
  expect(
    scenarios.every(({ operations }) =>
      operations.some(
        (operation) => operation.kind === "append-log" && operation.acknowledgement === "drop",
      ),
    ),
  ).toBe(true);

  const result = definition.check(scenarios[0] as ModelScenario);
  expect(result.ok).toBe(true);
  expect(result.evidence.some((entry) => entry.includes("dropped="))).toBe(true);
});

test("checks every source prefix before a later reclaim hides assumption overflow", () => {
  const scenario: ModelScenario = {
    assumptions: DEFAULT_MODEL_ASSUMPTIONS,
    operations: [
      ...[1, 2, 3, 4].map(
        (sequence) =>
          ({
            kind: "append-log",
            operationId: `append-${sequence}`,
            mutation: {
              mutationId: `mutation-${sequence}`,
              sequence,
              documentId: "same-row",
              change: { kind: "put", value: sequence },
            },
            acknowledgement: "acknowledge",
          }) as const,
      ),
      {
        kind: "reclaim",
        operationId: "reclaim-old-content",
        candidateKeys: ["content/mutation-1", "content/mutation-2", "content/mutation-3"],
      },
    ],
  };
  const definition = MODEL_PROPERTIES.find(({ name }) => name === "total-object-count-is-bounded");

  expect(definition).toBeDefined();
  if (definition === undefined) {
    return;
  }
  const result = definition.check(scenario);
  expect(result).toMatchObject({
    name: "total-object-count-is-bounded",
    ok: false,
  });
  expect(result.evidence).toContain(
    "prefix=4:assumption-violation:unreclaimedAttempts=3 exceeds maxConcurrentPublishers=2",
  );
});

test("attributes the composite winning CAS crash boundary to the original operation", () => {
  const scenario = canonicalModelCoverageScenarios().find(({ operations }) =>
    operations.some(({ kind }) => kind === "lose-publication-cas"),
  );
  const definition = MODEL_PROPERTIES.find(
    ({ name }) => name === "every-durable-operation-is-a-crash-boundary",
  );

  expect(scenario).toBeDefined();
  expect(definition).toBeDefined();
  if (scenario === undefined || definition === undefined) {
    return;
  }
  const result = definition.check(scenario);

  expect(result.ok).toBe(true);
  expect(result.evidence).toContain("durable-effect=concurrent-publication/2");
  expect(result.evidence.some((entry) => entry.includes("/winner-publish"))).toBe(false);
});

describe("retry-produced CAS lineage", () => {
  const operations: readonly ModelOperation[] = [
    {
      kind: "append-log",
      operationId: "append-winner",
      mutation: {
        mutationId: "winner-mutation",
        sequence: 1,
        documentId: "doc-0",
        change: { kind: "put", value: 1 },
      },
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
      kind: "append-log",
      operationId: "append-loser",
      mutation: {
        mutationId: "loser-mutation",
        sequence: 2,
        documentId: "doc-0",
        change: { kind: "put", value: 2 },
      },
      acknowledgement: "acknowledge",
    },
    {
      kind: "emit-run",
      operationId: "emit-loser",
      runId: "loser-only",
      level: 0,
      sequences: [2],
    },
    {
      kind: "crash",
      operationId: "crash-concurrent-publication-2-after",
      targetOperationId: "concurrent-publication",
      durableEffectIndex: 2,
      boundary: "after",
    },
    {
      kind: "lose-publication-cas",
      operationId: "concurrent-publication",
      winner: {
        publicationId: "winner-publish",
        expectedGeneration: 0,
        runKeys: ["runs/winner"],
        foldedThrough: 1,
        role: "tail",
      },
      loser: {
        publicationId: "loser-publish",
        expectedGeneration: 0,
        runKeys: ["runs/loser-only"],
        foldedThrough: 2,
        role: "base",
      },
    },
    {
      kind: "retry",
      operationId: "retry-concurrent-publication-2-after",
      targetOperationId: "concurrent-publication",
    },
  ];

  function retryCasRun(): ModelRun {
    const run = runModelSchedule(initialModelState(DEFAULT_MODEL_ASSUMPTIONS), operations);
    expect(run.transitions.map(({ outcome }) => outcome)).toEqual([
      "applied",
      "applied",
      "applied",
      "applied",
      "applied",
      "crashed-after",
      "cas-lost",
    ]);
    return run;
  }

  function withMutatedRetryState(
    run: ModelRun,
    mutate: (state: ModelState) => ModelState,
  ): ModelRun {
    const retry = run.transitions.at(-1);
    expect(retry).toBeDefined();
    if (retry === undefined) {
      return run;
    }
    const state = mutate(retry.state);
    return {
      ...run,
      final: state,
      transitions: [...run.transitions.slice(0, -1), { ...retry, state }],
    };
  }

  function checkRetryLineage(run: ModelRun) {
    return checkModelSafetyProperty(
      "lost-cas-preserves-winning-lineage",
      run,
      DEFAULT_MODEL_ASSUMPTIONS,
    );
  }

  test("checks the literal retry/cas-lost transition against its original target", () => {
    const result = checkRetryLineage(retryCasRun());

    expect(result.ok).toBe(true);
    expect(result.evidence).toContain(
      "retry=retry-concurrent-publication-2-after:target=concurrent-publication",
    );
    expect(result.evidence).toContain("winner-lineage=manifests/winner-publish");
    expect(result.evidence).toContain("loser-run=runs/loser-only");
  });

  test.each([
    [
      "loser root",
      (state: ModelState): ModelState => ({
        ...state,
        store: {
          ...state.store,
          root: {
            generation: 1,
            etag: "root/loser-publish",
            manifestKey: "manifests/loser-publish",
          },
        },
      }),
    ],
    [
      "decoy root",
      (state: ModelState): ModelState => ({
        ...state,
        store: {
          ...state.store,
          root: { generation: 1, etag: "root/decoy", manifestKey: "manifests/decoy" },
        },
      }),
    ],
    [
      "attached loser-only run",
      (state: ModelState): ModelState => {
        const objects = new Map(state.store.objects);
        const manifest = objects.get("manifests/winner-publish") as ModelManifestObject;
        objects.set(manifest.key, {
          ...manifest,
          levels: [{ level: 0, runKeys: ["runs/winner", "runs/loser-only"] }],
        });
        return { ...state, store: { ...state.store, objects } };
      },
    ],
    [
      "removed winner run",
      (state: ModelState): ModelState => {
        const objects = new Map(state.store.objects);
        objects.delete("runs/winner");
        return { ...state, store: { ...state.store, objects } };
      },
    ],
    [
      "corrupted winner run",
      (state: ModelState): ModelState => {
        const objects = new Map(state.store.objects);
        const run = objects.get("runs/winner");
        expect(run?.kind).toBe("run");
        if (run?.kind === "run") {
          objects.set(run.key, { ...run, level: 1 });
        }
        return { ...state, store: { ...state.store, objects } };
      },
    ],
  ] as const)("rejects a retry state with a %s", (_, mutate) => {
    const result = checkRetryLineage(withMutatedRetryState(retryCasRun(), mutate));

    expect(result.ok).toBe(false);
  });
});

/**
 * Prefixes each safety property evaluates on the 42-operation schedule below,
 * as `schedule-length=40` and `schedule-length=42`.
 *
 * The four properties that check 41 and 43 visit every prefix. The other four
 * are the ones `modelSafetyCanChangeAtPrefix` can skip, and on a schedule that
 * is mostly reconstructs they collapse to a handful of prefixes. Pinning the
 * real numbers keeps the skip rules honest: widening one shows up here as a
 * coverage loss rather than as a quieter test run.
 *
 * Under `MODEL_NO_PREFIX_SKIP=1` every property is exhaustive, so the expected
 * counts collapse to the schedule lengths.
 */
const EXHAUSTIVE_CHECKED_PREFIXES: readonly [number, number] = [41, 43];

const EXPECTED_CHECKED_PREFIXES: Readonly<Record<string, readonly [number, number]>> = {
  "acknowledged-mutations-never-lost": [41, 43],
  "unacknowledged-mutations-never-visible": [41, 43],
  "cold-and-warm-equal-reference-replay": [41, 43],
  "publication-monotone-no-partial-run": [2, 3],
  "lost-cas-preserves-winning-lineage": [2, 2],
  "reclamation-preserves-reachable-objects": [2, 2],
  "recovery-idempotent-after-every-crash-point": [2, 3],
  "total-object-count-is-bounded": [41, 43],
};

test("reports the prefixes each safety property really checks on 42-operation crash schedules", () => {
  const operations: ModelOperation[] = [
    {
      kind: "append-log",
      operationId: "append-dropped-source",
      mutation: {
        mutationId: "dropped-source",
        sequence: 1,
        documentId: "doc-0",
        change: { kind: "put", value: 9 },
      },
      acknowledgement: "drop",
    },
    {
      kind: "append-log",
      operationId: "append-acknowledged-source",
      mutation: {
        mutationId: "acknowledged-source",
        sequence: 2,
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
      sequences: [2],
    },
    ...Array.from({ length: 37 }, (_, index): ModelOperation => ({
      kind: "reconstruct",
      operationId: `reconstruct-remainder-${index}`,
      mode: index % 2 === 0 ? "cold" : "warm",
    })),
  ];
  const scenario: ModelScenario = { assumptions: DEFAULT_MODEL_ASSUMPTIONS, operations };

  expect(operations).toHaveLength(40);
  for (const definition of MODEL_PROPERTIES.filter(({ name }) => isModelSafetyProperty(name))) {
    const result = definition.check(scenario);
    expect(result.ok, `${definition.name}: ${result.evidence.join("\n")}`).toBe(true);
    const expected =
      process.env["MODEL_NO_PREFIX_SKIP"] === "1"
        ? EXHAUSTIVE_CHECKED_PREFIXES
        : EXPECTED_CHECKED_PREFIXES[definition.name];
    expect(expected, `${definition.name} has no pinned prefix coverage`).toBeDefined();
    expect(result.evidence).toContain(`schedule-length=40:checked-prefixes=${expected?.[0] ?? 0}`);
    expect(result.evidence).toContain(`schedule-length=42:checked-prefixes=${expected?.[1] ?? 0}`);
  }
});

describe("model object bound", () => {
  test("rejects two active level-zero runs when exact R is one", () => {
    const scenario: ModelScenario = {
      assumptions: EXACT_MINIMUM_ASSUMPTIONS,
      operations: [
        {
          kind: "emit-run",
          operationId: "emit-a",
          runId: "a",
          level: 0,
          sequences: [],
        },
        {
          kind: "emit-run",
          operationId: "emit-b",
          runId: "b",
          level: 0,
          sequences: [],
        },
        {
          kind: "publish-root",
          operationId: "publish-a-b",
          publicationId: "a-b",
          expectedGeneration: 0,
          runKeys: ["runs/a", "runs/b"],
          foldedThrough: 0,
          role: "tail",
        },
      ],
    };
    const run = runModelSchedule(initialModelState(EXACT_MINIMUM_ASSUMPTIONS), scenario.operations);

    expect(run.transitions.map(({ outcome }) => outcome)).toEqual([
      "applied",
      "applied",
      "applied",
    ]);
    expect(countModelObjects(run.final)).toBe(4);
    const result = totalObjectCountDefinition(EXACT_MINIMUM_ASSUMPTIONS).check(scenario);
    expect(result).toMatchObject({ ok: false });
    expect(result.evidence).toContain(
      "prefix=3:assumption-violation:activeRuns[level=0]=2 exceeds maxRunsPerLevel=1",
    );
  });

  test("rejects two durable committed suffix entries when exact S is one", () => {
    const scenario: ModelScenario = {
      assumptions: EXACT_MINIMUM_ASSUMPTIONS,
      operations: [1, 2].map((sequence) => ({
        kind: "append-log" as const,
        operationId: `append-${sequence}`,
        mutation: {
          mutationId: `mutation-${sequence}`,
          sequence,
          documentId: "doc-0",
          change: { kind: "put" as const, value: sequence },
        },
        acknowledgement: "acknowledge" as const,
      })),
    };

    const result = totalObjectCountDefinition(EXACT_MINIMUM_ASSUMPTIONS).check(scenario);
    expect(result).toMatchObject({ ok: false });
    expect(result.evidence).toContain(
      "prefix=2:assumption-violation:committedSuffixEntries=2 exceeds maxCommittedSuffixEntries=1",
    );
  });

  test.each([
    [
      "malformed mutations",
      (sequence: number): ModelObject =>
        ({
          kind: "log",
          key: `log/${sequence}`,
          mutation: {
            mutationId: `corrupt-${sequence}`,
            sequence,
            documentId: "doc-0",
            change: { kind: "put", value: "not-a-number" },
          },
          contentKey: `content/corrupt-${sequence}`,
        }) as unknown as ModelObject,
    ],
    [
      "noncanonical put content keys",
      (sequence: number): ModelObject => ({
        kind: "log",
        key: `log/${sequence}`,
        mutation: {
          mutationId: `corrupt-${sequence}`,
          sequence,
          documentId: "doc-0",
          change: { kind: "put", value: sequence },
        },
        contentKey: `content/redirected-${sequence}`,
      }),
    ],
  ] as const)(
    "treats corrupt paired suffix %s as physical objects, not S overflow",
    (_, logFor) => {
      const objects = new Map<string, ModelObject>();
      for (const sequence of [1, 2]) {
        objects.set(`log/${sequence}`, logFor(sequence));
        objects.set(`ack/${sequence}`, {
          kind: "ack",
          key: `ack/${sequence}`,
          sequence,
          mutationId: `corrupt-${sequence}`,
        });
      }
      const run = modelRunWithObjects(objects);

      const bound = checkModelSafetyProperty(
        "total-object-count-is-bounded",
        run,
        EXACT_MINIMUM_ASSUMPTIONS,
      );
      const reconstruction = checkModelSafetyProperty(
        "cold-and-warm-equal-reference-replay",
        run,
        EXACT_MINIMUM_ASSUMPTIONS,
      );

      expect(countModelObjects(run.final)).toBe(5);
      expect(bound).toMatchObject({ ok: false });
      expect(bound.evidence).toEqual(
        expect.arrayContaining(["objects=5", "bound=4", "objects=5:exceeds-bound=4"]),
      );
      expect(bound.evidence.some((entry) => entry.startsWith("assumption-violation:"))).toBe(false);
      expect(reconstruction).toMatchObject({ ok: false });
      expect(reconstruction.evidence).toEqual(
        expect.arrayContaining([
          "final:cold:finding=malformed-reachable-log",
          "final:warm:finding=malformed-reachable-log",
        ]),
      );
    },
  );

  test.each(["put", "delete"] as const)(
    "counts canonical acknowledged %s entries without requiring live content",
    (kind) => {
      const objects = new Map<string, ModelObject>();
      for (const sequence of [1, 2]) {
        const mutationId = `${kind}-${sequence}`;
        const mutation = {
          mutationId,
          sequence,
          documentId: "doc-0",
          change:
            kind === "put"
              ? ({ kind: "put", value: sequence } as const)
              : ({ kind: "delete" } as const),
        };
        objects.set(`log/${sequence}`, {
          kind: "log",
          key: `log/${sequence}`,
          mutation,
          contentKey: kind === "put" ? `content/${mutationId}` : null,
        });
        objects.set(`ack/${sequence}`, {
          kind: "ack",
          key: `ack/${sequence}`,
          sequence,
          mutationId,
        });
      }

      const bound = checkModelSafetyProperty(
        "total-object-count-is-bounded",
        modelRunWithObjects(objects),
        EXACT_MINIMUM_ASSUMPTIONS,
      );

      expect(bound.evidence).toEqual([
        "assumption-violation:committedSuffixEntries=2 exceeds maxCommittedSuffixEntries=1",
      ]);
    },
  );

  test("deduplicates suffix sequences and excludes folded and unmatched noise", () => {
    const mutation = {
      mutationId: "active",
      sequence: 2,
      documentId: "doc-0",
      change: { kind: "delete" as const },
    };
    const objects = new Map<string, ModelObject>([
      [
        "manifests/current",
        {
          kind: "manifest",
          key: "manifests/current",
          generation: 1,
          predecessorKey: null,
          foldedThrough: 1,
          levels: [],
        },
      ],
      [
        "log/1",
        {
          kind: "log",
          key: "log/1",
          mutation: { ...mutation, mutationId: "folded", sequence: 1 },
          contentKey: null,
        },
      ],
      ["ack/1", { kind: "ack", key: "ack/1", sequence: 1, mutationId: "folded" }],
      ["log/2", { kind: "log", key: "log/2", mutation, contentKey: null }],
      ["ack/2", { kind: "ack", key: "ack/2", sequence: 2, mutationId: "active" }],
      ["ack/alias", { kind: "ack", key: "ack/2", sequence: 2, mutationId: "active" }],
      [
        "log/3",
        {
          kind: "log",
          key: "log/3",
          mutation: { ...mutation, mutationId: "unmatched-log", sequence: 3 },
          contentKey: null,
        },
      ],
      ["ack/4", { kind: "ack", key: "ack/4", sequence: 4, mutationId: "unmatched-ack" }],
    ]);
    const initial = initialModelState(EXACT_MINIMUM_ASSUMPTIONS);
    const final = {
      ...initial,
      store: {
        ...initial.store,
        root: { generation: 1, etag: "root-1", manifestKey: "manifests/current" },
        objects,
      },
    };

    const bound = checkModelSafetyProperty(
      "total-object-count-is-bounded",
      { initial, final, transitions: [] },
      EXACT_MINIMUM_ASSUMPTIONS,
    );

    expect(countModelObjects(final)).toBe(9);
    expect(bound).toMatchObject({ ok: false });
    expect(bound.evidence).toEqual(
      expect.arrayContaining(["objects=9", "bound=4", "objects=9:exceeds-bound=4"]),
    );
    expect(bound.evidence.some((entry) => entry.startsWith("assumption-violation:"))).toBe(false);
  });

  test("rejects a fifth direct source operation when exact N is four", () => {
    const scenario: ModelScenario = {
      assumptions: EXACT_MINIMUM_ASSUMPTIONS,
      operations: Array.from({ length: 5 }, (_, index): ModelOperation => ({
        kind: "reconstruct",
        operationId: `reconstruct-${index}`,
        mode: "cold",
      })),
    };

    const result = totalObjectCountDefinition(EXACT_MINIMUM_ASSUMPTIONS).check(scenario);
    expect(result).toMatchObject({ ok: false });
    expect(result.evidence).toContain(
      "prefix=5:assumption-violation:sourceScheduleOperations=5 exceeds maxScheduleOperations=4",
    );
  });

  test("accepts exact S and N boundaries while excluding corrupt suffix noise", () => {
    const scenario: ModelScenario = {
      assumptions: EXACT_MINIMUM_ASSUMPTIONS,
      operations: [
        {
          kind: "append-log",
          operationId: "append-boundary",
          mutation: {
            mutationId: "boundary",
            sequence: 1,
            documentId: "doc-0",
            change: { kind: "put", value: 1 },
          },
          acknowledgement: "acknowledge",
        },
        ...Array.from({ length: 3 }, (_, index): ModelOperation => ({
          kind: "reconstruct",
          operationId: `reconstruct-boundary-${index}`,
          mode: "cold",
        })),
      ],
    };
    const definition = totalObjectCountDefinition(EXACT_MINIMUM_ASSUMPTIONS);

    expect(definition.check(scenario).ok).toBe(true);

    const run = runModelSchedule(initialModelState(EXACT_MINIMUM_ASSUMPTIONS), scenario.operations);
    const objects = new Map(run.final.store.objects);
    objects.set("ack/noise", {
      kind: "ack",
      key: "ack/noise",
      sequence: 2,
      mutationId: "noise",
    });
    const final = { ...run.final, store: { ...run.final.store, objects } };
    const noisyResult = checkModelSafetyProperty(
      "total-object-count-is-bounded",
      { ...run, final },
      EXACT_MINIMUM_ASSUMPTIONS,
    );

    expect(countModelObjects(final)).toBe(5);
    expect(noisyResult).toMatchObject({ ok: true });
    expect(noisyResult.evidence).toEqual(expect.arrayContaining(["objects=5", "bound=5"]));
  });

  test("reserves the N plus two allowance for genuine enumerated crash schedules", () => {
    const source: ModelScenario = {
      assumptions: DEFAULT_MODEL_ASSUMPTIONS,
      operations: [
        {
          kind: "append-log",
          operationId: "append-derived-source",
          mutation: {
            mutationId: "derived-source",
            sequence: 1,
            documentId: "doc-0",
            change: { kind: "put", value: 1 },
          },
          acknowledgement: "acknowledge",
        },
        ...Array.from({ length: 39 }, (_, index): ModelOperation => ({
          kind: "reconstruct",
          operationId: `reconstruct-derived-${index}`,
          mode: "cold",
        })),
      ],
    };
    const derived = enumerateModelCrashSchedules(source)[0];
    expect(source.operations).toHaveLength(40);
    expect(derived?.operations).toHaveLength(42);
    if (derived === undefined) {
      return;
    }
    const handAuthoredClone: ModelScenario = {
      assumptions: derived.assumptions,
      operations: derived.operations,
    };
    const definition = totalObjectCountDefinition(DEFAULT_MODEL_ASSUMPTIONS);

    expect(definition.check(derived).ok).toBe(true);
    const cloneResult = definition.check(handAuthoredClone);
    expect(cloneResult).toMatchObject({ ok: false });
    expect(cloneResult.evidence).toContain(
      "prefix=41:assumption-violation:sourceScheduleOperations=41 exceeds maxScheduleOperations=40",
    );
  });

  test("uses the literal zero-observation and default-maximum arithmetic", () => {
    expect(
      calculateModelObjectBound(DEFAULT_MODEL_ASSUMPTIONS, {
        liveDocuments: 0,
        activeLevels: 0,
        unreclaimedAttempts: 0,
      }),
    ).toBe(14);
    expect(
      calculateModelObjectBound(DEFAULT_MODEL_ASSUMPTIONS, {
        liveDocuments: 8,
        activeLevels: 3,
        unreclaimedAttempts: 2,
      }),
    ).toBe(62);
  });

  test.each([
    ["liveDocuments", { liveDocuments: 9, activeLevels: 3, unreclaimedAttempts: 2 }],
    ["activeLevels", { liveDocuments: 8, activeLevels: 4, unreclaimedAttempts: 2 }],
    ["unreclaimedAttempts", { liveDocuments: 8, activeLevels: 3, unreclaimedAttempts: 3 }],
  ] as const)("rejects %s outside the configured workload envelope", (_, observation) => {
    expect(() => calculateModelObjectBound(DEFAULT_MODEL_ASSUMPTIONS, observation)).toThrowError(
      ModelAssumptionViolationError,
    );
  });

  test("reports one physical object above the bound", () => {
    const initial = initialModelState();
    const objects = new Map<string, ModelContentObject>();
    for (let index = 0; index < 14; index += 1) {
      const key = `content/extra-${index}`;
      objects.set(key, {
        kind: "content",
        key,
        documentId: `extra-${index}`,
        value: index,
      });
    }
    const final = { ...initial, store: { ...initial.store, objects } };
    const run: ModelRun = { initial, final, transitions: [] };
    const result = checkModelSafety(run, DEFAULT_MODEL_ASSUMPTIONS).find(
      ({ name }) => name === "total-object-count-is-bounded",
    );

    expect(countModelObjects(final)).toBe(15);
    expect(result).toMatchObject({ ok: false });
    expect(result?.evidence).toContain("objects=15");
    expect(result?.evidence).toContain("bound=14");
  });

  test("reports assumption overflow separately from a bound counterexample", () => {
    const initial = initialModelState();
    const final = { ...initial, unreclaimedAttempts: 3 };
    const run: ModelRun = { initial, final, transitions: [] };
    const result = checkModelSafety(run, DEFAULT_MODEL_ASSUMPTIONS).find(
      ({ name }) => name === "total-object-count-is-bounded",
    );

    expect(result).toMatchObject({ ok: false });
    expect(result?.evidence).toEqual([
      "assumption-violation:unreclaimedAttempts=3 exceeds maxConcurrentPublishers=2",
    ]);
    expect(result?.evidence.some((entry) => entry.startsWith("objects="))).toBe(false);
  });

  test("does not count an orphan run level as an active published level", () => {
    const initial = initialModelState();
    const objects = new Map<string, ModelObject>();
    objects.set("runs/orphan-level-2", {
      kind: "run",
      key: "runs/orphan-level-2",
      level: 2,
      mutations: [],
      complete: true,
    });
    for (let index = 0; index < 30; index += 1) {
      const key = `content/orphan-${index}`;
      objects.set(key, {
        kind: "content",
        key,
        documentId: `orphan-${index}`,
        value: index,
      });
    }
    const final = {
      ...initial,
      store: { ...initial.store, objects },
      unreclaimedAttempts: 1,
    };
    const result = checkModelSafety(
      { initial, final, transitions: [] },
      DEFAULT_MODEL_ASSUMPTIONS,
    ).find(({ name }) => name === "total-object-count-is-bounded");

    expect(countModelObjects(final)).toBe(32);
    expect(result).toMatchObject({ ok: false });
    expect(result?.evidence).toEqual(
      expect.arrayContaining(["objects=32", "bound=31", "L=0", "C=1"]),
    );
  });
});

describe("structural rejection evidence", () => {
  test("does not count classifier predictions whose transitions were not rejected", () => {
    const rejectedOperationIds = new Set([
      "reject-incomplete-publish",
      "reject-missing-merge",
      "reject-overflow-merge",
      "reject-retry",
      "reject-reachable-reclaim",
    ]);
    const mutatedRuns = canonicalModelCoverageScenarios().map((scenario) => {
      const run = runModelSchedule(initialModelState(scenario.assumptions), scenario.operations);
      return Object.assign({}, run, {
        transitions: run.transitions.map((transition) =>
          rejectedOperationIds.has(transition.operation.operationId)
            ? Object.assign({}, transition, {
                outcome: "applied" as const,
                rejectionId: null,
              })
            : transition,
        ),
      });
    });
    const result = checkModelStructure(mutatedRuns).find(
      ({ name }) => name === "every-rejected-arm-is-exercised",
    );

    expect(result).toMatchObject({ ok: false });
  });

  test("reports an actual rejected transition that has no registered classification", () => {
    const operation = {
      kind: "emit-run" as const,
      operationId: "unclassified-missing-log",
      runId: "missing-log",
      level: 0,
      sequences: [1],
    };
    const run = runModelSchedule(initialModelState(), [operation]);
    const result = checkModelStructure([run]).find(
      ({ name }) => name === "every-rejected-arm-is-exercised",
    );

    expect(run.transitions[0]).toMatchObject({
      outcome: "rejected",
      rejectionId: "emit/missing-log/1",
    });
    expect(result?.evidence).toContain(
      "unclassified-rejection=unclassified-missing-log:emit/missing-log/1",
    );
  });
});

test("publication role strings alone do not count as executed fold and merge order", () => {
  const operations: readonly ModelOperation[] = [
    {
      kind: "emit-run",
      operationId: "emit-role-only",
      runId: "role-only",
      level: 0,
      sequences: [],
    },
    {
      kind: "publish-root",
      operationId: "tail-role-only",
      publicationId: "tail-role-only",
      expectedGeneration: 0,
      runKeys: ["runs/role-only"],
      foldedThrough: 0,
      role: "tail",
    },
    {
      kind: "publish-root",
      operationId: "base-role-only",
      publicationId: "base-role-only",
      expectedGeneration: 1,
      runKeys: ["runs/role-only"],
      foldedThrough: 0,
      role: "base",
    },
  ];
  const run = runModelSchedule(initialModelState(), operations);
  const result = checkModelStructure([run]).find(
    ({ name }) => name === "tail-fold-and-base-merge-run-in-both-orders",
  );

  expect(result?.evidence).not.toContain("maintenance-order=tail-before-base");
  expect(result?.evidence).not.toContain("maintenance-order=base-before-tail");
});

describe("multilevel model properties", () => {
  test.each(MODEL_PROPERTIES)(
    "$name",
    ({ arbitrary, check }) => {
      fc.assert(
        fc.property(arbitrary, (scenario) => {
          const result = check(scenario);
          if (!result.ok) {
            throw new Error(result.evidence.join("\n"));
          }
        }),
        { numRuns: Number(process.env["FC_NUM_RUNS"] ?? 100), seed: 20_260_803 },
      );
    },
    1_200_000,
  );
});
