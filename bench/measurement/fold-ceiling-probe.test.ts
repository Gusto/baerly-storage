import { describe, expect, test } from "vitest";
import {
  type FrozenBaselineCell,
  HOST_BUDGETS,
  type HostBudget,
  type ProbeCell,
  REPORTED_MARGINS,
  buildRecommendation,
  cellsOf,
  compareToFrozen,
  deriveFindings,
  isPeakSampleUsable,
  largestSustainable,
  renderTable,
  todayHeadroom,
} from "./fold-ceiling-probe.ts";

const cell = (over: Partial<ProbeCell> & Pick<ProbeCell, "axis" | "rows">): ProbeCell => ({
  label: `${over.rows}`,
  bytes_per_doc: 2048,
  snapshot_bytes: over.rows * 2048,
  tail_entries: 100,
  iterations: 11,
  cpu_ms_median: 1,
  peak_bytes_median: 1_000_000,
  peak_over_snapshot: 1,
  peak_samples_discarded: 0,
  ...over,
});

const budget = (over: Partial<HostBudget> = {}): HostBudget => ({
  profile: "cf-free",
  cpu_ms: 10,
  memory_bytes: 128 * 1024 * 1024,
  source: "test",
  ...over,
});

/**
 * `todayHeadroom` requires BOTH axes, so any fixture that reaches
 * `buildRecommendation` must carry a rows cell as well as a bytes cell.
 */
const bothAxes: readonly ProbeCell[] = [
  cell({ axis: "bytes", rows: 256, snapshot_bytes: 532_300 }),
  cell({ axis: "rows", rows: 2048, bytes_per_doc: 64, snapshot_bytes: 232_287 }),
];

describe("largestSustainable", () => {
  test("picks the largest cell that fits CPU at the given margin", () => {
    const cells = [
      cell({ axis: "bytes", rows: 256, cpu_ms_median: 1 }),
      cell({ axis: "bytes", rows: 512, cpu_ms_median: 2 }),
      cell({ axis: "bytes", rows: 1024, cpu_ms_median: 6 }),
    ];
    // margin 2 → need cpu*2 <= 10 → 1,2 fit (2,4); 6 does not (12).
    const verdict = largestSustainable({ cells, budget: budget(), margin: 2 });
    expect(verdict.max_c_bytes).toBe(512 * 2048);
    expect(verdict.binding_axis).toBe("cpu");
  });

  test("memory can bind before CPU", () => {
    const cells = [
      cell({ axis: "bytes", rows: 256, cpu_ms_median: 0.1, peak_bytes_median: 10_000_000 }),
      cell({ axis: "bytes", rows: 512, cpu_ms_median: 0.2, peak_bytes_median: 90_000_000 }),
    ];
    const verdict = largestSustainable({
      cells,
      budget: budget({ profile: "cf-paid", cpu_ms: 30_000 }),
      margin: 2,
    });
    expect(verdict.max_c_bytes).toBe(256 * 2048);
    expect(verdict.binding_axis).toBe("memory");
  });

  test("reports grid-exhausted when even the largest measured cell fits", () => {
    const cells = [cell({ axis: "bytes", rows: 256, cpu_ms_median: 0.1 })];
    const verdict = largestSustainable({
      cells,
      budget: budget({ profile: "cf-paid", cpu_ms: 30_000 }),
      margin: 2,
    });
    expect(verdict.binding_axis).toBe("grid-exhausted");
  });

  test("reports none when not even the smallest cell fits", () => {
    const cells = [cell({ axis: "bytes", rows: 256, cpu_ms_median: 100 })];
    const verdict = largestSustainable({ cells, budget: budget(), margin: 2 });
    expect(verdict.max_c_bytes).toBeNull();
    expect(verdict.binding_axis).toBe("none");
  });

  test("the rows axis is read from rows-axis and cross cells, never bytes-axis", () => {
    const cells = [
      cell({ axis: "bytes", rows: 100_000, cpu_ms_median: 0.1 }),
      cell({ axis: "rows", rows: 4096, bytes_per_doc: 64, cpu_ms_median: 0.1 }),
      cell({ axis: "cross", rows: 8192, bytes_per_doc: 512, cpu_ms_median: 0.1 }),
    ];
    const verdict = largestSustainable({
      cells,
      budget: budget({ profile: "cf-paid", cpu_ms: 30_000 }),
      margin: 2,
    });
    expect(verdict.max_e_rows).toBe(8192);
    expect(verdict.max_c_bytes).toBe(100_000 * 2048);
  });

  test("expresses the verdict as a multiple of today's shipped ceilings", () => {
    const cells = [cell({ axis: "rows", rows: 8192, bytes_per_doc: 64, cpu_ms_median: 0.1 })];
    const verdict = largestSustainable({
      cells,
      budget: budget({ profile: "cf-paid", cpu_ms: 30_000 }),
      margin: 2,
    });
    expect(verdict.e_multiple_of_today).toBe(4); // 8192 / 2048
  });
});

