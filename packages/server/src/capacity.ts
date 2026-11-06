/**
 * Growth refusal at the host's fold ceiling (main-10, rulings G3–G5, G7).
 *
 * The in-band fold can only rebuild a snapshot within the serving host's
 * ceilings: `E` rows (`maxFoldRows`) and `C` bytes (`maxFoldBytes`, or
 * `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`). `compact()` folds the longest
 * prefix of the tail that keeps the snapshot within `E` rows, so it stops
 * at the first entry that would add a row to an `E`-row snapshot. Past
 * that point nothing folds, and every read pays one GET per pending tail
 * entry.
 * The write verbs call {@link capacityRefusal} after their pre-commit read
 * and before any commit, so a refused write commits nothing.
 *
 * The decision is a pure function of the state that read already loaded
 * (`current.json`, the snapshot rows, the pending tail) plus the planned
 * writes. Nothing is persisted, so the refusal clears as soon as that
 * state changes.
 */

import {
  BaerlyError,
  CAPACITY_BYTES_MARGIN,
  CODE_RESOLUTIONS,
  type CurrentJson,
  type DocumentData,
  encodeJsonBytes,
  type LogEntry,
  SNAPSHOT_SCHEMA_VERSION,
} from "@baerly/protocol";
import { type FoldCeilings, isFoldViable, resolveFoldCeilings } from "./maintenance.ts";
import { getCurrentContext } from "./observability/context.ts";
import { encodeSnapshotBody } from "./snapshot.ts";

/** One mutation a verb is about to commit, in commit order. */
export interface PlannedWrite {
  readonly op: "I" | "U" | "D";
  readonly docId: string;
  /** Post-image for `I` / `U`. */
  readonly after?: DocumentData;
  /** For `U`: the row's current body, as the verb's read returned it. */
  readonly before?: DocumentData;
}

/**
 * The fold ceilings of the host serving this request, resolved through
 * the write-tick runner's own {@link resolveFoldCeilings} so refusal and
 * folding always agree.
 */
export const currentFoldCeilings = (): FoldCeilings => {
  const maint = getCurrentContext()?.maintenance;
  return resolveFoldCeilings(maint?.options?.profile, maint?.maxFoldBytes);
};

/**
 * The refusal message names the state and the app-side remedy only. The
 * host-side route (a larger maintenance profile) is an operator decision:
 * it reaches operators through the `fold_deferred` log line and
 * `graduation.md`, never the app-authoring surface, so an agent reading
 * this error is not invited to retune a host setting.
 */
const refuse = (message: string): BaerlyError =>
  new BaerlyError("CapacityExceeded", message, {
    resolution: CODE_RESOLUTIONS.CapacityExceeded,
  });

/**
 * Bytes one row adds to an encoded snapshot body: the `{ _id, body }`
 * element the compactor writes, plus one array separator.
 */
const rowBytes = (docId: string, body: DocumentData): number =>
  encodeJsonBytes({ _id: docId, body }).byteLength + 1;

/** Encoded size of an empty snapshot body for `collection`. */
const emptySnapshotBytes = (collection: string): number =>
  encodeSnapshotBody({
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    min_seq: 0,
    max_seq: 0,
    collection,
    docs: [],
  }).byteLength;

/**
 * Growth (G3): an insert, or an update whose post-image encodes larger
 * than the row's current body. An update with no known `before` counts as
 * growth, which fails closed.
 */
const isGrowth = (write: PlannedWrite): boolean => {
  if (write.op === "I") {
    return true;
  }
  if (write.op === "D" || write.after === undefined) {
    return false;
  }
  return (
    write.before === undefined ||
    rowBytes(write.docId, write.after) > rowBytes(write.docId, write.before)
  );
};

/** Running projection of a snapshot as log entries fold onto it. */
export interface SnapshotProjection {
  /** Fold one entry onto the projection. */
  apply(op: "I" | "U" | "D", docId: string, after: DocumentData | undefined): void;
  /** Whether folding this entry would add a row (an `I` / `U` with a post-image for an absent row). */
  addsRow(op: "I" | "U" | "D", docId: string, after: DocumentData | undefined): boolean;
  readonly rows: number;
  readonly bytes: number;
  /** Largest `rows` / `bytes` seen at any prefix, the starting state included. */
  readonly peakRows: number;
  readonly peakBytes: number;
}

/**
 * Project the snapshot a fold would build from `head`'s stored figures and
 * its rows (`base`), one entry at a time. Rows are sized as the compactor
 * encodes them. A never-folded collection (`snapshot_bytes === 0`; every
 * written snapshot has a non-empty header) starts from an empty snapshot's
 * encoded header; later header growth (`max_seq` digits) is what
 * `CAPACITY_BYTES_MARGIN` covers.
 *
 * @internal — exported for `capacity.test.ts`.
 */
