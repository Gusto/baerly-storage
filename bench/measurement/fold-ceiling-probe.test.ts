import { MemoryStorage } from "@baerly/protocol";
import { describe, expect, test, vi } from "vitest";
import type * as FoldFixtureModule from "../lib/fold-fixture.ts";
import { buildFixture, measureOneFold } from "../lib/fold-fixture.ts";
import {
  type FrozenBaselineCell,
  type ProbeCell,
  buildRecord,
  cellsOf,
  compareToFrozen,
  deriveFindings,
  isPeakSampleUsable,
  renderTable,
  runProbeGrid,
} from "./fold-ceiling-probe.ts";

vi.mock("../lib/fold-fixture.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof FoldFixtureModule>()),
  buildFixture: vi.fn<typeof buildFixture>(),
  measureOneFold: vi.fn<typeof measureOneFold>(),
}));

describe("peak measurement failures", () => {
  test.each([0, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects unusable peak samples (%s)",
    async (peakBytes) => {
      vi.mocked(buildFixture).mockResolvedValue({
        storage: new MemoryStorage(),
        snapshotBytes: 1000,
        rows: 1,
      });
      vi.mocked(measureOneFold).mockResolvedValue({ cpuMs: 1, peakBytes });
      await expect(runProbeGrid()).rejects.toThrow(/no usable peak samples/);
    },
  );
  test("keeps valid peaks and records rejected samples", async () => {
    vi.mocked(buildFixture).mockResolvedValue({
      storage: new MemoryStorage(),
      snapshotBytes: 1000,
      rows: 1,
    });
    let sample = 0;
    vi.mocked(measureOneFold).mockImplementation(async () => ({
      cpuMs: 1,
      peakBytes: sample++ % 2 === 0 ? 0 : 2000,
    }));
    const cells = await runProbeGrid();
    expect(cells.length).toBeGreaterThan(0);
    for (const measured of cells) {
      expect(measured.peak_bytes_median).toBe(2000);
      expect(measured.peak_samples_discarded).toBeGreaterThan(0);
      expect(measured.peak_samples_discarded).toBeLessThan(measured.iterations);
    }
  });
});

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

const bothAxes: readonly ProbeCell[] = [
  cell({ axis: "bytes", rows: 256, snapshot_bytes: 532_300 }),
  cell({ axis: "rows", rows: 2048, bytes_per_doc: 64, snapshot_bytes: 232_287 }),
];

describe("isPeakSampleUsable", () => {
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
    expect(knee).toContain("measured cost-per-MB knee");
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
    const rec = buildRecord({ cells: bothAxes, subject_commit: "deadbeef" });
    expect(rec.findings).toEqual(deriveFindings(bothAxes));
    expect(rec.findings.length).toBeGreaterThan(0);
  });

  test("runner-supplied findings are appended, not substituted", () => {
    const rec = buildRecord({
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
    expect(findings[0]).toContain("neither CPU nor heap deltas establish Worker limits");
  });

  test("says FASTER only when every cell is faster", () => {
    // cpu ratios 0.5 and 0.8 — slowest < 1.
    const findings = compareToFrozen(
      [
        overlapping({ cpu_ms_median: 5 }),
        overlapping({ rows: 512, snapshot_bytes: 1_048_576, cpu_ms_median: 8 }),
      ],
      [frozen(), frozen({ rows: 512, snapshot_bytes: 1_048_576 })],
    );
    expect(findings[0]).toContain("THIS HOST IS FASTER");
    expect(findings[0]).toContain("neither CPU nor heap deltas establish Worker limits");
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

describe("record scope", () => {
  test("retains measurements without asserting a production ceiling", () => {
    const record = buildRecord({ cells: bothAxes, subject_commit: "deadbeef" });
    expect(record.measurement_scope).toBe("node-host-only");
    expect(record.cells).toEqual(bothAxes);
    expect(record).not.toHaveProperty("sustainable");
    expect(record).not.toHaveProperty("today_headroom");
    expect(record).not.toHaveProperty("recommended_changes");
    expect(record.findings.join("\n")).not.toMatch(/cf-free|cf-paid|margin|portable/);
    const table = renderTable(record);
    expect(table).toContain("Node-host measurements only");
    for (const c of bothAxes) {
      expect(table).toContain(c.label);
    }
  });
});