describe("todayHeadroom", () => {
  test("reports the measured margin at today's C and E", () => {
    const cells = [
      // C today = 512 KiB. Nearest bytes-axis cell at or below it.
      cell({ axis: "bytes", rows: 256, snapshot_bytes: 532_300, cpu_ms_median: 1.43 }),
      // E today = 2048 rows.
      cell({
        axis: "rows",
        rows: 2048,
        bytes_per_doc: 64,
        snapshot_bytes: 232_287,
        cpu_ms_median: 1.38,
      }),
    ];
    const head = todayHeadroom({ cells, budget: budget() });
    expect(head.at_c_cpu_ms).toBe(1.43);
    expect(head.at_e_cpu_ms).toBe(1.38);
    expect(head.cpu_margin_at_c).toBeCloseTo(10 / 1.43, 5);
  });

  test("throws rather than guessing when an axis is missing entirely", () => {
    expect(() =>
      todayHeadroom({ cells: [cell({ axis: "bytes", rows: 256 })], budget: budget() }),
    ).toThrow(/both the bytes and rows axes/);
  });
});

describe("isPeakSampleUsable", () => {
  /**
   * The first run of this grid reported a 0.03 MB peak for a 16.24 MB fold —
   * `peakBytes` is `max(sample) - heapUsedAtStart`, so a `heapStart` captured at
   * a pre-GC high-water mark floors the whole fold. That cell then passed the
   * memory test and set `cf-paid maxC` outright. A peak below the snapshot size
   * is physically impossible for a rebuild that must hold the snapshot resident.
   */
  test("rejects a peak below the snapshot size as GC-floored", () => {
    expect(isPeakSampleUsable(30_000, 16_240_000)).toBe(false);
  });

  test("accepts a peak at or above the snapshot size", () => {
    expect(isPeakSampleUsable(16_240_000, 16_240_000)).toBe(true);
    expect(isPeakSampleUsable(35_000_000, 16_240_000)).toBe(true);
  });
});

