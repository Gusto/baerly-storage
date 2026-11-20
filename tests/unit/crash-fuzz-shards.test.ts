import { describe, expect, test } from "vitest";

import {
  evidenceFromReport,
  replayCommand,
  shardsFromList,
} from "../../scripts/crash-fuzz-shards.ts";

const FAILURE = [
  "Error: Property failed after 3 tests",
  '{ seed: -42, path: "2:0:1", endOnFailure: true }',
  'Counterexample: [{"n":4}]',
].join("\n");

describe("shardsFromList", () => {
  const listed = [
    { name: "suite > compact() with a fault (with seed=123)" },
    { name: "suite > [memory] plain test" },
    { name: "suite > [local-fs] plain test" },
  ];

  test("each pattern selects its own test whatever the per-run seed", () => {
    const shards = shardsFromList(listed);
    expect(shards.map((s) => s.name)).toEqual([
      "suite > compact() with a fault",
      "suite > [memory] plain test",
      "suite > [local-fs] plain test",
    ]);
    const [prop, memory] = shards;
    expect(new RegExp(prop!.pattern).test("suite > compact() with a fault (with seed=-9)")).toBe(
      true,
    );
    expect(new RegExp(prop!.pattern).test("suite > compact with a fault (with seed=-9)")).toBe(
      false,
    );
    expect(new RegExp(memory!.pattern).test("suite > [local-fs] plain test")).toBe(false);
  });

  test("refuses an empty list and a pattern that selects two tests", () => {
    expect(() => shardsFromList([])).toThrow(/no tests/);
    expect(() => shardsFromList([{ name: "a > b" }, { name: "a > b" }])).toThrow(/matches 2/);
  });
});

describe("evidenceFromReport", () => {
  const report = (results: { fullName: string; status: string; failureMessages: string[] }[]) => ({
    testResults: [{ assertionResults: results }],
  });
  const env = { CRASH_FUZZ_SHA: "abc", CRASH_FUZZ_PATTERN: "^a > b$", FC_NUM_RUNS: "10000" };

  test("a failure records the reported seed and path, and its replay command", () => {
    const { evidence, ok, problem } = evidenceFromReport(
      report([{ fullName: "a b (with seed=-42)", status: "failed", failureMessages: [FAILURE] }]),
      env,
    );
    expect(ok).toBe(false);
    expect(problem).toBeNull();
    expect(evidence).toMatchObject({ commit: "abc", status: "failed", seed: -42, path: "2:0:1" });
    expect(replayCommand(evidence)).toBe(
      "FC_SEED=-42 FC_PATH='2:0:1' FC_NUM_RUNS=10000 pnpm test:agent tests/integration/maintenance-crash-fuzz.test.ts -t '^a > b$'",
    );
  });

  test("an interrupted property records the seed with no path", () => {
    const { evidence } = evidenceFromReport(
      report([
        {
          fullName: "a b (with seed=7)",
          status: "failed",
          failureMessages: ["Error: Property interrupted after 5 tests\n{ seed: 7 }"],
        },
      ]),
      env,
    );
    expect(evidence).toMatchObject({ seed: 7, path: null });
  });

  test("a pass takes the seed from the test name, else from FC_SEED", () => {
    const named = evidenceFromReport(
      report([{ fullName: "a b (with seed=9)", status: "passed", failureMessages: [] }]),
      env,
    );
    expect(named).toMatchObject({ ok: true, evidence: { seed: 9, path: null, failure: null } });
    const fromEnv = evidenceFromReport(
      report([{ fullName: "a b", status: "passed", failureMessages: [] }]),
      { ...env, FC_SEED: "11" },
    );
    expect(fromEnv.evidence.seed).toBe(11);
  });

  test("is not ok unless exactly one test ran", () => {
    const none = evidenceFromReport(
      report([{ fullName: "a b", status: "skipped", failureMessages: [] }]),
      env,
    );
    expect(none).toMatchObject({ ok: false, problem: expect.stringMatching(/got 0/) });
    const two = evidenceFromReport(
      report([
        { fullName: "a b", status: "passed", failureMessages: [] },
        { fullName: "a c", status: "passed", failureMessages: [] },
      ]),
      env,
    );
    expect(two).toMatchObject({ ok: false, problem: expect.stringMatching(/got 2/) });
  });
});
