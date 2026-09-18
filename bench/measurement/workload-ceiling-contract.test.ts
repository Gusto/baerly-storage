import { describe, expect, test } from "vitest";
import {
  clearsCpuBudgetLine,
  satisfiesWorkloadCeilingAdmission,
  satisfiesWorkloadCeilingCpuBudget,
  satisfiesWorkloadCeilingEvidenceRequirements,
  type WorkloadCeilingAdmissionMargins,
  type WorkloadCeilingStudyEvidence,
  WORKLOAD_CEILING_STUDY,
} from "./workload-ceiling-contract.ts";
import { WILSON_Z_BY_CONFIDENCE } from "./statistics.ts";

describe("workload-ceiling study contract", () => {
  test("contains finite workload and admission axes", () => {
    expect(WORKLOAD_CEILING_STUDY.id).toBe("baerly.workload-ceiling/chunked-snapshot/v1");
    expect(WORKLOAD_CEILING_STUDY.collection_bytes.length).toBeGreaterThan(1);
    expect(WORKLOAD_CEILING_STUDY.collection_rows.length).toBeGreaterThan(1);
    expect(WORKLOAD_CEILING_STUDY.document_bytes.length).toBeGreaterThan(1);
    expect(WORKLOAD_CEILING_STUDY.mutation_localities).toEqual([
      "append-ordered",
      "hot-key",
      "uniform",
    ]);
    expect(WORKLOAD_CEILING_STUDY.read_shapes).toEqual([
      "point",
      "bounded-range",
      "index-routed",
      "complete",
    ]);
    expect(WORKLOAD_CEILING_STUDY.admission.requires_deployed_workers).toBe(true);
    expect(WORKLOAD_CEILING_STUDY.axis_sweeps.byte_axis).toEqual({
      document_bytes: 2048,
      collection_bytes_measure: "encoded-snapshot-bytes",
    });
    expect(WORKLOAD_CEILING_STUDY.axis_sweeps.row_axis).toEqual({
      document_bytes: 256,
      collection_rows_measure: "rows",
    });
  });

  test("uses unique positive ascending numeric cells", () => {
    for (const cells of [
      WORKLOAD_CEILING_STUDY.collection_bytes,
      WORKLOAD_CEILING_STUDY.collection_rows,
      WORKLOAD_CEILING_STUDY.document_bytes,
      WORKLOAD_CEILING_STUDY.manifest_descriptors,
    ]) {
      expect(cells.every((value) => Number.isSafeInteger(value) && value > 0)).toBe(true);
      expect(cells).toEqual([...new Set(cells)].toSorted((a, b) => a - b));
    }
  });

  test("keeps cross-field cells within the preregistered envelope", () => {
    expect(WORKLOAD_CEILING_STUDY.changed_byte_fractions.length).toBeGreaterThan(0);
    expect(
      WORKLOAD_CEILING_STUDY.changed_byte_fractions.every(
        (fraction) => Number.isFinite(fraction) && fraction > 0 && fraction <= 1,
      ),
    ).toBe(true);
    expect(WORKLOAD_CEILING_STUDY.changed_byte_fractions).toEqual(
      [...new Set(WORKLOAD_CEILING_STUDY.changed_byte_fractions)].toSorted((a, b) => a - b),
    );
    expect(WORKLOAD_CEILING_STUDY.mutation_mixes.length).toBeGreaterThan(0);
    expect(
      WORKLOAD_CEILING_STUDY.mutation_mixes.every(
        ({ insert, update, delete: remove }) =>
          [insert, update, remove].every(
            (weight) => Number.isFinite(weight) && weight > 0 && weight <= 1,
          ) && Math.abs(insert + update + remove - 1) <= Number.EPSILON,
      ),
    ).toBe(true);
    expect(new Set(WORKLOAD_CEILING_STUDY.mutation_mixes.map(({ id }) => id)).size).toBe(
      WORKLOAD_CEILING_STUDY.mutation_mixes.length,
    );

    const dominantOperation = {
      "insert-heavy": "insert",
      "update-heavy": "update",
      "delete-heavy": "delete",
    } as const;
    for (const mix of WORKLOAD_CEILING_STUDY.mutation_mixes) {
      const dominant = dominantOperation[mix.id as keyof typeof dominantOperation];
      expect(dominant).toBeDefined();
      const weights = { insert: mix.insert, update: mix.update, delete: mix.delete };
      const alternatives = Object.entries(weights)
        .filter(([operation]) => operation !== dominant)
        .map(([, weight]) => weight);
      expect(weights[dominant]).toBeGreaterThan(Math.max(...alternatives));
    }

    expect(WORKLOAD_CEILING_STUDY.collection_bytes).toContain(512 * 1024);
    expect(WORKLOAD_CEILING_STUDY.collection_rows).toContain(2048);
    expect(WORKLOAD_CEILING_STUDY.document_bytes).toEqual(expect.arrayContaining([1024, 5 * 1024]));
    expect(WORKLOAD_CEILING_STUDY.collection_bytes.some((bytes) => bytes > 512 * 1024)).toBe(true);
    expect(WORKLOAD_CEILING_STUDY.collection_rows.some((rows) => rows > 2048)).toBe(true);

    const { byte_axis: byteTarget, row_axis: rowTarget } =
      WORKLOAD_CEILING_STUDY.minimum_useful_targets;
    expect(byteTarget).toEqual({
      collection_bytes: 1024 * 1024,
      document_bytes: 2048,
    });
    expect(rowTarget).toEqual({
      collection_rows: 4096,
      document_bytes: 256,
    });
    expect(WORKLOAD_CEILING_STUDY.collection_bytes).toContain(byteTarget.collection_bytes);
    expect(WORKLOAD_CEILING_STUDY.document_bytes).toContain(byteTarget.document_bytes);
    expect(WORKLOAD_CEILING_STUDY.collection_rows).toContain(rowTarget.collection_rows);
    expect(WORKLOAD_CEILING_STUDY.document_bytes).toContain(rowTarget.document_bytes);

    const manifestCeiling = Math.max(...WORKLOAD_CEILING_STUDY.manifest_descriptors);
    expect(Object.keys(WORKLOAD_CEILING_STUDY.read_fan_out_limits).toSorted()).toEqual(
      [...WORKLOAD_CEILING_STUDY.read_shapes].toSorted(),
    );
    expect(
      Object.values(WORKLOAD_CEILING_STUDY.read_fan_out_limits).every(
        (limit) =>
          Number.isSafeInteger(limit) &&
          limit > 0 &&
          limit <= manifestCeiling &&
          WORKLOAD_CEILING_STUDY.manifest_descriptors.includes(limit),
      ),
    ).toBe(true);
  });

  test("bounds general index-routed reads by the descriptor ceiling", () => {
    expect(WORKLOAD_CEILING_STUDY.read_fan_out_limits).toEqual({
      point: 1,
      "bounded-range": 8,
      "index-routed": 32,
      complete: 32,
    });
  });

  const validEvidence: WorkloadCeilingStudyEvidence = {
    source: "deployed-workers",
    profile: "cf-free",
    plan: "workers-paid",
    configured_cpu_ms: 10,
    mutation_locality: "append-ordered",
    p99_cpu_ms: 4,
    has_zero_failures_upper_bound: true,
    has_complete_evidence: true,
    meets_cpu_sample_floor: true,
    statistics: ["p50", "p95", "p99"],
    has_repeated_tail_drain: true,
  };
  const decidedMargins: WorkloadCeilingAdmissionMargins = {
    append_ordered: 2,
    uniform: 2,
  };

  test("fails closed on pending margins but admits valid evidence with a decided margin", () => {
    expect(WORKLOAD_CEILING_STUDY.admission.cpu_margin_by_regime).toEqual({
      append_ordered: "pending-program-decision",
      uniform: "pending-program-decision",
    });
    expect(satisfiesWorkloadCeilingAdmission(validEvidence)).toBe(false);
    expect(satisfiesWorkloadCeilingAdmission(validEvidence, decidedMargins)).toBe(true);
  });

  test("independently rejects every invalid methodological evidence clause", () => {
    expect(satisfiesWorkloadCeilingEvidenceRequirements(validEvidence)).toBe(true);
    for (const invalidEvidence of [
      { ...validEvidence, source: null },
      { ...validEvidence, source: "node" as const },
      { ...validEvidence, source: "miniflare" as const },
      { ...validEvidence, profile: null },
      { ...validEvidence, profile: "cf-paid" as const },
      { ...validEvidence, profile: "node" as const },
      { ...validEvidence, statistics: ["p50", "p95"] as const },
      { ...validEvidence, has_zero_failures_upper_bound: false },
      { ...validEvidence, has_repeated_tail_drain: false },
      { ...validEvidence, has_complete_evidence: false },
      { ...validEvidence, meets_cpu_sample_floor: false },
    ]) {
      expect(satisfiesWorkloadCeilingEvidenceRequirements(invalidEvidence)).toBe(false);
      expect(satisfiesWorkloadCeilingAdmission(invalidEvidence, decidedMargins)).toBe(false);
    }
  });

  test("treats configured CPU and billing plan as nullable provenance", () => {
    for (const evidence of [
      { ...validEvidence, configured_cpu_ms: null },
      { ...validEvidence, configured_cpu_ms: 30_000 },
      { ...validEvidence, plan: null },
      { ...validEvidence, plan: "workers-free" as const },
    ]) {
      expect(satisfiesWorkloadCeilingEvidenceRequirements(evidence)).toBe(true);
      expect(satisfiesWorkloadCeilingAdmission(evidence, decidedMargins)).toBe(true);
    }
  });

  test("uses a tightening safety factor and the declared locality mapping", () => {
    expect(clearsCpuBudgetLine(1, 10)).toBe(true);
    expect(clearsCpuBudgetLine(0.5, 10)).toBe(false);
    expect(clearsCpuBudgetLine(2, 5)).toBe(true);
    expect(clearsCpuBudgetLine(2, 5.01)).toBe(false);
    expect(clearsCpuBudgetLine("pending-program-decision", 1)).toBe(false);
    expect(clearsCpuBudgetLine(1, null)).toBe(false);

    expect(
      satisfiesWorkloadCeilingCpuBudget(
        { ...validEvidence, mutation_locality: "hot-key", p99_cpu_ms: 5 },
        decidedMargins,
      ),
    ).toBe(true);
    expect(
      satisfiesWorkloadCeilingCpuBudget(
        { ...validEvidence, mutation_locality: "uniform", p99_cpu_ms: 5.01 },
        decidedMargins,
      ),
    ).toBe(false);
    expect(
      satisfiesWorkloadCeilingCpuBudget(
        { ...validEvidence, mutation_locality: null },
        decidedMargins,
      ),
    ).toBe(false);
  });

  test("preregisters the cf-free CPU figure as a measured-p99 budget line", () => {
    expect(WORKLOAD_CEILING_STUDY.cpu_envelope).toEqual({
      cf_free_cpu_ms: 10,
      enforcement: "elastic-duty-cycle-dependent",
      obtained_by: "measured-p99-budget-line",
    });
  });

  describe("capture protocol", () => {
    test("preregisters planned invocations above the CPU sample floor, warmup count, and global spacing", () => {
      expect(WORKLOAD_CEILING_STUDY.capture.planned_measured_invocations_per_cell).toBe(40);
      expect(WORKLOAD_CEILING_STUDY.capture.cpu_sample_floor_per_cell).toBe(30);
      expect(WORKLOAD_CEILING_STUDY.capture.warmup_invocations_per_cell).toBe(2);
      expect(WORKLOAD_CEILING_STUDY.capture.invocation_spacing_seconds).toBe(70);
    });

    test("the planned count carries a fixed telemetry-drop margin over the CPU floor", () => {
      // The 2026-08-24 rehearsal measured `workersInvocationsAdaptive`
      // permanently dropping ~4/24 rows while Workers Observability held
      // 24/24. At a 15 % drop rate, 40 planned invocations keep ≥ 30 CPU
      // samples with ≈ 98 % probability per cell-arm — the preregistered
      // replacement for the contradictory post-hoc top-up. The margin is
      // fixed here, before capture, never after observing missingness.
      const planned = WORKLOAD_CEILING_STUDY.capture.planned_measured_invocations_per_cell;
      const floor = WORKLOAD_CEILING_STUDY.capture.cpu_sample_floor_per_cell;
      expect(planned).toBeGreaterThan(floor);
      // Expected surviving CPU samples at the observed worst-case 15 % rate:
      expect(planned * 0.85).toBeGreaterThanOrEqual(floor);
    });

    test("spacing exceeds the telemetry bucket width, so two invocations never collapse", () => {
      // A minute-resolution grouping collapses only instants < 60 s apart.
      expect(WORKLOAD_CEILING_STUDY.capture.invocation_spacing_seconds).toBeGreaterThan(60);
    });

    test("the settle delay is longer than the spacing, so the last invocation is never queried early", () => {
      expect(WORKLOAD_CEILING_STUDY.capture.telemetry_settle_seconds).toBeGreaterThan(
        WORKLOAD_CEILING_STUDY.capture.invocation_spacing_seconds,
      );
    });

    test("the only exclusion is assigned before a run", () => {
      expect(WORKLOAD_CEILING_STUDY.capture.exclusion_policy).toBe("warmup-tagged-before-run-only");
    });

    test("the confidence level has a pinned Wilson z, so a failures-present cell can still be bounded", () => {
      expect(Object.keys(WILSON_Z_BY_CONFIDENCE).map(Number)).toContain(
        WORKLOAD_CEILING_STUDY.capture.confidence,
      );
    });
  });

  describe("telemetry policy", () => {
    test("splits existence/outcome authority from CPU measurement", () => {
      expect(WORKLOAD_CEILING_STUDY.capture.telemetry).toEqual({
        authority: "workers-observability",
        authority_success_outcome: "ok",
        cpu_measurement: "workers-invocations-adaptive",
        cpu_success_status: "success",
        collection_retries: 1,
        collection_retry_delay_seconds: 600,
      });
    });

    test("permits exactly one collection-only retry after a fixed delay, never a re-invocation", () => {
      const { telemetry } = WORKLOAD_CEILING_STUDY.capture;
      expect(telemetry.collection_retries).toBe(1);
      // The delay is fixed here — chosen before production capture, never
      // after observing missingness.
      expect(telemetry.collection_retry_delay_seconds).toBeGreaterThan(0);
    });

    test("records each source's verbatim success literal", () => {
      // Workers Observability reports `ok`; the GraphQL Analytics dataset
      // reports `success`. Both are pinned so a vocabulary drift on either
      // side fails this test instead of silently misclassifying successes.
      expect(WORKLOAD_CEILING_STUDY.capture.telemetry.authority_success_outcome).toBe("ok");
      expect(WORKLOAD_CEILING_STUDY.capture.telemetry.cpu_success_status).toBe("success");
    });
  });
});