describe("deriveFindings", () => {
  test("names a knee when cost per MB climbs, and quotes the bracketing cells", () => {
    const cells = [
      ...bothAxes,
      cell({ axis: "bytes", rows: 1024, snapshot_bytes: 2 * 1024 * 1024, cpu_ms_median: 4 }),
      cell({ axis: "bytes", rows: 2048, snapshot_bytes: 4 * 1024 * 1024, cpu_ms_median: 40 }),
    ];
    const knee = deriveFindings(cells).find((f) => f.startsWith("bytes axis:"));
    expect(knee).toContain("knee is REAL");
    expect(knee).toContain("4.00 MB");
  });

  test("says so plainly when there is no knee", () => {
    const cells = [
      ...bothAxes,
      cell({ axis: "bytes", rows: 1024, snapshot_bytes: 2 * 1024 * 1024, cpu_ms_median: 2 }),
      cell({ axis: "bytes", rows: 2048, snapshot_bytes: 4 * 1024 * 1024, cpu_ms_median: 4 }),
    ];
    expect(deriveFindings(cells).find((f) => f.startsWith("bytes axis:"))).toContain(
      "no cost-per-MB knee",
    );
  });

  test("marks a paid ceiling as a LOWER BOUND when the grid ran out first", () => {
    const cheap = [
      cell({ axis: "bytes", rows: 256, snapshot_bytes: 532_300, cpu_ms_median: 0.1 }),
      cell({
        axis: "rows",
        rows: 2048,
        bytes_per_doc: 64,
        snapshot_bytes: 232_287,
        cpu_ms_median: 0.1,
      }),
    ];
    expect(
      deriveFindings(cheap)
        .filter((f) => f.includes("cf-paid @"))
        .join("\n"),
    ).toContain("LOWER BOUND (grid exhausted)");
  });

  test("compares every cross cell against its nearest bytes-axis peer", () => {
    const cells = [
      ...bothAxes,
      cell({ axis: "bytes", rows: 2048, snapshot_bytes: 4 * 1024 * 1024, cpu_ms_median: 30 }),
      cell({
        axis: "cross",
        label: "4k x 1KB",
        rows: 4096,
        bytes_per_doc: 1024,
        snapshot_bytes: 4 * 1024 * 1024,
        cpu_ms_median: 15,
      }),
    ];
    const crossFinding = deriveFindings(cells).find((f) => f.startsWith("cross 4k x 1KB"));
    expect(crossFinding).toContain("0.50x"); // 15 / 30
  });

  test("reports how many cells lost GC-floored peak samples", () => {
    const cells = [...bothAxes, cell({ axis: "bytes", rows: 999, peak_samples_discarded: 4 })];
    expect(deriveFindings(cells).find((f) => f.startsWith("peak-sample hygiene"))).toContain(
      "worst cell dropped 4",
    );
  });

  test("every finding lands in the record it describes", () => {
    const rec = buildRecommendation({ cells: bothAxes, subject_commit: "deadbeef" });
    expect(rec.findings).toEqual(deriveFindings(bothAxes));
    expect(rec.findings.length).toBeGreaterThan(0);
  });

  test("runner-supplied findings are appended, not substituted", () => {
    const rec = buildRecommendation({
      cells: bothAxes,
      subject_commit: "deadbeef",
      extraFindings: ["overlap check: ok"],
    });
    expect(rec.findings.at(-1)).toBe("overlap check: ok");
    expect(rec.findings.length).toBe(deriveFindings(bothAxes).length + 1);
  });
});

describe("cellsOf", () => {
  test("returns the cells array when the document carries one", () => {
    expect(cellsOf<number>({ cells: [1, 2] }, "f.json")).toEqual([1, 2]);
    expect(cellsOf<number>({ cells: [] }, "f.json")).toEqual([]);
  });

  test("throws rather than yielding undefined typed as an array", () => {
    // The failure this exists to prevent: `parsed as { cells: T[] }` on each of
    // these hands back `undefined` and defers the crash to the first `.find`.
    for (const bad of [{}, { cells: "nope" }, { cells: { 0: 1 } }, null, 7]) {
      expect(() => cellsOf(bad, "f.json")).toThrow(TypeError);
    }
  });

  test("names the source file so the operator knows which read failed", () => {
    expect(() => cellsOf({}, "docs/spec/attachments/fold-cost-baseline.json")).toThrow(
      /fold-cost-baseline\.json/,
    );
  });
});

