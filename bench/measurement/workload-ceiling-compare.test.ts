import { describe, expect, test } from "vitest";
import { clopperPearsonZeroFailureUpper } from "./statistics.ts";
import {
  WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
  WorkloadCeilingHarnessError,
  type WorkloadCeilingRawEvent,
} from "./workload-ceiling-harness.ts";
import {
  assessWorkloadCeilingExecution,
  buildWorkloadCeilingComparisonReport,
  matchWorkloadCeilingEvents,
  readEventsFromDirectory,
} from "./workload-ceiling-compare.ts";

const event = (over: Partial<WorkloadCeilingRawEvent>): WorkloadCeilingRawEvent => ({
  evidence_contract_id: WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
  run_id: "r1",
  scenario_id: "s0",
  script_version: "v1",
  compatibility_date: "2026-08-15",
  runtime_period: "a/b",
  colo: "SJC",
  thermal_class: "unknown",
  outcome: "success",
  cpu_ms: 10,
  observed_at: "2026-08-18T00:00:00Z",
  evidence: {
    status: "resolved",
    detail: null,
    authority: "workers-observability",
    authoritative_outcome: "ok",
    authoritative_cpu_ms: 10,
    authoritative_response_status: 200,
    cpu_source: "workers-invocations-adaptive",
    cpu_outcome_verbatim: "success",
  },
  ...over,
});

/** A successful invocation whose adaptive CPU row never landed — the rehearsal's missingness shape. */
const cpuMissingSuccess = (over: Partial<WorkloadCeilingRawEvent>): WorkloadCeilingRawEvent =>
  event({
    cpu_ms: null,
    evidence: {
      status: "resolved",
      detail: null,
      authority: "workers-observability",
      authoritative_outcome: "ok",
      authoritative_cpu_ms: 7,
      authoritative_response_status: 200,
      cpu_source: "none",
      cpu_outcome_verbatim: null,
    },
    ...over,
  });

/** An invocation whose authoritative record never arrived. */
const evidenceMissing = (over: Partial<WorkloadCeilingRawEvent>): WorkloadCeilingRawEvent =>
  event({
    script_version: "unresolved",
    colo: "unknown",
    outcome: null,
    cpu_ms: null,
    evidence: {
      status: "missing",
      detail: "no workers-observability join line for run_id in window",
      authority: "workers-observability",
      authoritative_outcome: null,
      authoritative_cpu_ms: null,
      authoritative_response_status: null,
      cpu_source: "none",
      cpu_outcome_verbatim: null,
    },
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
    expect(matched.pairs[0]!.control.p50.value).toBe(10);
    expect(matched.pairs[0]!.candidate.p50.value).toBe(20);
  });

  test.each([
    ["missing-candidate", [event({ scenario_id: "s1" })], []],
    ["missing-control", [], [event({ scenario_id: "s1" })]],
  ] as const)("%s is reported by name", (reason, control, candidate) => {
    const matched = matchWorkloadCeilingEvents(control, candidate);
    expect(matched.pairs).toEqual([]);
    expect(matched.incomplete).toEqual([{ scenario_id: "s1", reason }]);
  });

  test("repeated invocations of one scenario are the sample, not a rejection", () => {
    // The regression this module exists to prevent: the capture runner emits
    // n invocations per cell per arm, ALL carrying that cell's one
    // scenario_id. An earlier revision keyed a Map on scenario_id and evicted
    // the repeats, so a real capture produced zero pairs after every hour of
    // platform time was already spent.
    const matched = matchWorkloadCeilingEvents(
      [
        event({ scenario_id: "s1", cpu_ms: 1 }),
        event({ scenario_id: "s1", cpu_ms: 2 }),
        event({ scenario_id: "s1", cpu_ms: 3 }),
      ],
      [event({ scenario_id: "s1", cpu_ms: 10 })],
    );
    expect(matched.incomplete).toEqual([]);
    expect(matched.pairs).toHaveLength(1);
    expect(matched.pairs[0]!.control.sample_count).toBe(3);
    expect(matched.pairs[0]!.control.p50.value).toBe(2);
  });

  test("a side whose own events name two deployments is reported as a mid-capture redeploy", () => {
    const matched = matchWorkloadCeilingEvents(
      [
        event({ scenario_id: "s1", cpu_ms: 1, script_version: "v1" }),
        event({ scenario_id: "s1", cpu_ms: 2, script_version: "v2" }),
      ],
      [event({ scenario_id: "s1", cpu_ms: 3, script_version: "v1" })],
    );
    expect(matched.pairs).toEqual([]);
    expect(matched.incomplete).toEqual([
      { scenario_id: "s1", reason: "mixed-deployment-within-side" },
    ]);
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

  test("a side with no finite-CPU success at all rejects the pair as unresolved-cpu", () => {
    const matched = matchWorkloadCeilingEvents(
      [event({ scenario_id: "s1", cpu_ms: 10 })],
      [event({ scenario_id: "s1", cpu_ms: null, outcome: "exceededCpu" })],
    );
    expect(matched.incomplete).toEqual([{ scenario_id: "s1", reason: "unresolved-cpu" }]);
  });

  test("one unusable invocation does not reject a side that has other samples", () => {
    // The counterpart of the rule above, and the reason it is a SIDE-level
    // gate: at 40 planned invocations per cell a single censored or
    // telemetry-dropped one must narrow the sample, not delete the cell.
    const matched = matchWorkloadCeilingEvents(
      [
        event({ scenario_id: "s1", cpu_ms: 10 }),
        event({ scenario_id: "s1", cpu_ms: 12 }),
        event({ scenario_id: "s1", cpu_ms: 900, outcome: "exceededCpu" }),
      ],
      [event({ scenario_id: "s1", cpu_ms: 20 })],
    );
    expect(matched.incomplete).toEqual([]);
    expect(matched.pairs[0]!.control.sample_count).toBe(2);
    expect(matched.pairs[0]!.control.collected_event_count).toBe(3);
    expect(matched.pairs[0]!.control.p50.value).toBe(11);
  });

  test("a non-ok outcome carrying a partial cpu_ms is never a sample", () => {
    // The platform reports a partial CPU number alongside `exceededCpu`, and
    // the harness codec preserves that shape — so cpu_ms being non-null is
    // not evidence the invocation resolved. With it excluded, this side has
    // no samples left and the cell is rejected.
    const matched = matchWorkloadCeilingEvents(
      [event({ scenario_id: "s1", cpu_ms: 10 })],
      [event({ scenario_id: "s1", cpu_ms: 50, outcome: "exceededCpu" })],
    );
    expect(matched.pairs).toEqual([]);
    expect(matched.incomplete).toEqual([{ scenario_id: "s1", reason: "unresolved-cpu" }]);
  });
});

