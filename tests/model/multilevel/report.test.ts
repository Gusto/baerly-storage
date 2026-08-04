import * as fc from "fast-check";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { ModelScenario } from "./arbitraries.ts";
import { MODEL_PROPERTIES, type ModelPropertyDefinition } from "./property-suite.ts";
import { runModelStudy, writeModelStudyReport } from "./report.ts";
import { DEFAULT_MODEL_ASSUMPTIONS, MODEL_BASE_SHA } from "./types.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

function scenarioWithValue(value: number, assumptions = DEFAULT_MODEL_ASSUMPTIONS): ModelScenario {
  return {
    assumptions,
    operations: [
      {
        kind: "append-log",
        operationId: `append-${value}`,
        mutation: {
          mutationId: `mutation-${value}`,
          sequence: value,
          documentId: "row",
          change: { kind: "put", value },
        },
        acknowledgement: "acknowledge",
      },
    ],
  };
}

test("records complete deterministic evidence and never changes an existing report", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "baerly-multilevel-report-"));
  temporaryRoots.push(repoRoot);
  const sourceRoot = join(repoRoot, "tests/model/multilevel");
  await mkdir(sourceRoot, { recursive: true });
  await writeFile(join(sourceRoot, "zeta.ts"), "export const zeta = 2;\n");
  await writeFile(join(sourceRoot, "alpha.ts"), "export const alpha = 1;\n");

  const passingProperty: ModelPropertyDefinition = {
    name: "acknowledged-mutations-never-lost",
    arbitrary: fc.constant(scenarioWithValue(7)),
    check: () => ({
      name: "acknowledged-mutations-never-lost",
      ok: true,
      evidence: [],
    }),
  };
  const failingProperty: ModelPropertyDefinition = {
    name: "unacknowledged-mutations-never-visible",
    arbitrary: fc.integer({ min: 1, max: 100 }).map(scenarioWithValue),
    check: () => ({
      name: "unacknowledged-mutations-never-visible",
      ok: false,
      evidence: ["expected failure"],
    }),
  };
  const createdAt = new Date("2026-08-03T12:34:56.789Z");
  const report = await runModelStudy({
    repoRoot,
    createdAt,
    seed: 4_242,
    runCount: 5,
    assumptions: DEFAULT_MODEL_ASSUMPTIONS,
    properties: [failingProperty, passingProperty],
  });

  expect(report).toMatchObject({
    schemaVersion: 1,
    baseSha: MODEL_BASE_SHA,
    createdAt: "2026-08-03T12:34:56.789Z",
    seed: 4_242,
    runCount: 5,
    assumptions: DEFAULT_MODEL_ASSUMPTIONS,
    sourceHashes: {
      "tests/model/multilevel/alpha.ts":
        "2f2d8ab6453896290e40a007f1df961cc6004062c86a0a1e6480e8ce201a58aa",
      "tests/model/multilevel/zeta.ts":
        "61469ae5446dc168da86fadb66be01487916d698c9bc157752fa5dd78930372f",
    },
    results: [
      {
        name: "acknowledged-mutations-never-lost",
        passed: true,
        seed: 4_242,
        runCount: 5,
        counterexamplePath: null,
        runDetails: { numRuns: 5, numSkips: 0, numShrinks: 0, interrupted: false },
      },
      {
        name: "unacknowledged-mutations-never-visible",
        passed: false,
        seed: 4_242,
        runCount: 5,
        counterexamplePath: expect.any(String),
        runDetails: {
          numRuns: 1,
          numSkips: 0,
          numShrinks: expect.any(Number),
          interrupted: false,
        },
      },
    ],
    minimizedCounterexamples: [
      {
        name: "unacknowledged-mutations-never-visible",
        value: scenarioWithValue(1),
      },
    ],
  });
  expect(Object.keys(report.sourceHashes)).toEqual([
    "tests/model/multilevel/alpha.ts",
    "tests/model/multilevel/zeta.ts",
  ]);

  const reportPath = await writeModelStudyReport(report, repoRoot);
  const firstContents = await readFile(reportPath, "utf8");
  expect(firstContents).toBe(`${JSON.stringify(report, null, 2)}\n`);
  await expect(writeModelStudyReport(report, repoRoot)).rejects.toMatchObject({ code: "EEXIST" });
  await expect(readFile(reportPath, "utf8")).resolves.toBe(firstContents);
});

// This is the acceptance pass's product, and it runs the real registry at the
// real volume on purpose. Two consequences worth stating, because both look like
// waste from the outside.
//
// It is about half of `pnpm model:multilevel` — measured, 22.4s against
// properties.test.ts's 20.2s at `FC_NUM_RUNS=300`. It is not a second copy of
// that run: the seed here is independent of properties.test.ts's `20_260_803`
// over the same twelve arbitraries, so the pass draws 2 × `FC_NUM_RUNS` distinct
// scenarios per property rather than one set twice. For a design-time model,
// more distinct schedules is the whole product.
//
// And it cannot be cheapened by injecting stub properties or dropping the run
// count. The report records `runCount` and per-property `numRuns` as its
// evidence, and README.md offers a green one as the claim that the design admits
// no counterexample within the envelope. A report generated from stubs attests
// nothing while still looking citable, which is worse than no report.
//
// properties.test.ts keeps its own full-volume block for a different job: it
// names each property as a vitest test and surfaces the evidence string, where a
// failure here reaches you only through `results.every(passed)`.
test("writes a complete passing report for the executable model registry", async () => {
  const repoRoot = process.cwd();
  const report = await runModelStudy({
    repoRoot,
    createdAt: new Date(),
    seed: 0x5eed5eed,
    runCount: Number(process.env["FC_NUM_RUNS"] ?? 100),
    assumptions: DEFAULT_MODEL_ASSUMPTIONS,
  });

  // Checks propagation of the recorded baseline into the report, not the
  // literal value: pinning the literal here made a rebaseline fail this test
  // for no reason while never catching a stale baseline.
  expect(report.baseSha).toBe(MODEL_BASE_SHA);
  const reportPath = await writeModelStudyReport(report, repoRoot);
  const persisted = JSON.parse(await readFile(reportPath, "utf8"));
  expect(persisted).toEqual(report);
  expect(report.results.map(({ name }) => name)).toEqual(MODEL_PROPERTIES.map(({ name }) => name));
  expect(report.results).toHaveLength(12);
  expect(report.results.every(({ passed }) => passed)).toBe(true);
  expect(report.minimizedCounterexamples).toEqual([]);
  console.log(`wrote ${reportPath}`);
}, 1_200_000);

