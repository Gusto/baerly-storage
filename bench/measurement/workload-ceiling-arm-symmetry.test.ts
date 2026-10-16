import { describe, expect, test } from "vitest";
import { WIN_MODEL_SEEDS } from "./workload-ceiling-win-model.ts";
import {
  ARM_SYMMETRY_FOLD_READ_MAX_CHUNKS,
  ARM_SYMMETRY_MEASURE_ITERATIONS,
  ARM_SYMMETRY_POLICY,
  ARM_SYMMETRY_WARMUP_ITERATIONS,
  WORKERD_CONVERSION_PROVENANCE,
  buildArmSymmetryRecord,
  buildRowsFromTrials,
  controlFirstAt,
  deriveArmSymmetryFindings,
  renderArmSymmetryTables,
  runArmSymmetryCell,
  type ArmSymmetryReadTrial,
  type ArmSymmetryTrial,
} from "./workload-ceiling-arm-symmetry.ts";

const read = (over: Partial<ArmSymmetryReadTrial> = {}): ArmSymmetryReadTrial => ({
  chunks_read: 0,
  objects_read: 1,
  hash_ms: 1,
  decode_ms: 2,
  canonical_reencode_ms: 0,
  read_total_ms: 4,
  ...over,
});

const trial = (over: Partial<ArmSymmetryTrial> = {}): ArmSymmetryTrial => ({
  iteration: 0,
  seed: 1,
  fold_read: read(),
  query_read: read(),
  prefetch_ms: 0,
  fold_ms: 10,
  invocation_ms: 14,
  fold_entries: 20,
  ...over,
});

const candidateRead = (chunks: number, over: Partial<ArmSymmetryReadTrial> = {}) =>
  read({ chunks_read: chunks, objects_read: chunks + 1, ...over });