export const projectSnapshot = (
  head: Pick<CurrentJson, "snapshot_rows" | "snapshot_bytes">,
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
  const startBytes =
    head.snapshot_bytes === 0 ? emptySnapshotBytes(collection) : head.snapshot_bytes;
  const state = {
    rows: head.snapshot_rows,
    bytes: startBytes,
    peakRows: head.snapshot_rows,
    peakBytes: startBytes,
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
          state.rows -= 1;
          state.bytes -= before;
        }
        overlay.set(docId, null);
        return;
      }
      const next = rowBytes(docId, after);
      if (before === undefined) {
        state.rows += 1;
      }
      state.bytes += next - (before ?? 0);
      overlay.set(docId, next);
      state.peakRows = Math.max(state.peakRows, state.rows);
      state.peakBytes = Math.max(state.peakBytes, state.bytes);
    },
  };
  return state;
};

/**
 * Decide whether `writes` must be refused on the host with `ceilings`.
 * Returns the `CapacityExceeded` error to throw, or `undefined` to commit.
 *
 * - **No progress** (G5): the stored snapshot is over `E` rows or `C`
 *   bytes, or the pending tail holds an entry the fold stops at (one that
 *   adds a row while the projected snapshot holds `E` rows). Every write
 *   is refused, since anything appended behind that entry never folds on
 *   this host.
 * - **Growth** (an insert or a byte-growing update, G3): refused when the
 *   projected snapshot, at its peak over every prefix of the pending tail
 *   followed by the planned writes up to this one, would reach `E` rows or
 *   exceed `C - CAPACITY_BYTES_MARGIN` bytes (G4). The peak counts because
 *   a fold can land at any prefix.
 * - Anything else (deletes, same-size and shrinking updates) commits, at
 *   `E` rows included: the fold drains them in place.
 *
 * A batch is decided whole, before its first row commits.
 *
 * @param head `current.json` as the pre-commit read saw it.
 * @param base The snapshot rows that read loaded (`docId → body`).
 * @param tail Every log entry that read folded on top of `base`, in order.
 */
export const capacityRefusal = (args: {
  readonly collection: string;
  readonly head: Pick<CurrentJson, "snapshot_rows" | "snapshot_bytes">;
  readonly base: ReadonlyMap<string, DocumentData>;
  readonly tail: readonly LogEntry[];
  readonly writes: readonly PlannedWrite[];
  readonly ceilings: FoldCeilings;
}): BaerlyError | undefined => {
  const { collection, head, base, tail, writes, ceilings } = args;
  if (writes.length === 0) {
    return undefined;
  }
  const { maxFoldRows: maxRows, maxFoldBytes: maxBytes } = ceilings;
  const noProgress = (why: string): BaerlyError =>
    refuse(
      `collection ${JSON.stringify(collection)} has outgrown this host (${why}): no fold can ` +
        `make progress here, so every write is refused and reads keep working. The collection ` +
        `needs a larger host or graduation; export it with baerly admin dump.`,
    );
  // The runner's own pre-fold gate; it fails closed on a NaN ceiling.
  if (!isFoldViable(head.snapshot_bytes, head.snapshot_rows, ceilings)) {
    return noProgress(
      `${head.snapshot_rows} rows of ${maxRows}, ${head.snapshot_bytes} bytes of ${maxBytes}`,
    );
  }

  const projection = projectSnapshot(head, base, collection);
  for (const entry of tail) {
    // Skip what the fold skips (`foldLogEntriesOnto`): another collection's entries.
    if (entry.collection !== collection) {
      continue;
    }
    // Where `compact()` stops: a row-adding entry at `E` rows.
    if (projection.addsRow(entry.op, entry.doc_id, entry.after) && !(projection.rows < maxRows)) {
      return noProgress(`a pending insert cannot fold onto ${projection.rows} rows of ${maxRows}`);
    }
    projection.apply(entry.op, entry.doc_id, entry.after);
  }

  const byteLimit = maxBytes - CAPACITY_BYTES_MARGIN;
  for (const write of writes) {
    const growth = isGrowth(write);
    projection.apply(write.op, write.docId, write.after);
    const { peakRows, peakBytes } = projection;
    if (growth && (!(peakRows < maxRows) || !(peakBytes <= byteLimit))) {
      const detail = !(peakRows < maxRows)
        ? `${peakRows} rows would reach the ${maxRows}-row ceiling`
        : `${peakBytes} bytes would pass the ${maxBytes}-byte ceiling`;
      return refuse(
        `collection ${JSON.stringify(collection)} is full on this host: ${detail}, so this ` +
          `${write.op === "I" ? "insert" : "growing update"} was refused and nothing was ` +
          `committed. Deletes and same-size or shrinking updates still commit; delete or shrink ` +
          `rows to make room. If the collection must keep growing, it needs a larger host or graduation.`,
      );
    }
  }
  return undefined;
};
