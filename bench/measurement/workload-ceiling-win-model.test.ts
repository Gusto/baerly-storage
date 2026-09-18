import { describe, expect, test } from "vitest";
import { CHUNK_BOUNDARY_POLICIES } from "../../packages/server/src/snapshot-chunk-builder.ts";
import {
  buildRows,
  buildWinModelRecord,
  deriveFindings,
  entriesOf,
  median,
  packedBase,
  PACKER_STALENESS_FINDING_TEXT,
  rangeLabel,
  renderTable,
  snapshotEncodeCounters,
  WIN_MODEL_DOCUMENT_BYTES,
  winRatio,
  type WinModelRow,
  type WinModelSkip,
} from "./workload-ceiling-win-model.ts";

const row = (over: Partial<WinModelRow> = {}): WinModelRow => ({
  cell: "4MiB",
  policy: "c128-r512",
  descriptors: 32,
  locality: "append",
  kMedian: 20,
  kMin: 20,
  kMax: 20,
  plannerWinMedian: 1.9,
  plannerWinRange: "1.80-1.90",
  prefixWinMedian: 39.46,
  prefixWinRange: "30.00-39.46",
  plannerHashMedian: 20,
  prefixHashMedian: 1,
  trials: [
    {
      seed: 1,
      admitted: 20,
      plannerJsonBytes: 100,
      plannerHashCalls: 20,
      prefixJsonBytes: 5,
      prefixHashCalls: 1,
      monoJsonBytes: 200,
      plannerWin: 1.9,
      prefixWin: 39.46,
    },
  ],
  ...over,
});

describe("win-model helpers", () => {
  test("buildRows pads each document to the requested byte length", () => {
    const rows = buildRows(4, 64);
    expect(rows).toHaveLength(4);
    expect(rows[0]!["_id"]).toBe("row-0");
    expect(rows[3]!["_id"]).toBe("row-3");
  });

  test("entriesOf uniform updates existing ids; append inserts after the range", () => {
    const rows = buildRows(8, 64);
    const uniform = entriesOf(rows, 3, "uniform", 1, 64);
    expect(uniform).toHaveLength(3);
    for (const entry of uniform) {
      expect(entry.op).toBe("U");
      expect(rows.some((r) => r["_id"] === entry.doc_id)).toBe(true);
    }
    const append = entriesOf(rows, 3, "append", 1, 64);
    expect(append.map((entry) => entry.doc_id)).toEqual(["row-8", "row-9", "row-10"]);
    for (const entry of append) {
      expect(entry.op).toBe("I");
    }
  });

  test("packedBase respects both policy thresholds", async () => {
    const rows = buildRows(32, 64);
    const packed = await packedBase(rows, CHUNK_BOUNDARY_POLICIES["c128-r512"]);
    expect(packed.descriptors.length).toBeGreaterThan(0);
    let total = 0;
    for (const descriptor of packed.descriptors) {
      expect(descriptor.row_count).toBeLessThanOrEqual(
        CHUNK_BOUNDARY_POLICIES["c128-r512"].target_rows,
      );
      expect(descriptor.byte_length).toBeLessThanOrEqual(
        CHUNK_BOUNDARY_POLICIES["c128-r512"].target_chunk_bytes,
      );
      total += descriptor.row_count;
    }
    expect(total).toBe(32);
  });

  test("median and rangeLabel refuse to invent a value for an empty set", () => {
    expect(Number.isNaN(median([]))).toBe(true);
    expect(rangeLabel([])).toBe("-");
    expect(median([1, 3, 2])).toBe(2);
    expect(rangeLabel([1.234, 5])).toBe("1.23-5.00");
  });

  test("winRatio is mono/fold and NaN on a zero fold", () => {
    expect(winRatio(10, 5)).toBe(2);
    expect(Number.isNaN(winRatio(10, 0))).toBe(true);
  });
});

describe("win-model report", () => {
  test("table names both planners and does not pick one", () => {
    const table = renderTable([row()], []);
    expect(table).toContain("plannerWin");
    expect(table).toContain("prefixWin");
    expect(table).toContain("planner=");
    expect(table).toContain("prefix=");
    expect(table.toLowerCase()).not.toContain("verdict");
    expect(table.toLowerCase()).not.toContain("admit");
  });

  test("skips surface as SKIP lines rather than invented wins", () => {
    const skip: WinModelSkip = {
      cell: "1MiB",
      policy: "c1024-r4096",
      reason: "canonical body exceeds 1048576 bytes",
    };
    const table = renderTable([], [skip]);
    expect(table).toContain("SKIP");
    expect(table).toContain("c1024-r4096");
    expect(table).not.toContain("planner=");
  });

  test("findings record packer staleness and refuse to choose a planner", () => {
    const findings = deriveFindings([row()], []);
    expect(findings).toContain(PACKER_STALENESS_FINDING_TEXT);
    expect(findings.some((finding) => finding.includes("No verdict"))).toBe(true);
    expect(findings.some((finding) => finding.includes("plannerWin range"))).toBe(true);
    expect(findings.some((finding) => finding.includes("prefixWin range"))).toBe(true);
    expect(findings.some((finding) => finding.includes("ADR-007 item 4"))).toBe(true);
  });

  test("record carries both planners and the skip list", () => {
    const skip: WinModelSkip = {
      cell: "2MiB",
      policy: "c1024-r4096",
      reason: "canonical body exceeds 1048576 bytes",
    };
    const rec = buildWinModelRecord({
      rows: [row()],
      skips: [skip],
      subject_commit: "abc",
    });
    expect(rec.version).toBe("baerly.workload-ceiling-win-model/v1");
    expect(rec.subject_commit).toBe("abc");
    expect(rec.rows).toHaveLength(1);
    expect(rec.skips).toEqual([skip]);
    expect(rec.findings.length).toBeGreaterThan(0);
  });

  test("reading counters without the registrar throws rather than undercounting", () => {
    expect(() => snapshotEncodeCounters()).toThrow(/workload-ceiling-win-model-hooks/);
  });
});

describe("fixture size", () => {
  test("document byte target matches the original apparatus", () => {
    expect(WIN_MODEL_DOCUMENT_BYTES).toBe(2048);
  });
});