describe("arm-symmetry report", () => {
  test("derives paired read, fold, and net deltas from fold-read only", () => {
    const [control, candidate] = buildRowsFromTrials({
      cell: "4MiB",
      locality: "append",
      actualSnapshotBytes: 4 * 1024 * 1024,
      totalChunks: 32,
      workerdFactor: 8.91,
      control: [
        trial(),
        trial({
          iteration: 1,
          fold_read: read({ read_total_ms: 6 }),
          query_read: read({ read_total_ms: 6 }),
          invocation_ms: 16,
        }),
      ],
      candidate: [
        trial({
          fold_read: candidateRead(3, { canonical_reencode_ms: 1, read_total_ms: 5 }),
          query_read: candidateRead(32, { canonical_reencode_ms: 5, read_total_ms: 40 }),
          prefetch_ms: 1,
          fold_ms: 4,
          invocation_ms: 10,
        }),
        trial({
          iteration: 1,
          fold_read: candidateRead(9, { canonical_reencode_ms: 2, read_total_ms: 9 }),
          query_read: candidateRead(32, { canonical_reencode_ms: 7, read_total_ms: 50 }),
          prefetch_ms: 1,
          fold_ms: 6,
          invocation_ms: 16,
        }),
      ],
    });

    expect(control.net_vs_control_node.median_ms).toBe(0);
    expect(control.total_chunks).toBe(0);
    expect(control.fold_read.canonical_reencode_artifacts.median).toBe(0);
    expect(candidate.total_chunks).toBe(32);
    expect(candidate.fold_read.read_shape).toBe("fold-read");
    expect(candidate.fold_read.chunk_fanout).toEqual({ median: 6, range: "3-9" });
    expect(candidate.fold_read.canonical_reencode_artifacts.median).toBe(7);
    expect(candidate.fold_read.read_delta_vs_control.median_ms).toBe(2);
    expect(candidate.query_read.read_shape).toBe("query-read");
    expect(candidate.query_read.chunk_fanout).toEqual({ median: 32, range: "32-32" });
    expect(candidate.query_read.canonical_reencode_artifacts.median).toBe(33);
    expect(candidate.query_read.read_delta_vs_control.median_ms).toBe(40);
    expect(candidate.fold_delta_vs_control.median_ms).toBe(-5);
    // The query-read's +40 ms must not leak into the net.
    expect(candidate.net_vs_control_node.median_ms).toBe(-2);
    expect(candidate.net_vs_control_workerd_converted.median_ms).toBeCloseTo(-17.82);
    expect(candidate.workerd_conversion_factor).toBe(8.91);
  });

  test("renders fold-read and query-read tables per locality and labels provenance", () => {
    const makeRows = (locality: "uniform" | "append") =>
      buildRowsFromTrials({
        cell: "512KiB",
        locality,
        actualSnapshotBytes: 512 * 1024,
        totalChunks: 4,
        workerdFactor: 6.89,
        control: [trial()],
        candidate: [
          trial({
            fold_read: candidateRead(2, { canonical_reencode_ms: 1 }),
            query_read: candidateRead(4, { canonical_reencode_ms: 3 }),
          }),
        ],
      });
    const table = renderArmSymmetryTables([...makeRows("uniform"), ...makeRows("append")]);
    expect(table).toContain("locality: uniform — fold-read, the net comparison (N=1");
    expect(table).toContain(
      "locality: append — query-read, complete materialise, EXCLUDED from net",
    );
    expect(table).toContain("2 [2-2] chunks (3 objects) of 4");
    expect(table).toContain("canonical re-encode");
    expect(table).toContain("CONVERTED, inherited/unverified");
    expect(table).toContain("negative is candidate CPU saved");
  });

  test("record pins the method and refuses to choose an admission margin", () => {
    const record = buildArmSymmetryRecord({
      rows: [],
      subject_commit: "abc",
      measure_iterations: 20,
    });
    expect(record.policy).toBe(ARM_SYMMETRY_POLICY);
    expect(record.measure_iterations).toBe(ARM_SYMMETRY_MEASURE_ITERATIONS);
    expect(record.warmup_iterations).toBe(ARM_SYMMETRY_WARMUP_ITERATIONS);
    expect(record.median_algorithm).toBe("quantile-r7-v1");
    expect(record.read_component_method).toBe("standalone-production-primitives");
    expect(record.read_total_method).toBe("production-read-path");
    expect(record.read_shapes).toEqual(["fold-read", "query-read"]);
    expect(record.net_read_shape).toBe("fold-read");
    expect(record.fold_read_max_chunks).toBe(9);
    expect(record.workerd_conversion.status).toBe("inherited-unverified");
    expect(record.workerd_conversion.warning).toContain("not measurements");
    expect(
      buildArmSymmetryRecord({ rows: [], subject_commit: "abc", measure_iterations: 60 }),
    ).toMatchObject({ measure_iterations: 60 });
    const findings = deriveArmSymmetryFindings();
    expect(findings.some((finding) => finding.startsWith("No verdict"))).toBe(true);
    expect(findings.join("\n")).toContain("20-mutation pass");
    expect(findings.join("\n")).toContain("actual K");
    expect(findings.join("\n")).toContain("not additive");
    expect(findings.join("\n")).toContain("excluded from the net");
    expect(findings.join("\n")).toContain("separate paired");
  });

  test("candidate fold-read fetches only the admitted prefetch set", async () => {
    // 1024 rows x 2 KiB under c128-r512 packs into more chunks than the
    // nine-chunk prefetch bound, so a complete read would be visible here.
    const [control, candidate] = await runArmSymmetryCell({
      cell: "test",
      rows: 1024,
      documentBytes: 2048,
      locality: "append",
      workerdFactor: 2,
      warmupIterations: 0,
      measureIterations: 1,
    });
    expect(control.trials).toHaveLength(1);
    expect(candidate.trials).toHaveLength(1);
    expect(control.fold_entries_median).toBe(20);
    expect(control.fold_read.objects_read.median).toBe(1);
    expect(control.query_read.objects_read.median).toBe(1);
    expect(candidate.fold_entries_median).toBeGreaterThan(0);
    expect(candidate.total_chunks).toBeGreaterThan(ARM_SYMMETRY_FOLD_READ_MAX_CHUNKS);
    const foldRead = candidate.trials[0]!.fold_read;
    expect(foldRead.chunks_read).toBeGreaterThan(0);
    expect(foldRead.chunks_read).toBeLessThanOrEqual(ARM_SYMMETRY_FOLD_READ_MAX_CHUNKS);
    expect(foldRead.objects_read).toBe(foldRead.chunks_read + 1);
    expect(candidate.trials[0]!.query_read.chunks_read).toBe(candidate.total_chunks);
    expect(candidate.query_read.objects_read.median).toBe(candidate.total_chunks + 1);
    expect(candidate.invocation.median_ms).toBeGreaterThanOrEqual(0);
  });

  test("runs both arms on a single-chunk fixture", async () => {
    const [control, candidate] = await runArmSymmetryCell({
      cell: "test",
      rows: 16,
      documentBytes: 64,
      locality: "uniform",
      workerdFactor: 2,
      warmupIterations: 0,
      measureIterations: 1,
    });
    expect(control.invocation.median_ms).toBeGreaterThanOrEqual(0);
    expect(candidate.total_chunks).toBe(1);
    expect(candidate.fold_read.chunk_fanout.median).toBe(1);
    expect(candidate.query_read.objects_read.median).toBe(2);
  });
});

describe("arm order schedule", () => {
  test("gives every seed slot both arm orders and stays balanced", () => {
    const cycle = WIN_MODEL_SEEDS.length;
    for (let slot = 0; slot < cycle; slot++) {
      expect(controlFirstAt(slot)).not.toBe(controlFirstAt(slot + cycle));
    }
    const orders = Array.from({ length: 2 * cycle }, (_, iteration) => controlFirstAt(iteration));
    expect(orders.filter(Boolean)).toHaveLength(cycle);
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
