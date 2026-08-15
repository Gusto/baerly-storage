import { describe, expect, test } from "vitest";
import {
  satisfiesWorkloadCeilingAdmission,
  type WorkloadCeilingStudyEvidence,
  WORKLOAD_CEILING_STUDY,
} from "./workload-ceiling-contract.ts";

describe("workload-ceiling study contract", () => {
  test("contains finite workload and admission axes", () => {
    expect(WORKLOAD_CEILING_STUDY.id).toBe("baerly.workload-ceiling/chunked-snapshot/v1");
    expect(WORKLOAD_CEILING_STUDY.collection_bytes.length).toBeGreaterThan(1);
    expect(WORKLOAD_CEILING_STUDY.collection_rows.length).toBeGreaterThan(1);
    expect(WORKLOAD_CEILING_STUDY.document_bytes.length).toBeGreaterThan(1);
    expect(WORKLOAD_CEILING_STUDY.mutation_localities).toEqual(["hot-key", "uniform"]);
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

  test("admits only complete deployed Workers evidence", () => {
    const deployedEvidence: WorkloadCeilingStudyEvidence = {
      source: "deployed-workers",
      profile: "cf-free",
      has_zero_failures_upper_bound: true,
      statistics: ["p50", "p95", "p99"],
      has_repeated_tail_drain: true,
    };

    expect(satisfiesWorkloadCeilingAdmission(deployedEvidence)).toBe(true);
    expect(satisfiesWorkloadCeilingAdmission({ ...deployedEvidence, source: "node" })).toBe(false);
    expect(satisfiesWorkloadCeilingAdmission({ ...deployedEvidence, source: "miniflare" })).toBe(
      false,
    );
    expect(
      satisfiesWorkloadCeilingAdmission({
        ...deployedEvidence,
        statistics: ["p50", "p95"],
      }),
    ).toBe(false);
    expect(satisfiesWorkloadCeilingAdmission({ ...deployedEvidence, profile: "cf-paid" })).toBe(
      false,
    );
    expect(satisfiesWorkloadCeilingAdmission({ ...deployedEvidence, profile: "node" })).toBe(false);
    expect(
      satisfiesWorkloadCeilingAdmission({
        ...deployedEvidence,
        has_zero_failures_upper_bound: false,
      }),
    ).toBe(false);
    expect(
      satisfiesWorkloadCeilingAdmission({
        ...deployedEvidence,
        has_repeated_tail_drain: false,
      }),
    ).toBe(false);
  });
});