describe("compareToFrozen", () => {
  const frozen = (over: Partial<FrozenBaselineCell> = {}): FrozenBaselineCell => ({
    axis: "bytes",
    rows: 256,
    bytes_per_doc: 2048,
    snapshot_bytes: 532_300,
    cpu_ms_median: 10,
    peak_bytes_median: 1_000_000,
    ...over,
  });
  const overlapping = (over: Partial<ProbeCell> = {}): ProbeCell =>
    cell({ axis: "bytes", rows: 256, snapshot_bytes: 532_300, ...over });

  test("skips when no cell in the grid also exists in the baseline", () => {
    const [only] = compareToFrozen([overlapping({ rows: 999 })], [frozen()]);
    expect(only).toMatch(/SKIPPED/);
  });

  test("matches on axis + rows + bytes_per_doc, and reports the count compared", () => {
    const findings = compareToFrozen(
      [overlapping(), overlapping({ rows: 512, snapshot_bytes: 1_048_576 })],
      [frozen(), frozen({ rows: 512, snapshot_bytes: 1_048_576 })],
    );
    expect(findings[0]).toContain("(2 shared cells)");
  });

  test("a same-axis cell with a different bytes_per_doc is NOT a peer", () => {
    const findings = compareToFrozen([overlapping({ bytes_per_doc: 64 })], [frozen()]);
    expect(findings[0]).toMatch(/SKIPPED/);
  });

  test("calls the run suspect when a seeded snapshot_bytes diverges", () => {
    const findings = compareToFrozen([overlapping({ snapshot_bytes: 999 })], [frozen()]);
    expect(findings[0]).toContain("DIVERGES");
    expect(findings[0]).toContain("suspect");
  });

  test("says SLOWER only when every overlap cell is slower than the baseline", () => {
    // cpu ratios 1.5 and 2.0 — fastest > 1.
    const findings = compareToFrozen(
      [
        overlapping({ cpu_ms_median: 15 }),
        overlapping({ rows: 512, snapshot_bytes: 1_048_576, cpu_ms_median: 20 }),
      ],
      [frozen(), frozen({ rows: 512, snapshot_bytes: 1_048_576 })],
    );
    expect(findings[0]).toContain("THIS HOST IS SLOWER");
    expect(findings[0]).toContain("conservative");
  });

  test("says FASTER — and refuses publication — only when every cell is faster", () => {
    // cpu ratios 0.5 and 0.8 — slowest < 1.
    const findings = compareToFrozen(
      [
        overlapping({ cpu_ms_median: 5 }),
        overlapping({ rows: 512, snapshot_bytes: 1_048_576, cpu_ms_median: 8 }),
      ],
      [frozen(), frozen({ rows: 512, snapshot_bytes: 1_048_576 })],
    );
    expect(findings[0]).toContain("THIS HOST IS FASTER");
    expect(findings[0]).toContain("must not be published as-is");
  });

  test("straddles when the cells disagree on direction", () => {
    // cpu ratios 0.5 and 2.0 — neither bound holds.
    const findings = compareToFrozen(
      [
        overlapping({ cpu_ms_median: 5 }),
        overlapping({ rows: 512, snapshot_bytes: 1_048_576, cpu_ms_median: 20 }),
      ],
      [frozen(), frozen({ rows: 512, snapshot_bytes: 1_048_576 })],
    );
    expect(findings[0]).toContain("straddles");
    expect(findings[0]).not.toContain("THIS HOST IS");
  });

  test("a cell exactly on the baseline straddles rather than claiming a direction", () => {
    // The boundary the verdict turns on: ratio 1.0 is neither >1 nor <1.
    const findings = compareToFrozen([overlapping({ cpu_ms_median: 10 })], [frozen()]);
    expect(findings[0]).toContain("straddles");
  });
});

describe("contract shape", () => {
  test("budgets cover all three profiles and cite a source", () => {
    expect(HOST_BUDGETS.map((b) => b.profile)).toEqual(["cf-free", "cf-paid", "node"]);
    for (const b of HOST_BUDGETS) {
      expect(b.source.length).toBeGreaterThan(0);
      expect(b.cpu_ms).toBeGreaterThan(0);
      expect(b.memory_bytes).toBeGreaterThan(0);
    }
  });

  test("more than one margin is reported, so no single choice is baked in", () => {
    expect(REPORTED_MARGINS.length).toBeGreaterThan(1);
  });

  test("the recommendation names an owner and a blocker for every change", () => {
    const rec = buildRecommendation({ cells: bothAxes, subject_commit: "deadbeef" });
    expect(rec.recommended_changes.length).toBeGreaterThan(0);
    for (const change of rec.recommended_changes) {
      expect(change.file.length).toBeGreaterThan(0);
      expect(change.owner.length).toBeGreaterThan(0);
      expect(change).toHaveProperty("blocked_by");
    }
    expect(rec.sustainable.length).toBe(HOST_BUDGETS.length * REPORTED_MARGINS.length);
  });

  test("renderTable emits something for every profile", () => {
    const rec = buildRecommendation({ cells: bothAxes, subject_commit: "deadbeef" });
    const table = renderTable(rec);
    for (const b of HOST_BUDGETS) {
      expect(table).toContain(b.profile);
    }
  });
});