test("runs the default registry with the report's custom workload assumptions", async () => {
  const assumptions = {
    ...DEFAULT_MODEL_ASSUMPTIONS,
    maxLiveDocuments: 2,
    maxRunsPerLevel: 3,
    maxCommittedSuffixEntries: 4,
    maxConcurrentPublishers: 3,
    maxScheduleOperations: 32,
  };
  const report = await runModelStudy({
    repoRoot: process.cwd(),
    createdAt: new Date("2026-08-03T00:00:00.000Z"),
    seed: 0x7a55,
    runCount: 2,
    assumptions,
  });

  expect(report.assumptions).toBe(assumptions);
  expect(report.results.map(({ name }) => name)).toEqual(MODEL_PROPERTIES.map(({ name }) => name));
  expect(report.results.every(({ passed }) => passed)).toBe(true);
});

test("records an injected scenario assumption mismatch as shrunk failed report data", async () => {
  let checkerCalls = 0;
  const property: ModelPropertyDefinition = {
    name: "acknowledged-mutations-never-lost",
    arbitrary: fc.integer({ min: 1, max: 100 }).map((offset) =>
      scenarioWithValue(offset, {
        ...DEFAULT_MODEL_ASSUMPTIONS,
        maxLiveDocuments: DEFAULT_MODEL_ASSUMPTIONS.maxLiveDocuments + offset,
      }),
    ),
    check: () => {
      checkerCalls += 1;
      return { name: "acknowledged-mutations-never-lost", ok: true, evidence: [] };
    },
  };

  const report = await runModelStudy({
    repoRoot: process.cwd(),
    createdAt: new Date("2026-08-03T01:00:00.000Z"),
    seed: 0x51eed,
    runCount: 100,
    assumptions: DEFAULT_MODEL_ASSUMPTIONS,
    properties: [property],
  });

  expect(checkerCalls).toBe(0);
  expect(report.results).toEqual([
    expect.objectContaining({
      name: "acknowledged-mutations-never-lost",
      passed: false,
      counterexamplePath: expect.any(String),
      runDetails: expect.objectContaining({
        numShrinks: expect.any(Number),
        error: expect.stringContaining("model assumption mismatch: maxLiveDocuments=9; expected=8"),
      }),
    }),
  ]);
  expect(report.results[0]?.runDetails.numShrinks).toBeGreaterThan(0);
  expect(report.minimizedCounterexamples).toEqual([
    {
      name: "acknowledged-mutations-never-lost",
      value: scenarioWithValue(1, { ...DEFAULT_MODEL_ASSUMPTIONS, maxLiveDocuments: 9 }),
    },
  ]);
});

test("accepts value-identical separate assumption objects before invoking an injected checker", async () => {
  let checkerCalls = 0;
  const scenarioAssumptions = { ...DEFAULT_MODEL_ASSUMPTIONS };
  const property: ModelPropertyDefinition = {
    name: "acknowledged-mutations-never-lost",
    arbitrary: fc.constant(scenarioWithValue(7, scenarioAssumptions)),
    check: () => {
      checkerCalls += 1;
      return { name: "acknowledged-mutations-never-lost", ok: true, evidence: [] };
    },
  };

  const report = await runModelStudy({
    repoRoot: process.cwd(),
    createdAt: new Date("2026-08-03T02:00:00.000Z"),
    seed: 0x51eed,
    runCount: 3,
    assumptions: DEFAULT_MODEL_ASSUMPTIONS,
    properties: [property],
  });

  expect(scenarioAssumptions).not.toBe(DEFAULT_MODEL_ASSUMPTIONS);
  expect(checkerCalls).toBe(3);
  expect(report.results[0]).toMatchObject({ passed: true });
});

test("rejects an unsupported report envelope before running injected properties", async () => {
  let checkerCalls = 0;
  const property: ModelPropertyDefinition = {
    name: "acknowledged-mutations-never-lost",
    arbitrary: fc.constant(scenarioWithValue(7)),
    check: () => {
      checkerCalls += 1;
      return { name: "acknowledged-mutations-never-lost", ok: true, evidence: [] };
    },
  };

  await expect(
    runModelStudy({
      repoRoot: process.cwd(),
      createdAt: new Date("2026-08-03T03:00:00.000Z"),
      seed: 0x51eed,
      runCount: 3,
      assumptions: {
        maxLiveDocuments: 1,
        maxActiveLevels: 2,
        maxRunsPerLevel: 1,
        maxCommittedSuffixEntries: 1,
        maxConcurrentPublishers: 2,
        maxScheduleOperations: 3,
      },
      properties: [property],
    }),
  ).rejects.toThrowError("invalid full-suite assumption maxScheduleOperations=3; minimum=4");
  expect(checkerCalls).toBe(0);
});
