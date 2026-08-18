import { describe, expect, test } from "vitest";
import { clopperPearsonZeroFailureUpper } from "./statistics.ts";
import {
  WorkloadCeilingHarnessError,
  type WorkloadCeilingRawEvent,
} from "./workload-ceiling-harness.ts";
import {
  buildWorkloadCeilingComparisonReport,
  matchWorkloadCeilingEvents,
  readEventsFromDirectory,
} from "./workload-ceiling-compare.ts";

const event = (over: Partial<WorkloadCeilingRawEvent>): WorkloadCeilingRawEvent => ({
  run_id: "r1",
  scenario_id: "s0",
  script_version: "v1",
  compatibility_date: "2026-08-15",
  runtime_period: "a/b",
  colo: "SJC",
  thermal_class: "unknown",
  outcome: "ok",
  cpu_ms: 10,
  observed_at: "2026-08-18T00:00:00Z",
  ...over,
});

const reportInput = (
  matched: ReturnType<typeof matchWorkloadCeilingEvents>,
  controlEvents: readonly WorkloadCeilingRawEvent[],
  candidateEvents: readonly WorkloadCeilingRawEvent[],
) => ({
  matched,
  controlEvents,
  candidateEvents,
  confidence: 0.95,
  seed: 0,
  resamples: 50,
});

describe("matchWorkloadCeilingEvents", () => {
  test("pairs control and candidate sharing scenario and deployment metadata", () => {
    const matched = matchWorkloadCeilingEvents(
      [event({ scenario_id: "s1", cpu_ms: 10 })],
      [event({ scenario_id: "s1", cpu_ms: 20 })],
    );
    expect(matched.pairs).toHaveLength(1);
    expect(matched.incomplete).toEqual([]);
    expect(matched.pairs[0]!.control.cpu_ms).toBe(10);
  });

  test.each([
    ["missing-candidate", [event({ scenario_id: "s1" })], []],
    ["missing-control", [], [event({ scenario_id: "s1" })]],
  ] as const)("%s is reported by name", (reason, control, candidate) => {
    const matched = matchWorkloadCeilingEvents(control, candidate);
    expect(matched.pairs).toEqual([]);
    expect(matched.incomplete).toEqual([{ scenario_id: "s1", reason }]);
  });

  test("duplicate scenarios are evicted and reported on the side they occur", () => {
    const matched = matchWorkloadCeilingEvents(
      [event({ scenario_id: "s1", cpu_ms: 1 }), event({ scenario_id: "s1", cpu_ms: 2 })],
      [event({ scenario_id: "s1", cpu_ms: 3 })],
    );
    expect(matched.pairs).toEqual([]);
    expect(matched.incomplete).toContainEqual({
      scenario_id: "s1",
      reason: "duplicate-scenario",
    });
  });

  test("deployment metadata mismatch rejects the pair", () => {
    const matched = matchWorkloadCeilingEvents(
      [event({ scenario_id: "s1", script_version: "v1" })],
      [event({ scenario_id: "s1", script_version: "v2" })],
    );
    expect(matched.incomplete).toEqual([
      { scenario_id: "s1", reason: "deployment-metadata-mismatch" },
    ]);
  });

  test("a null cpu_ms on either side rejects the pair as unresolved-cpu", () => {
    const matched = matchWorkloadCeilingEvents(
      [event({ scenario_id: "s1", cpu_ms: 10 })],
      [event({ scenario_id: "s1", cpu_ms: null, outcome: "exceededCpu" })],
    );
    expect(matched.incomplete).toEqual([{ scenario_id: "s1", reason: "unresolved-cpu" }]);
  });
});

describe("buildWorkloadCeilingComparisonReport", () => {
  const control = [
    event({ scenario_id: "s1", cpu_ms: 10 }),
    event({ scenario_id: "s2", cpu_ms: 20 }),
  ];
  const candidate = [
    event({ scenario_id: "s1", cpu_ms: 15 }),
    event({ scenario_id: "s2", cpu_ms: 25 }),
  ];

  test("reports quantiles and a deterministic bootstrap interval", () => {
    const matched = matchWorkloadCeilingEvents(control, candidate);
    const report = buildWorkloadCeilingComparisonReport(reportInput(matched, control, candidate));
    expect(report.pair_count).toBe(2);
    // r7 interpolation: p50 of two values sits halfway between them.
    expect(report.control_cpu_ms.p50.value).toBe(15);
    expect(report.candidate_cpu_ms.p50.value).toBe(20);
    const again = buildWorkloadCeilingComparisonReport(reportInput(matched, control, candidate));
    expect(again.paired_candidate_over_control_ratio).toEqual(
      report.paired_candidate_over_control_ratio,
    );
  });

  test("zero pairs throws WorkloadCeilingHarnessError on the pairs field", () => {
    try {
      buildWorkloadCeilingComparisonReport(reportInput(matchWorkloadCeilingEvents([], []), [], []));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(WorkloadCeilingHarnessError);
      expect((error as WorkloadCeilingHarnessError).field).toBe("pairs");
    }
  });

  test("failure budget is computed over ALL collected events, not surviving pairs", () => {
    // Duplicate s1 on the control side evicts it from pairing, but all
    // three control attempts still count toward the failure budget.
    const controlAll = [...control, event({ scenario_id: "s1", cpu_ms: 99 })];
    const matched = matchWorkloadCeilingEvents(controlAll, candidate);
    expect(matched.pairs).toHaveLength(1); // only s2 survives
    const report = buildWorkloadCeilingComparisonReport(
      reportInput(matched, controlAll, candidate),
    );
    expect(report.zero_failure_upper_bound.control).toEqual(
      clopperPearsonZeroFailureUpper(3, 0.95),
    );
  });

  test("an empty event list clamps the Clopper-Pearson denominator to one", () => {
    const matched = matchWorkloadCeilingEvents(control, candidate);
    const report = buildWorkloadCeilingComparisonReport(reportInput(matched, [], []));
    expect(report.zero_failure_upper_bound.control).toEqual(
      clopperPearsonZeroFailureUpper(1, 0.95),
    );
  });

  test("a side with unresolved events is marked invalid, never given an anti-conservative bound", () => {
    // One exceededCpu attempt on the control side only. The zero-failure
    // formula (1 - c^(1/n)) has no honest reading at F > 0 — with the
    // current N−F denominator MORE failures would tighten it — so the
    // control side must be reported as invalid by name, while the
    // all-resolved candidate side still gets its valid bound.
    const controlAll = [
      ...control,
      event({ scenario_id: "s3", cpu_ms: null, outcome: "exceededCpu" }),
    ];
    const matched = matchWorkloadCeilingEvents(controlAll, candidate);
    expect(matched.incomplete).toContainEqual({ scenario_id: "s3", reason: "missing-candidate" });
    const report = buildWorkloadCeilingComparisonReport(
      reportInput(matched, controlAll, candidate),
    );
    expect(report.zero_failure_upper_bound.control).toEqual({
      invalid: "failures-present",
      failure_count: 1,
    });
    expect(report.zero_failure_upper_bound.candidate).toEqual(
      clopperPearsonZeroFailureUpper(candidate.length, 0.95),
    );
  });
});

describe("readEventsFromDirectory failure mode", () => {
  test("a missing directory rejects loudly instead of looking like no data", async () => {
    await expect(readEventsFromDirectory("bench/results/definitely-missing-dir")).rejects.toThrow(
      /cannot read events directory/,
    );
  });
});
