/**
 * Byte-exact projection of the snapshot a fold rebuilds, entry by entry,
 * as the compactor encodes it. Shared by the growth-refusal check
 * (`./capacity.ts`) and the compactor's bytes cut (`./compactor.ts`), so
 * the two agree on where a fold can stop; a module of its own because the
 * compactor cannot import `./capacity.ts` without a cycle through
 * `./maintenance.ts`.
 */

import {
  type CurrentJson,
  type DocumentData,
  encodeJsonBytes,
  SNAPSHOT_SCHEMA_VERSION,
} from "@baerly/protocol";
import { encodeSnapshotBody } from "./snapshot.ts";

/** Encoded size of one snapshot row: the `{ _id, body }` element the compactor writes. */
export const rowBytes = (docId: string, body: DocumentData): number =>
  encodeJsonBytes({ _id: docId, body }).byteLength;

/** Separators between `rows` elements of the snapshot's `docs` array. */
const separators = (rows: number): number => Math.max(rows - 1, 0);

/**
 * Encoded size of an empty snapshot body for `collection` whose header
 * records `max_seq`. Rows add their own bytes plus one separator between
 * each pair, inside the `docs` array.
 */
const headerBytes = (collection: string, maxSeq: number): number =>
  encodeSnapshotBody({
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    min_seq: 0,
    max_seq: maxSeq,
    collection,
    docs: [],
  }).byteLength;

/** Running projection of a snapshot as log entries fold onto it. */
export interface SnapshotProjection {
  /** Fold one entry onto the projection. */
  apply(op: "I" | "U" | "D", docId: string, after: DocumentData | undefined): void;
  /** Whether folding this entry would add a row (an `I` / `U` with a post-image for an absent row). */
  addsRow(op: "I" | "U" | "D", docId: string, after: DocumentData | undefined): boolean;
  readonly rows: number;
  /** Encoded size with the header the projection currently carries. */
  readonly bytes: number;
  /** Encoded size of the snapshot a fold ending at `maxSeq` writes: exact. */
  bytesAt(maxSeq: number): number;
  /** Largest `rows` / `bytes` seen at any prefix, the starting state included. */
  readonly peakRows: number;
  readonly peakBytes: number;
  /**
   * Restart the peaks at the current state, as once everything applied so
   * far has folded through `maxSeq`, which the header then records.
   */
  settle(maxSeq: number): void;
}

/**
 * Project the snapshot a fold would build from `head`'s stored figures and
 * its rows (`base`), one entry at a time, byte for byte as the compactor
 * encodes it: each row, one separator between rows, and the header, whose
 * `max_seq` is the fold's end. A stored snapshot's `max_seq` is
 * `log_seq_start` (the compactor writes both from the same fold end); a
 * never-folded collection (`snapshot_bytes === 0`) starts empty at 0.
 *
 * `bytes` keeps the stored header, so a growth check made now does not
 * know the `max_seq` its fold will record; `CAPACITY_BYTES_MARGIN` covers
 * that header growth. `bytesAt` is exact for a fold whose end is known.
 *
 * @internal — exported for `capacity.test.ts`.
 */
export const projectSnapshot = (
  head: Pick<CurrentJson, "snapshot_rows" | "snapshot_bytes" | "log_seq_start">,
  base: ReadonlyMap<string, DocumentData>,
  collection: string,
): SnapshotProjection => {
  // Current encoded size of each row touched so far; `null` = absent.
  const overlay = new Map<string, number | null>();
  const sizeOf = (docId: string): number | undefined => {
    const known = overlay.get(docId);
    if (known !== undefined) {
      return known ?? undefined;
    }
    const body = base.get(docId);
    return body === undefined ? undefined : rowBytes(docId, body);
  };
  const folded = head.snapshot_bytes !== 0;
  let header = headerBytes(collection, folded ? head.log_seq_start : 0);
  let rows = head.snapshot_rows;
  // Encoded rows without separators.
  let rowSum = folded ? head.snapshot_bytes - header - separators(rows) : 0;
  const sizeNow = (): number => header + rowSum + separators(rows);
  let peakRows = rows;
  let peakBytes = sizeNow();
  return {
    get rows() {
      return rows;
    },
    get bytes() {
      return sizeNow();
    },
    get peakRows() {
      return peakRows;
    },
    get peakBytes() {
      return peakBytes;
    },
    bytesAt(maxSeq: number): number {
      return headerBytes(collection, maxSeq) + rowSum + separators(rows);
    },
    addsRow(op: "I" | "U" | "D", docId: string, after: DocumentData | undefined): boolean {
      return op !== "D" && after !== undefined && sizeOf(docId) === undefined;
    },
    apply(op: "I" | "U" | "D", docId: string, after: DocumentData | undefined): void {
      // An `I` / `U` with no post-image is skipped, as the fold skips it.
      if (op !== "D" && after === undefined) {
        return;
      }
      const before = sizeOf(docId);
      if (op === "D" || after === undefined) {
        if (before !== undefined) {
          rows -= 1;
          rowSum -= before;
        }
        overlay.set(docId, null);
        return;
      }
      const next = rowBytes(docId, after);
      if (before === undefined) {
        rows += 1;
      }
      rowSum += next - (before ?? 0);
      overlay.set(docId, next);
      peakRows = Math.max(peakRows, rows);
      peakBytes = Math.max(peakBytes, sizeNow());
    },
    settle(maxSeq: number): void {
      header = headerBytes(collection, maxSeq);
      peakRows = rows;
      peakBytes = sizeNow();
    },
  };
};
