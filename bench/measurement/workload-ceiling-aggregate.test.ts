/**
 * Tests for workload-ceiling-aggregate.ts — per-cell aggregation under
 * evidence-contract v2: execution outcome, evidence completeness, and CPU
 * sample completeness as three separate gates.
 */
import { test, expect } from "vitest";
import {
  assessWorkloadCeilingCellEvidence,
  buildWorkloadCeilingAxisReport,
} from "./workload-ceiling-aggregate.ts";
import { WORKLOAD_CEILING_STUDY } from "./workload-ceiling-contract.ts";
import {
  WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
  type WorkloadCeilingImplementation,
  WorkloadCeilingHarnessError,
  type WorkloadCeilingInvocationRecord,
  type WorkloadCeilingRawEvent,
  type WorkloadCeilingSweepCell,
} from "./workload-ceiling-harness.ts";

/** Helper: build a raw event with defaults. */
const rawEvent = (overrides: Partial<WorkloadCeilingRawEvent>): WorkloadCeilingRawEvent => ({
  evidence_contract_id: WORKLOAD_CEILING_EVIDENCE_CONTRACT_ID,
  run_id: "run-1",
  scenario_id: "byte-axis/1MiB",
  script_version: "v1",
  compatibility_date: "2024-01-01",
  runtime_period: "2024-01-01",
  colo: "dfw",
  thermal_class: "cold",
  outcome: "success",
  cpu_ms: 10,
  observed_at: "2024-01-01T00:00:00Z",
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
  ...overrides,
});

/** A successful invocation whose adaptive CPU row never landed. */
const cpuMissingSuccess = (overrides: Partial<WorkloadCeilingRawEvent>): WorkloadCeilingRawEvent =>
  rawEvent({
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
    ...overrides,
  });

/** An invocation whose authoritative record never arrived. */
const evidenceMissing = (overrides: Partial<WorkloadCeilingRawEvent>): WorkloadCeilingRawEvent =>
  rawEvent({
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
    ...overrides,
  });

/** Helper: build a sweep cell with all required fields for tests. */
const testCell = (overrides: {
  readonly scenario_id: string;
  readonly target_bytes: number;
  readonly achieved_bytes: number;
  readonly row_count: number;
}): WorkloadCeilingSweepCell => ({
  scenario_id: overrides.scenario_id,
  axis: "byte",
  target_bytes: overrides.target_bytes,
  achieved_bytes: overrides.achieved_bytes,
  row_count: overrides.row_count,
  document_bytes: 100,
  manifest_descriptors: 10,
  fixture_prefix: "test-fixture",
  incarnation: "test-incarnation",
  monolithic_key: "test-monolithic-key",
  manifest_key: "test-manifest-key",
  descriptor_canonical_hash: "test-hash",
});

/** Helper: journal (planned-invocation) records for one cell/arm. */
const plannedRecords = (
  count: number,
  scenarioId = "byte-axis/1MiB",
  implementation = "monolithic-control",
): WorkloadCeilingInvocationRecord[] =>
  Array.from({ length: count }, (_, i) => ({
    contract_id: "baerly.workload-ceiling/chunked-snapshot/v1",
    sweep_id: "test-sweep",
    run_id: `planned-${i}`,
    scenario_id: scenarioId,
    implementation: implementation as WorkloadCeilingInvocationRecord["implementation"],
    fixture_prefix: "test-fixture",
    warmup: false,
    invoked_at: "2026-08-24T17:30:00.000Z",
    window_gte: "2026-08-24T17:30:00.000Z",
    window_lt: "2026-08-24T17:31:00.000Z",
    http_status: 200,
    row_count: 491,
    thermal_class: "warm",
  }));

/** Helper: build multiple events sharing one scenario_id. */
const withEvents = (
  count: number,
  base: Partial<WorkloadCeilingRawEvent> = {},
): WorkloadCeilingRawEvent[] =>
  Array.from({ length: count }, (_, i) => rawEvent({ ...base, run_id: `run-${i}` }));