describe("assessWorkloadCeilingExecution", () => {
  test("separates execution failures from evidence missingness and CPU missingness", () => {
    const assessment = assessWorkloadCeilingExecution([
      event({ run_id: "r1", scenario_id: "s1" }),
      cpuMissingSuccess({ run_id: "r2", scenario_id: "s2" }),
      evidenceMissing({ run_id: "r3", scenario_id: "s3" }),
      event({ run_id: "r4", scenario_id: "s4", outcome: "exceededCpu", cpu_ms: 50 }),
    ]);
    expect(assessment.authoritative_event_count).toBe(3);
    expect(assessment.execution_failure_count).toBe(1);
    expect(assessment.evidence_missing_count).toBe(1);
    expect(assessment.evidence_ambiguous_count).toBe(0);
    expect(assessment.finite_cpu_sample_count).toBe(1);
    expect(assessment.outcome_histogram).toEqual({ success: 2, exceededCpu: 1 });
  });

  test("a missing adaptive row with successful observability is not an execution failure", () => {
    const assessment = assessWorkloadCeilingExecution([
      cpuMissingSuccess({ run_id: "r1", scenario_id: "s1" }),
    ]);
    expect(assessment.execution_failure_count).toBe(0);
    expect(assessment.authoritative_event_count).toBe(1);
    expect(assessment.finite_cpu_sample_count).toBe(0);
  });

  test("adding successful events never erases an observed failure", () => {
    const oneFailure = assessWorkloadCeilingExecution([
      event({ run_id: "r1", scenario_id: "s1", outcome: "exceededCpu", cpu_ms: 50 }),
    ]);
    // The "top-up" scenario: however many clean successes are appended —
    // before or after observing the failure — the failure count and the
    // evidence gaps stay what they are. There is no post-hoc remedy.
    const toppedUp = assessWorkloadCeilingExecution([
      ...Array.from({ length: 39 }, (_, i) =>
        event({ run_id: `r${100 + i}`, scenario_id: `s${i}` }),
      ),
      event({ run_id: "r1", scenario_id: "s1", outcome: "exceededCpu", cpu_ms: 50 }),
      evidenceMissing({ run_id: "r2", scenario_id: "s2" }),
    ]);
    expect(toppedUp.execution_failure_count).toBe(oneFailure.execution_failure_count);
    expect(toppedUp.evidence_missing_count).toBe(1);
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
    // s3 has no candidate side, so it never pairs — but its control attempt
    // still counts toward the failure budget, which is assessed over every
    // invocation the capture actually made.
    const controlAll = [...control, event({ scenario_id: "s3", cpu_ms: 99 })];
    const matched = matchWorkloadCeilingEvents(controlAll, candidate);
    expect(matched.pairs).toHaveLength(2);
    expect(matched.incomplete).toEqual([{ scenario_id: "s3", reason: "missing-candidate" }]);
    const report = buildWorkloadCeilingComparisonReport(
      reportInput(matched, controlAll, candidate),
    );
    expect(report.zero_failure_upper_bound.control).toEqual(
      clopperPearsonZeroFailureUpper(3, 0.95),
    );
  });

  test("the pooled quantiles ignore samples from cells that never paired", () => {
    // s3's 900 ms control sample is real and counts against the failure
    // budget, but it belongs to no pair — folding it into the pooled
    // distribution would let an unmatched cell move a number the matched
    // comparison reports.
    const controlAll = [...control, event({ scenario_id: "s3", cpu_ms: 900 })];
    const report = buildWorkloadCeilingComparisonReport(
      reportInput(matchWorkloadCeilingEvents(controlAll, candidate), controlAll, candidate),
    );
    expect(report.control_cpu_ms.p99.sample_size).toBe(2);
    expect(report.control_cpu_ms.p99.value).toBeLessThan(900);
  });

  test("the pooled quantiles read every invocation of a paired cell, not its p50", () => {
    // The two views the report carries are different on purpose: `pairs` is
    // per-cell, `control_cpu_ms` is the pooled sample across paired cells.
    const controlAll = [...control, event({ scenario_id: "s1", cpu_ms: 30 })];
    const report = buildWorkloadCeilingComparisonReport(
      reportInput(matchWorkloadCeilingEvents(controlAll, candidate), controlAll, candidate),
    );
    expect(report.control_cpu_ms.p50.sample_size).toBe(3);
    expect(report.pairs).toHaveLength(2);
    expect(report.pairs[0]!.control.p50.value).toBe(20); // s1: median of 10 and 30
  });

  test("a non-ok event carrying a partial cpu_ms counts as a failure, not a success", () => {
    // The anti-conservative reading the invalid marker exists to prevent: an
    // `exceededCpu` invocation the platform reported a partial CPU number for
    // is a real observed failure. Counting it toward the success denominator
    // would hand this side a valid-looking zero-failure bound.
    const controlAll = [
      ...control,
      event({ scenario_id: "s3", cpu_ms: 50, outcome: "exceededCpu" }),
    ];
    const matched = matchWorkloadCeilingEvents(controlAll, candidate);
    const report = buildWorkloadCeilingComparisonReport(
      reportInput(matched, controlAll, candidate),
    );
    expect(report.zero_failure_upper_bound.control).toEqual({
      invalid: "failures-present",
      failure_count: 1,
    });
  });

  test("an empty event list clamps the Clopper-Pearson denominator to one", () => {
    const matched = matchWorkloadCeilingEvents(control, candidate);
    const report = buildWorkloadCeilingComparisonReport(reportInput(matched, [], []));
    expect(report.zero_failure_upper_bound.control).toEqual(
      clopperPearsonZeroFailureUpper(1, 0.95),
    );
  });

  test("evidence missingness neither fails a side nor widens its zero-failure denominator", () => {
    // The evidence-contract v2 split: an invocation whose authoritative record
    // never arrived is not an execution failure, so it cannot invalidate the
    // bound — but it is not a success either, so it must not enter the
    // denominator. The bound is computed over AUTHORITATIVE events only.
    const controlAll = [...control, evidenceMissing({ scenario_id: "s3" })];
    const matched = matchWorkloadCeilingEvents(controlAll, candidate);
    const report = buildWorkloadCeilingComparisonReport(
      reportInput(matched, controlAll, candidate),
    );
    expect(report.zero_failure_upper_bound.control).toEqual(
      clopperPearsonZeroFailureUpper(2, 0.95),
    );
  });

  test("a CPU-missing success keeps a valid bound while contributing no sample", () => {
    const controlAll = [...control, cpuMissingSuccess({ scenario_id: "s3" })];
    const matched = matchWorkloadCeilingEvents(controlAll, candidate);
    expect(matched.incomplete).toContainEqual({ scenario_id: "s3", reason: "missing-candidate" });
    const report = buildWorkloadCeilingComparisonReport(
      reportInput(matched, controlAll, candidate),
    );
    expect(report.zero_failure_upper_bound.control).toEqual(
      clopperPearsonZeroFailureUpper(3, 0.95),
    );
  });

  test("an exceededCpu side is marked invalid by name, while the clean side keeps its bound", () => {
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
