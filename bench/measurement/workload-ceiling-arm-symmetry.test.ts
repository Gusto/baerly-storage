import { describe, expect, test } from "vitest";
import {
  ARM_SYMMETRY_MEASURE_ITERATIONS,
  ARM_SYMMETRY_POLICY,
  ARM_SYMMETRY_WARMUP_ITERATIONS,
  WORKERD_CONVERSION_PROVENANCE,
  buildArmSymmetryRecord,
  buildRowsFromTrials,
  deriveArmSymmetryFindings,
  renderArmSymmetryTables,
  runArmSymmetryCell,
  type ArmSymmetryTrial,
} from "./workload-ceiling-arm-symmetry.ts";

const trial = (over: Partial<ArmSymmetryTrial> = {}): ArmSymmetryTrial => ({
  iteration: 0,
  seed: 1,
  hash_ms: 1,
  decode_ms: 2,
  canonical_reencode_ms: 0,
  read_total_ms: 4,
  fold_ms: 10,
  invocation_ms: 14,
  fold_entries: 20,
  ...over,
});

describe("arm-symmetry report", () => {
  test("derives paired read, fold, net, and explicitly converted workerd deltas", () => {
    const [control, candidate] = buildRowsFromTrials({
      cell: "4MiB",
      locality: "append",
      actualSnapshotBytes: 4 * 1024 * 1024,
      chunkFanout: 32,
      workerdFactor: 8.91,
      control: [trial(), trial({ iteration: 1, read_total_ms: 6, invocation_ms: 16 })],
      candidate: [
        trial({ canonical_reencode_ms: 5, read_total_ms: 8, fold_ms: 4, invocation_ms: 12 }),
        trial({
          iteration: 1,
          canonical_reencode_ms: 7,
          read_total_ms: 10,
          fold_ms: 6,
          invocation_ms: 16,
        }),
      ],
    });

    expect(control.net_vs_control_node.median_ms).toBe(0);
    expect(control.canonical_reencode_artifacts).toBe(0);
    expect(candidate.canonical_reencode_artifacts).toBe(33);
    expect(candidate.read_delta_vs_control.median_ms).toBe(4);
    expect(candidate.fold_delta_vs_control.median_ms).toBe(-5);
    expect(candidate.net_vs_control_node.median_ms).toBe(-1);
    expect(candidate.net_vs_control_workerd_converted.median_ms).toBeCloseTo(-8.91);
    expect(candidate.workerd_conversion_factor).toBe(8.91);
  });

  test("renders one table per locality and labels conversion provenance", () => {
    const makeRows = (locality: "uniform" | "append") =>
      buildRowsFromTrials({
        cell: "512KiB",
        locality,
        actualSnapshotBytes: 512 * 1024,
        chunkFanout: 4,
        workerdFactor: 6.89,
        control: [trial()],
        candidate: [trial({ canonical_reencode_ms: 3 })],
      });
    const table = renderArmSymmetryTables([...makeRows("uniform"), ...makeRows("append")]);
    expect(table).toContain("locality: uniform");
    expect(table).toContain("locality: append");
    expect(table).toContain("canonical re-encode");
    expect(table).toContain("CONVERTED, inherited/unverified");
    expect(table).toContain("negative is candidate CPU saved");
  });

  test("record pins the method and refuses to choose an admission margin", () => {
    const record = buildArmSymmetryRecord({ rows: [], subject_commit: "abc" });
    expect(record.policy).toBe(ARM_SYMMETRY_POLICY);
    expect(record.measure_iterations).toBe(ARM_SYMMETRY_MEASURE_ITERATIONS);
    expect(record.warmup_iterations).toBe(ARM_SYMMETRY_WARMUP_ITERATIONS);
    expect(record.median_algorithm).toBe("quantile-r7-v1");
    expect(record.read_component_method).toBe("standalone-production-primitives");
    expect(record.read_total_method).toBe("production-read-path");
    expect(record.workerd_conversion.status).toBe("inherited-unverified");
    expect(record.workerd_conversion.warning).toContain("not measurements");
    expect(deriveArmSymmetryFindings().some((finding) => finding.startsWith("No verdict"))).toBe(
      true,
    );
    expect(deriveArmSymmetryFindings().join("\n")).toContain("20-mutation pass");
    expect(deriveArmSymmetryFindings().join("\n")).toContain("actual K");
    expect(deriveArmSymmetryFindings().join("\n")).toContain("not additive");
  });

  test("runs both production read paths and fold computations on a small fixture", async () => {
    const [control, candidate] = await runArmSymmetryCell({
      cell: "test",
      rows: 16,
      documentBytes: 64,
      locality: "append",
      workerdFactor: 2,
      warmupIterations: 0,
      measureIterations: 1,
    });
    expect(control.trials).toHaveLength(1);
    expect(candidate.trials).toHaveLength(1);
    expect(control.fold_entries_median).toBe(20);
    expect(candidate.fold_entries_median).toBeGreaterThan(0);
    expect(candidate.chunk_fanout).toBe(1);
    expect(candidate.objects_read).toBe(2);
    expect(candidate.canonical_reencode_artifacts).toBe(2);
    expect(control.invocation.median_ms).toBeGreaterThanOrEqual(0);
    expect(candidate.invocation.median_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("workerd conversion provenance", () => {
  test("carries one inherited factor for every study cell", () => {
    expect(WORKERD_CONVERSION_PROVENANCE.factors_by_cell).toEqual({
      "0.5MiB": 6.89,
      "1MiB": 8.55,
      "2MiB": 9.57,
      "4MiB": 8.91,
    });
  });
});