const oneCellReport = (
  events: readonly WorkloadCeilingRawEvent[],
  planned: readonly WorkloadCeilingInvocationRecord[],
  implementation: WorkloadCeilingImplementation = "monolithic-control",
) =>
  buildWorkloadCeilingAxisReport({
    sweepId: "test-sweep",
    axis: "byte",
    cells: [
      testCell({
        scenario_id: "byte-axis/1MiB",
        target_bytes: 1_048_576,
        achieved_bytes: 1_048_576,
        row_count: 1000,
      }),
    ],
    plannedInvocations: planned,
    eventsByArm: new Map([[implementation, events]]),
  });

const expectRefusal = (fn: () => unknown): { field: string; message: string } => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkloadCeilingHarnessError);
    const harnessError = error as WorkloadCeilingHarnessError;
    return { field: harnessError.field, message: harnessError.message };
  }
  expect.unreachable();
  return { field: "unreachable", message: "unreachable" };
};

test("groups repetitions of one scenario into one cell, rather than evicting them", () => {
  const report = oneCellReport(withEvents(30), plannedRecords(30));
  expect(report.cells).toHaveLength(1);
  expect(report.cells[0]!.evidence.collected_event_count).toBe(30);
  expect(report.cells[0]!.cpu_ms!.p50.sample_size).toBe(30);
});

test("the report carries the evidence-contract revision, so old and new reports cannot be confused", () => {
  const report = oneCellReport(withEvents(30), plannedRecords(30));
  expect(report.evidence_contract_id).toBe("baerly.workload-ceiling/evidence/v2");
});

test("every emitted statistic carries its algorithm tag", () => {
  const cell = oneCellReport(withEvents(30), plannedRecords(30)).cells[0]!;
  expect(cell.cpu_ms!.p50.algorithm).toBe("quantile-r7-v1");
  expect(cell.cpu_ms!.dispersion.algorithm).toBe("mad-from-median-v1");
  expect(cell.failure_upper_bound.algorithm).toBe("wilson-one-sided-upper-v1");
});

test("a complete cell reports the full evidence assessment", () => {
  const cell = oneCellReport(withEvents(30), plannedRecords(30)).cells[0]!;
  expect(cell.evidence).toMatchObject({
    planned_count: 30,
    collected_event_count: 30,
    authoritative_event_count: 30,
    execution_failure_count: 0,
    evidence_missing_count: 0,
    evidence_ambiguous_count: 0,
    finite_cpu_sample_count: 30,
    cpu_sample_floor: WORKLOAD_CEILING_STUDY.capture.cpu_sample_floor_per_cell,
    complete: true,
    cpu_complete: true,
  });
  expect(cell.zero_failure_upper_bound).toMatchObject({
    algorithm: "clopper-pearson-zero-failure-upper-v1",
    failures: 0,
    attempts: 30,
  });
});

test("missing adaptive rows with successful observability do not become execution failures", () => {
  // The rehearsal's exact shape: 40 planned, all 40 authoritative successes,
  // 2 CPU rows dropped. Admission-worthy on every v2 gate.
  const events = [
    ...withEvents(38, { scenario_id: "byte-axis/1MiB", cpu_ms: 5 }),
    ...Array.from({ length: 2 }, (_, i) =>
      cpuMissingSuccess({ run_id: `dropped-${i}`, scenario_id: "byte-axis/1MiB" }),
    ),
  ];
  const cell = oneCellReport(events, plannedRecords(40)).cells[0]!;
  expect(cell.evidence.complete).toBe(true);
  expect(cell.evidence.execution_failure_count).toBe(0);
  expect(cell.evidence.finite_cpu_sample_count).toBe(38);
  expect(cell.evidence.cpu_complete).toBe(true);
  expect(cell.zero_failure_upper_bound).toMatchObject({ failures: 0, attempts: 40 });
  expect(cell.cpu_provenance).toEqual({ workers_invocations_adaptive: 38, none: 2 });
  // The two CPU-missing successes contribute no quantile sample.
  expect(cell.cpu_ms!.p50.sample_size).toBe(38);
});

