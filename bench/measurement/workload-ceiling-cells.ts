/**
 * The executable cell catalogs for the workload-ceiling axis sweeps.
 *
 * Every value here is DERIVED from `WORKLOAD_CEILING_STUDY`
 * (`workload-ceiling-contract.ts`) — the contract is the preregistered owner of
 * the matrix, and a second literal copy of an axis would let the two drift
 * without any test noticing. Pure: no I/O, no clock, no storage.
 *
 * A cell is one point on one axis. It carries its own `scenario_id`, which is
 * the join key `workload-ceiling-collect.ts` stamps onto every raw event and
 * the aggregator groups by — so the id must be stable across runs, arms, and
 * implementations. It deliberately does NOT encode the arm: the hash-cost
 * difference (ticket 5) pairs the two monolithic arms BY scenario, and an
 * arm-qualified id would make every pair incomplete.
 */
import { WORKLOAD_CEILING_STUDY } from "./workload-ceiling-contract.ts";
import type { WorkloadCeilingFixtureSpec } from "./workload-ceiling-provision.ts";

/** Every byte-axis cell fixes descriptors here — see the ticket's rationale. */
export const BYTE_AXIS_MANIFEST_DESCRIPTORS = 8 as const;

/** Fixture calibration tolerance: achieved encoded bytes within this fraction of target. */
export const CELL_BYTE_TOLERANCE = 0.005 as const;

export interface WorkloadCeilingCell {
  readonly scenario_id: string;
  readonly axis: "byte" | "row";
  /** The axis quantity this cell is a point on: encoded snapshot bytes, or rows. */
  readonly target: number;
  readonly document_bytes: number;
  readonly manifest_descriptors: number;
}

/** `524288` → `512KiB`, `4194304` → `4MiB`. Exact powers only; every contract cell is one. */
export const byteLabel = (bytes: number): string => {
  if (bytes % (1024 * 1024) === 0) {
    return `${bytes / (1024 * 1024)}MiB`;
  }
  if (bytes % 1024 === 0) {
    return `${bytes / 1024}KiB`;
  }
  return `${bytes}B`;
};

/**
 * The four byte-axis cells, in ascending size. `collection_bytes` means ENCODED
 * SNAPSHOT BYTES on this axis (`WORKLOAD_CEILING_STUDY.axis_sweeps.byte_axis`),
 * which is what `calibrateRowCount` solves for.
 */
export const byteAxisCells = (): readonly WorkloadCeilingCell[] =>
  WORKLOAD_CEILING_STUDY.collection_bytes.map((bytes) => ({
    scenario_id: `byte-axis/${byteLabel(bytes)}`,
    axis: "byte",
    target: bytes,
    document_bytes: WORKLOAD_CEILING_STUDY.axis_sweeps.byte_axis.document_bytes,
    manifest_descriptors: BYTE_AXIS_MANIFEST_DESCRIPTORS,
  }));

/** The spec a cell provisions, once its row count has been calibrated. */
export const cellSpec = (
  cell: WorkloadCeilingCell,
  rowCount: number,
  collection: string,
): WorkloadCeilingFixtureSpec => ({
  scenario_id: cell.scenario_id,
  collection,
  row_count: rowCount,
  document_bytes: cell.document_bytes,
  manifest_descriptors: cell.manifest_descriptors,
});
