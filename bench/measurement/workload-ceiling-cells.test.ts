import { describe, expect, test } from "vitest";
import { WORKLOAD_CEILING_STUDY } from "./workload-ceiling-contract.ts";
import { byteAxisCells, BYTE_AXIS_MANIFEST_DESCRIPTORS } from "./workload-ceiling-cells.ts";

describe("byteAxisCells", () => {
  test("byte-axis cells derive from the contract, not from a second literal", () => {
    expect(byteAxisCells().map((c) => c.target)).toEqual([
      ...WORKLOAD_CEILING_STUDY.collection_bytes,
    ]);
  });

  test("every byte-axis cell uses the contract's canonical document size", () => {
    for (const cell of byteAxisCells()) {
      expect(cell.document_bytes).toBe(WORKLOAD_CEILING_STUDY.axis_sweeps.byte_axis.document_bytes);
    }
  });

  test("scenario ids are stable, unique, and arm-free", () => {
    const ids = byteAxisCells().map((c) => c.scenario_id);
    expect(ids).toEqual(["byte-axis/512KiB", "byte-axis/1MiB", "byte-axis/2MiB", "byte-axis/4MiB"]);
    expect(new Set(ids).size).toBe(ids.length);
    // The arm lives in the collection directory, never in the join key — the
    // hash-cost difference pairs the two monolithic arms BY scenario id.
    for (const id of ids) {
      expect(id).not.toContain("monolithic");
    }
  });

  test("every cell has the fixed descriptor count", () => {
    for (const cell of byteAxisCells()) {
      expect(cell.manifest_descriptors).toBe(BYTE_AXIS_MANIFEST_DESCRIPTORS);
    }
  });

  test("the minimum useful byte-axis target is one of the cells", () => {
    expect(byteAxisCells().map((c) => c.target)).toContain(
      WORKLOAD_CEILING_STUDY.minimum_useful_targets.byte_axis.collection_bytes,
    );
  });

  test("every cell carries the byte axis discriminant", () => {
    for (const cell of byteAxisCells()) {
      expect(cell.axis).toBe("byte");
    }
  });
});