test("a successful authoritative event without CPU fails CPU completeness, not the execution outcome", () => {
  // 29 finite CPU samples of 40 planned: below the floor. The cell reports a
  // clean execution outcome (0 failures, valid zero-failure bound) while its
  // CPU-completeness verdict is false.
  const events = [
    ...withEvents(29, { scenario_id: "byte-axis/1MiB", cpu_ms: 5 }),
    ...Array.from({ length: 11 }, (_, i) =>
      cpuMissingSuccess({ run_id: `dropped-${i}`, scenario_id: "byte-axis/1MiB" }),
    ),
  ];
  const cell = oneCellReport(events, plannedRecords(40)).cells[0]!;
  expect(cell.evidence.execution_failure_count).toBe(0);
  expect(cell.evidence.evidence_missing_count).toBe(0);
  expect(cell.evidence.complete).toBe(true);
  expect(cell.evidence.finite_cpu_sample_count).toBe(29);
  expect(cell.evidence.cpu_complete).toBe(false);
  expect(cell.zero_failure_upper_bound).toMatchObject({ failures: 0 });
});

test("a missing authoritative observability event blocks evidence completeness", () => {
  const events = [
    ...withEvents(39, { scenario_id: "byte-axis/1MiB" }),
    evidenceMissing({ run_id: "gone", scenario_id: "byte-axis/1MiB" }),
  ];
  const refusal = expectRefusal(() => oneCellReport(events, plannedRecords(40)));
  expect(refusal.field).toBe("evidence_completeness");
  expect(refusal.message).toMatch(/1 missing/);
});

test("an uncollected planned invocation (no event file at all) blocks evidence completeness", () => {
  const refusal = expectRefusal(() => oneCellReport(withEvents(39), plannedRecords(40)));
  expect(refusal.field).toBe("evidence_completeness");
  expect(refusal.message).toMatch(/1 uncollected/);
});

test("an ambiguous authoritative event blocks evidence completeness", () => {
  const events = [
    ...withEvents(39, { scenario_id: "byte-axis/1MiB" }),
    rawEvent({
      run_id: "dup",
      scenario_id: "byte-axis/1MiB",
      script_version: "unresolved",
      colo: "unknown",
      outcome: null,
      cpu_ms: null,
      evidence: {
        status: "ambiguous",
        detail: "2 join lines carry this run_id in one window",
        authority: "workers-observability",
        authoritative_outcome: null,
        authoritative_cpu_ms: null,
        authoritative_response_status: null,
        cpu_source: "none",
        cpu_outcome_verbatim: null,
      },
    }),
  ];
  const refusal = expectRefusal(() => oneCellReport(events, plannedRecords(40)));
  expect(refusal.field).toBe("evidence_completeness");
  expect(refusal.message).toMatch(/1 ambiguous/);
});

test("a top-up cannot restore completeness: extra successes never erase a missing record", () => {
  // 39 resolved successes plus one missing record, planned 40. Collecting
  // MORE successful events cannot change the missing count — the only honest
  // reading is refusal.
  const events = [
    ...withEvents(39, { scenario_id: "byte-axis/1MiB" }),
    evidenceMissing({ run_id: "gone", scenario_id: "byte-axis/1MiB" }),
  ];
  const moreEvents = [
    ...withEvents(99, { scenario_id: "byte-axis/1MiB" }),
    evidenceMissing({ run_id: "gone", scenario_id: "byte-axis/1MiB" }),
  ];
  expectRefusal(() => oneCellReport(events, plannedRecords(40)));
  const refusal = expectRefusal(() => oneCellReport(moreEvents, plannedRecords(100)));
  expect(refusal.field).toBe("evidence_completeness");
});

test("refuses a capture planned below the preregistered CPU sample floor", () => {
  // The rehearsal's passing condition: a deliberately short run refuses with
  // `field: sample_count` rather than producing an admissible-looking report.
  const refusal = expectRefusal(() => oneCellReport(withEvents(1), plannedRecords(1)));
  expect(refusal.field).toBe("sample_count");
});

test("an exceededCpu sample is an execution failure even with a partial CPU value", () => {
  const events = [
    ...withEvents(39, { scenario_id: "byte-axis/1MiB", cpu_ms: 5 }),
    rawEvent({
      run_id: "killed",
      scenario_id: "byte-axis/1MiB",
      outcome: "exceededCpu",
      cpu_ms: 99,
      evidence: {
        status: "resolved",
        detail: null,
        authority: "workers-observability",
        authoritative_outcome: "exceededCpu",
        authoritative_cpu_ms: 99,
        authoritative_response_status: null,
        cpu_source: "workers-invocations-adaptive",
        cpu_outcome_verbatim: "exceededCpu",
      },
    }),
  ];
  const cell = oneCellReport(events, plannedRecords(40)).cells[0]!;
  expect(cell.evidence.execution_failure_count).toBe(1);
  expect(cell.evidence.complete).toBe(true);
  expect(cell.zero_failure_upper_bound).toMatchObject({
    invalid: "failures-present",
    failure_count: 1,
  });
  expect(cell.failure_upper_bound.failures).toBe(1);
  expect(cell.failure_upper_bound.upper).toBeGreaterThan(0);
  // The censored value never enters the resolved quantiles.
  expect(cell.cpu_ms!.p50.value).toBe(5);
  expect(cell.cpu_ms!.p50.sample_size).toBe(39);
  expect(cell.exceeded_cpu_ms!.p50.value).toBe(99);
});

test("a cell where every invocation exceeded CPU reports outcomes, not quantiles", () => {
  const events = Array.from({ length: 30 }, (_, i) =>
    rawEvent({
      run_id: `run-${i}`,
      scenario_id: "byte-axis/1MiB",
      outcome: "exceededCpu",
      cpu_ms: 15,
      evidence: {
        status: "resolved",
        detail: null,
        authority: "workers-observability",
        authoritative_outcome: "exceededCpu",
        authoritative_cpu_ms: 15,
        authoritative_response_status: null,
        cpu_source: "workers-invocations-adaptive",
        cpu_outcome_verbatim: "exceededCpu",
      },
    }),
  );
  const cell = oneCellReport(events, plannedRecords(30)).cells[0]!;
  expect(cell.cpu_ms).toBeNull();
  expect(cell.outcomes["exceededCpu"]).toBe(30);
  expect(cell.exceeded_cpu_ms).not.toBeNull();
  expect(cell.exceeded_cpu_ms!.p50.value).toBe(15);
  // Past-the-wall is an expected state, not a refusal: evidence is complete,
  // the CPU floor simply cannot be met by dead invocations.
  expect(cell.evidence.complete).toBe(true);
  expect(cell.evidence.cpu_complete).toBe(false);
});

test("refuses a cell whose RESOLVED events disagree on script_version", () => {
  const events = [
    rawEvent({ run_id: "run-0", scenario_id: "byte-axis/1MiB", script_version: "v2" }),
    ...withEvents(30, { scenario_id: "byte-axis/1MiB", script_version: "v1" }),
  ];
  const refusal = expectRefusal(() => oneCellReport(events, plannedRecords(31)));
  expect(refusal.field).toBe("script_version");
});

test("an evidence-missing sample is not mistaken for a mid-run redeploy", () => {
  // Regression, 2026-08-24 rehearsal: the sentinel script_version of an
  // unresolved record must never masquerade as the cell's deployment
  // metadata — but under v2 the refusal that follows is
  // `evidence_completeness`, not `script_version`.
  const events = [
    evidenceMissing({ run_id: "gone", scenario_id: "byte-axis/1MiB" }),
    ...withEvents(30, { scenario_id: "byte-axis/1MiB", script_version: "v1" }),
  ];
  const refusal = expectRefusal(() => oneCellReport(events, plannedRecords(31)));
  expect(refusal.field).toBe("evidence_completeness");
});

test("assessWorkloadCeilingCellEvidence reports counts without refusing", () => {
  // The assessment behind the refusal is independently observable, so a
  // blocked capture's counts can be read without producing a report.
  const assessment = assessWorkloadCeilingCellEvidence(
    [...withEvents(2), cpuMissingSuccess({ run_id: "d1" }), evidenceMissing({ run_id: "gone" })],
    4,
    WORKLOAD_CEILING_STUDY.capture.cpu_sample_floor_per_cell,
  );
  expect(assessment).toMatchObject({
    planned_count: 4,
    collected_event_count: 4,
    authoritative_event_count: 3,
    execution_failure_count: 0,
    evidence_missing_count: 1,
    evidence_ambiguous_count: 0,
    finite_cpu_sample_count: 2,
    complete: false,
    cpu_complete: false,
  });
});

test("source and field provenance survive aggregation", () => {
  // Verbatim authoritative outcome literals and per-source CPU counts roll
  // up into the cell summary next to the canonical histogram.
  const events = [
    ...withEvents(29, {
      scenario_id: "byte-axis/1MiB",
      cpu_ms: 5,
      evidence: {
        status: "resolved",
        detail: null,
        authority: "workers-observability",
        authoritative_outcome: "ok",
        authoritative_cpu_ms: 5,
        authoritative_response_status: 200,
        cpu_source: "workers-invocations-adaptive",
        cpu_outcome_verbatim: "success",
      },
    }),
    rawEvent({
      run_id: "killed",
      scenario_id: "byte-axis/1MiB",
      outcome: "exceededCpu",
      cpu_ms: 99,
      evidence: {
        status: "resolved",
        detail: null,
        authority: "workers-observability",
        authoritative_outcome: "exceededCpu",
        authoritative_cpu_ms: 99,
        authoritative_response_status: null,
        cpu_source: "none",
        cpu_outcome_verbatim: null,
      },
    }),
  ];
  const cell = oneCellReport(events, plannedRecords(30)).cells[0]!;
  expect(cell.outcomes).toEqual({ success: 29, exceededCpu: 1 });
  expect(cell.outcome_verbatim).toEqual({ ok: 29, exceededCpu: 1 });
  expect(cell.cpu_provenance).toEqual({ workers_invocations_adaptive: 29, none: 1 });
});

test("hash cost is hashed minus unhashed, stratified by cell", () => {
  const controlEvents = withEvents(30, {
    scenario_id: "byte-axis/1MiB",
    cpu_ms: 12,
  });
  const unhashedEvents = withEvents(30, {
    scenario_id: "byte-axis/1MiB",
    cpu_ms: 10,
  });

  const report = buildWorkloadCeilingAxisReport({
    sweepId: "test-sweep",
    axis: "byte",
    cells: [
      testCell({
        scenario_id: "byte-axis/1MiB",
        target_bytes: 1_048_576,
        achieved_bytes: 1_048_576,
        row_count: 1000,
      }),
    ],
    plannedInvocations: [
      ...plannedRecords(30, "byte-axis/1MiB", "monolithic-control"),
      ...plannedRecords(30, "byte-axis/1MiB", "monolithic-control-unhashed"),
    ],
    eventsByArm: new Map([
      ["monolithic-control", controlEvents],
      ["monolithic-control-unhashed", unhashedEvents],
    ]),
  });

  expect(report.hash_cost).toHaveLength(1);
  expect(report.hash_cost[0]!.scenario_id).toBe("byte-axis/1MiB");
  expect(report.hash_cost[0]!.difference_ms).toHaveLength(30);
  // Hashed (12) - Unhashed (10) = 2
  expect(report.hash_cost[0]!.difference_ms[0]!.candidate).toBe(12);
  expect(report.hash_cost[0]!.difference_ms[0]!.baseline).toBe(10);
});

test("a dropped CPU row removes its own ordinal instead of shifting every later pair", () => {
  // The contract preregisters ~15% adaptive-row drops. Filtering each arm to
  // usable samples and THEN zipping by index makes the 3rd unhashed drop pair
  // control#3 against unhashed#4, control#4 against unhashed#5, and so on —
  // every later difference computed across invocations from different passes,
  // silently.
  const period = (i: number) =>
    `2024-01-01T00:${String(i).padStart(2, "0")}:00Z/2024-01-01T00:${String(i + 1).padStart(2, "0")}:00Z`;
  const controlEvents = Array.from({ length: 30 }, (_, i) =>
    rawEvent({ run_id: `c-${i}`, runtime_period: period(i), cpu_ms: 100 + i }),
  );
  const unhashedEvents = Array.from({ length: 30 }, (_, i) =>
    i === 2
      ? cpuMissingSuccess({ run_id: `u-${i}`, runtime_period: period(i) })
      : rawEvent({ run_id: `u-${i}`, runtime_period: period(i), cpu_ms: i }),
  );

  const report = buildWorkloadCeilingAxisReport({
    sweepId: "test-sweep",
    axis: "byte",
    cells: [
      testCell({
        scenario_id: "byte-axis/1MiB",
        target_bytes: 1_048_576,
        achieved_bytes: 1_048_576,
        row_count: 1000,
      }),
    ],
    plannedInvocations: [
      ...plannedRecords(30, "byte-axis/1MiB", "monolithic-control"),
      ...plannedRecords(30, "byte-axis/1MiB", "monolithic-control-unhashed"),
    ],
    eventsByArm: new Map([
      ["monolithic-control", controlEvents],
      ["monolithic-control-unhashed", unhashedEvents],
    ]),
  });

  const pairs = report.hash_cost[0]!.difference_ms;
  expect(pairs).toHaveLength(29);
  // Ordinal 2 is absent, and every surviving pair still holds one ordinal:
  // control 100 + k against unhashed k.
  expect(pairs.map((p) => p.pair_id)).not.toContain("byte-axis/1MiB#2");
  expect(pairs.map((p) => p.pair_id)).toEqual(
    [...Array(30).keys()].filter((k) => k !== 2).map((k) => `byte-axis/1MiB#${String(k)}`),
  );
  for (const pair of pairs) {
    expect(pair.candidate - pair.baseline).toBe(100);
  }
});

test("hash cost pairs by telemetry minute, not by the order events were read", () => {
  // `readEventsFromDirectory` returns readdir order and `observed_at` is the
  // collector's clock, so neither orders the invocations. Shuffling one arm's
  // files must not change which repetitions are paired.
  const period = (i: number) =>
    `2024-01-01T00:${String(i).padStart(2, "0")}:00Z/2024-01-01T00:${String(i + 1).padStart(2, "0")}:00Z`;
  const controlEvents = Array.from({ length: 30 }, (_, i) =>
    rawEvent({ run_id: `c-${i}`, runtime_period: period(i), cpu_ms: 100 + i }),
  );
  const unhashedEvents = Array.from({ length: 30 }, (_, i) =>
    rawEvent({ run_id: `u-${i}`, runtime_period: period(i), cpu_ms: i }),
  );

  const build = (unhashed: readonly WorkloadCeilingRawEvent[]) =>
    buildWorkloadCeilingAxisReport({
      sweepId: "test-sweep",
      axis: "byte",
      cells: [
        testCell({
          scenario_id: "byte-axis/1MiB",
          target_bytes: 1_048_576,
          achieved_bytes: 1_048_576,
          row_count: 1000,
        }),
      ],
      plannedInvocations: [
        ...plannedRecords(30, "byte-axis/1MiB", "monolithic-control"),
        ...plannedRecords(30, "byte-axis/1MiB", "monolithic-control-unhashed"),
      ],
      eventsByArm: new Map([
        ["monolithic-control", controlEvents],
        ["monolithic-control-unhashed", unhashed],
      ]),
    }).hash_cost[0]!.difference_ms;

  expect(build(unhashedEvents.toReversed())).toEqual(build(unhashedEvents));
});

test("an arm the journal planned but nothing collected refuses, rather than being skipped", () => {
  // The loop used to iterate the collected arms only, so an arm whose event
  // directory never appeared — collect-batch crashed, or the CLI ENOENT'd it —
  // was never visited and its wholly-uncollected cells never reached the
  // completeness refusal. A sweep missing an entire captured arm produced a
  // clean-looking report over the arms that survived.
  const refusal = expectRefusal(() =>
    buildWorkloadCeilingAxisReport({
      sweepId: "test-sweep",
      axis: "byte",
      cells: [
        testCell({
          scenario_id: "byte-axis/1MiB",
          target_bytes: 1_048_576,
          achieved_bytes: 1_048_576,
          row_count: 1000,
        }),
      ],
      plannedInvocations: [
        ...plannedRecords(30, "byte-axis/1MiB", "monolithic-control"),
        ...plannedRecords(30, "byte-axis/1MiB", "chunked-candidate"),
      ],
      eventsByArm: new Map([["monolithic-control", withEvents(30)]]),
    }),
  );
  expect(refusal.field).toBe("evidence_completeness");
  expect(refusal.message).toContain("chunked-candidate");
});

test("hash cost is omitted for a cell missing an arm, never imputed", () => {
  const report = oneCellReport(withEvents(30), plannedRecords(30));
  expect(report.hash_cost).toHaveLength(0);
});

test("the slope fit reports its condition estimate and needs two resolved cells", () => {
  // One resolved cell → unavailable
  const oneCellReportResult = oneCellReport(withEvents(30), plannedRecords(30));
  expect(oneCellReportResult.cpu_per_mib).toMatchObject({
    unavailable: expect.any(String),
  });

  // Four resolved cells → fit with condition estimate
  const fourCellReport = buildWorkloadCeilingAxisReport({
    sweepId: "test-sweep",
    axis: "byte",
    cells: [
      testCell({
        scenario_id: "byte-axis/512KiB",
        target_bytes: 524_288,
        achieved_bytes: 524_288,
        row_count: 500,
      }),
      testCell({
        scenario_id: "byte-axis/1MiB",
        target_bytes: 1_048_576,
        achieved_bytes: 1_048_576,
        row_count: 1000,
      }),
      testCell({
        scenario_id: "byte-axis/2MiB",
        target_bytes: 2_097_152,
        achieved_bytes: 2_097_152,
        row_count: 2000,
      }),
      testCell({
        scenario_id: "byte-axis/4MiB",
        target_bytes: 4_194_304,
        achieved_bytes: 4_194_304,
        row_count: 4000,
      }),
    ],
    plannedInvocations: [
      ...plannedRecords(30, "byte-axis/512KiB"),
      ...plannedRecords(30, "byte-axis/1MiB"),
      ...plannedRecords(30, "byte-axis/2MiB"),
      ...plannedRecords(30, "byte-axis/4MiB"),
    ],
    eventsByArm: new Map([
      [
        "monolithic-control",
        [
          ...withEvents(30, { scenario_id: "byte-axis/512KiB", cpu_ms: 5 }),
          ...withEvents(30, { scenario_id: "byte-axis/1MiB", cpu_ms: 10 }),
          ...withEvents(30, { scenario_id: "byte-axis/2MiB", cpu_ms: 20 }),
          ...withEvents(30, { scenario_id: "byte-axis/4MiB", cpu_ms: 40 }),
        ],
      ],
    ]),
  });

  const fit = fourCellReport.cpu_per_mib;
  if (!("unavailable" in fit)) {
    expect(fit.algorithm).toBe("ols-qr-v1");
    expect(fit.intercept_present).toBe(true);
    expect(fit.condition_estimate).toBeLessThan(100);
  }
});

test("quantiles are additionally reported per thermal class", () => {
  const events = [
    ...withEvents(10, { scenario_id: "byte-axis/1MiB", thermal_class: "cold", cpu_ms: 5 }),
    ...withEvents(10, { scenario_id: "byte-axis/1MiB", thermal_class: "warm", cpu_ms: 15 }),
    ...withEvents(10, { scenario_id: "byte-axis/1MiB", thermal_class: "unknown", cpu_ms: 10 }),
  ];
  const cell = oneCellReport(events, plannedRecords(30)).cells[0]!;
  expect(cell.cpu_ms_by_thermal.cold).toBeDefined();
  expect(cell.cpu_ms_by_thermal.warm).toBeDefined();
  expect(cell.cpu_ms_by_thermal.unknown).toBeDefined();
  expect(cell.cpu_ms_by_thermal.cold!.value).toBeCloseTo(5, 0);
  expect(cell.cpu_ms_by_thermal.warm!.value).toBeCloseTo(15, 0);
});

test("thermal distribution is reported correctly", () => {
  const events = [
    ...withEvents(10, { scenario_id: "byte-axis/1MiB", thermal_class: "cold" }),
    ...withEvents(15, { scenario_id: "byte-axis/1MiB", thermal_class: "warm" }),
    ...withEvents(5, { scenario_id: "byte-axis/1MiB", thermal_class: "unknown" }),
  ];
  const cell = oneCellReport(events, plannedRecords(30)).cells[0]!;
  expect(cell.thermal.cold).toBe(10);
  expect(cell.thermal.warm).toBe(15);
  expect(cell.thermal.unknown).toBe(5);
});
