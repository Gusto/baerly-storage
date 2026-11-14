/**
 * Growth refusal at the host's fold ceiling (main-10, rulings G3–G5, G7).
 *
 * The in-band fold can only rebuild a snapshot within the serving host's
 * ceilings: `E` rows (`maxFoldRows`) and `C` bytes (`maxFoldBytes`, or
 * `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`). `compact()` folds the longest
 * prefix of the tail that keeps the snapshot within `E` rows, so it stops
 * at the first entry that would add a row to an `E`-row snapshot, and of
 * that, the longest prefix of its pass that rebuilds within `C` bytes. Past
 * a point no pass can fold, nothing folds, and every read pays one GET per
 * pending tail entry.
 * The write verbs call {@link capacityDecision} after their pre-commit read
 * and before any commit, so a refused write commits nothing, and again
 * inside each commit, before its `log/<seq>` create, whenever another
 * write landed since that read, so concurrent growth writes that each
 * passed cannot together pass the ceiling (G5-race).
 *
 * The decision is a pure function of the state that read already loaded
 * (`current.json`, the snapshot rows, the pending tail) plus the planned
 * writes. Nothing is persisted, so the refusal clears as soon as that
 * state changes.
 *
 * An admitted write that leaves the collection within
 * `CAPACITY_WARN_FRACTION` of that point carries a warning (G7), computed
 * from the same state, so it too needs no persisted flag.
 *
 * Near the ceiling the verbs also drive the fold (G6): an accepted write
 * that leaves the collection at its growth-refusal point forces its
 * write tick, and a refused growth write whose room the pending tail
 * would free dispatches one forced fold and refuses with
 * `MaintenancePending` instead of `CapacityExceeded`.
 */

import {
  BaerlyError,
  CAPACITY_BYTES_MARGIN,
  CAPACITY_WARN_FRACTION,
  CODE_RESOLUTIONS,
  MAINTENANCE_PENDING_RETRY_AFTER_SECONDS,
  MAINTENANCE_PROFILE_CF_FREE,
  type CurrentJson,
  type DocumentData,
  type LogEntry,
} from "@baerly/protocol";
import {
  type FoldCeilings,
  isFoldViable,
  type MaintenanceProfile,
  resolveFoldCeilings,
} from "./maintenance.ts";
import { getCurrentContext } from "./observability/context.ts";
import { isOwnCollection } from "./collection-alias.ts";
import { projectSnapshot, rowBytes, type SnapshotProjection } from "./snapshot-projection.ts";

/** One mutation a verb is about to commit, in commit order. */
export interface PlannedWrite {
  readonly op: "I" | "U" | "D";
  readonly docId: string;
  /** Post-image for `I` / `U`. */
  readonly after?: DocumentData;
  /** For `U`: the row's current body, as the verb's read returned it. */
  readonly before?: DocumentData;
}

/** A host's fold ceilings plus the entries one fold pass applies. */
export type HostFoldLimits = FoldCeilings & Pick<MaintenanceProfile, "maxFoldEntriesPerPass">;

/**
 * The fold ceilings and pass size of the host serving this request,
 * resolved as the write-tick runner resolves them
 * ({@link resolveFoldCeilings}, absent profile ⇒ cf-free) so refusal and
 * folding always agree.
 */
export const currentFoldCeilings = (): HostFoldLimits => {
  const maint = getCurrentContext()?.maintenance;
  const profile = maint?.options?.profile;
  return {
    ...resolveFoldCeilings(profile, maint?.maxFoldBytes),
    // The runner's own default when no profile is threaded.
    maxFoldEntriesPerPass: (profile ?? MAINTENANCE_PROFILE_CF_FREE).maxFoldEntriesPerPass,
  };
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

/**
 * Backpressure for a refused growth write whose room the pending tail
 * frees once it folds (G6). Like `CapacityExceeded`, it names the state
 * and the app-side remedy only.
 */
export const maintenancePending = (collection: string): BaerlyError =>
  new BaerlyError(
    "MaintenancePending",
    `collection ${JSON.stringify(collection)} is waiting on maintenance: this write would grow ` +
      `it past what this host can fold until the pending changes fold, so it was refused and ` +
      `not committed (rows a batch committed before it are kept). Retry after ${MAINTENANCE_PENDING_RETRY_AFTER_SECONDS}s.`,
    {
      resolution: CODE_RESOLUTIONS.MaintenancePending,
      retryAfter: MAINTENANCE_PENDING_RETRY_AFTER_SECONDS,
    },
  );

/**
 * An admitted write is approaching the growth-refusal point (G7). `used`
 * and `limit` are in the named dimension: rows against `E`, or projected
 * bytes against `C - CAPACITY_BYTES_MARGIN`.
 */
export interface CapacityWarning {
  readonly dimension: "rows" | "bytes";
  readonly used: number;
  readonly limit: number;
  /** The human text: the state and the app-side remedy, no host settings. */
  readonly text: string;
}

/** Canonical-line field carrying {@link CapacityWarning.text}. */
export const CAPACITY_WARNING_FIELD = "capacity_warning";

/**
 * The warning for a projection peaking at `peakRows` / `peakBytes`, or
 * `undefined` while both dimensions sit under `CAPACITY_WARN_FRACTION` of
 * their limits. The more-used dimension is reported. The text names the
 * state and the app-side remedy only, like the refusal it precedes.
 */
const warningFor = (
  peakRows: number,
  peakBytes: number,
  maxRows: number,
  byteLimit: number,
): CapacityWarning | undefined => {
  const rowFraction = peakRows / maxRows;
  const byteFraction = peakBytes / byteLimit;
  const rows = rowFraction >= byteFraction;
  const fraction = rows ? rowFraction : byteFraction;
  // `!(x >= y)` rather than `x < y`: a NaN ceiling must not read as "room".
  if (!(fraction >= CAPACITY_WARN_FRACTION) || !Number.isFinite(fraction)) {
    return undefined;
  }
  const used = rows ? peakRows : peakBytes;
  const limit = rows ? maxRows : byteLimit;
  const percent = Math.floor(fraction * 100);
  return {
    dimension: rows ? "rows" : "bytes",
    used,
    limit,
    text:
      `this collection is at ${percent}% of what this host can hold (${used} of ${limit} ` +
      `${rows ? "rows" : "bytes"}); inserts and growing updates will be refused at the limit. ` +
      `Delete rows or shrink documents to make room, or export with baerly admin dump.`,
  };
};

/**
 * Stamp `warning` on the request's canonical line (and so the log record)
 * under {@link CAPACITY_WARNING_FIELD}. The HTTP router copies the same
 * text onto the write response. A no-op without a request context, as for
 * any field setter.
 */
export const noteCapacityWarning = (warning: CapacityWarning): void => {
  getCurrentContext()?.fields.set(CAPACITY_WARNING_FIELD, warning.text);
};

/** What {@link capacityDecision} decided for one batch of planned writes. */
export type CapacityDecision =
  | {
      readonly refusal: undefined;
      /**
       * Set when the admitted writes leave the collection within
       * `CAPACITY_WARN_FRACTION` of its refusal point (G7).
       */
      readonly warning?: CapacityWarning;
      /**
       * The verb forces its write tick (G6): the collection sits at its
       * growth-refusal point once these writes commit, and folding the
       * pending tail frees room or the tail holds a full fold pass.
       */
      readonly pressure: boolean;
    }
  | {
      /** The `CapacityExceeded` refusal to throw. */
      readonly refusal: BaerlyError;
      /**
       * A growth refusal (never the no-progress state) that the pending
       * tail would lift once it folds, where the next fold pass can land.
       * The verb may dispatch that fold and refuse with
       * {@link maintenancePending} instead.
       */
      readonly foldFreesRoom: boolean;
    };

/**
 * Decide whether `writes` must be refused on the host with `ceilings`.
 *
 * - **No progress** (G5): the stored snapshot is over `E` rows or `C`
 *   bytes, or the pending tail holds an entry the fold stops at (one that
 *   adds a row while the projected snapshot holds `E` rows), or
 *   `maxFoldEntriesPerPass` consecutive pending seqs whose folded snapshot
 *   each rebuilds past `C`, a run no fold pass can cross. Every write is
 *   refused, since anything appended behind that point never folds on this
 *   host. A write that would itself complete such a run is refused too.
 * - **Growth** (an insert or a byte-growing update, G3): refused when the
 *   projected snapshot, at its peak over every prefix of the pending tail
 *   followed by the planned writes up to this one, would reach `E` rows or
 *   exceed `C - CAPACITY_BYTES_MARGIN` bytes (G4). The peak counts because
 *   a fold can land at any prefix. `foldFreesRoom` (G6) is set when the
 *   same writes would be admitted onto the snapshot the whole pending tail
 *   folds to, and the whole tail folds within `C`, so folds alone admit
 *   the writes.
 * - Anything else (deletes, same-size and shrinking updates) commits, at
 *   `E` rows included: the fold drains them in place. `pressure` reports
 *   whether the commit forces its write tick (see `forcesTick` inside).
 *
 * A batch is decided whole, before its first row commits. The verbs
 * re-run the decision at each commit over the entries that landed since
 * (G5-race, `admitWrites` in `./query.ts`), for the writes not yet
 * committed.
 *
 * @param head `current.json` as the pre-commit read saw it.
 * @param base The snapshot rows that read loaded (`docId → body`).
 * @param tail Every log entry that read folded on top of `base`, in order.
 */
export const capacityDecision = (args: {
  readonly collection: string;
  readonly head: Pick<CurrentJson, "snapshot_rows" | "snapshot_bytes" | "log_seq_start">;
  readonly base: ReadonlyMap<string, DocumentData>;
  readonly tail: readonly LogEntry[];
  readonly writes: readonly PlannedWrite[];
  readonly ceilings: HostFoldLimits;
}): CapacityDecision => {
  const { collection, head, base, tail, writes, ceilings } = args;
  if (writes.length === 0) {
    return { refusal: undefined, pressure: false };
  }
  const { maxFoldRows: maxRows, maxFoldBytes: maxBytes } = ceilings;
  const byteLimit = maxBytes - CAPACITY_BYTES_MARGIN;
  const noProgress = (why: string): CapacityDecision => ({
    refusal: refuse(
      `collection ${JSON.stringify(collection)} has outgrown this host (${why}): no fold can ` +
        `make progress here, so every write is refused and reads keep working. The collection ` +
        `needs a larger host or graduation; export it with baerly admin dump.`,
    ),
    foldFreesRoom: false,
  });
  // The runner's own pre-fold gate; it fails closed on a NaN ceiling.
  if (!isFoldViable(head.snapshot_bytes, head.snapshot_rows, ceilings)) {
    return noProgress(
      `${head.snapshot_rows} rows of ${maxRows}, ${head.snapshot_bytes} bytes of ${maxBytes}`,
    );
  }

  // Skip what the fold skips (`foldLogEntriesOnto`): another collection's entries.
  const own = tail.filter((entry) => isOwnCollection(entry.collection, collection));
  const projection = projectSnapshot(head, base, collection);
  // `compact()` folds at most `maxFoldEntriesPerPass` seqs from
  // `log_seq_start` (other collections' entries count toward it) and
  // publishes the longest prefix of that pass whose rebuilt snapshot fits
  // `C`. Whether a prefix fits depends only on the log up to its end, not
  // on where passes fall: a seq "over" `C` (the snapshot folded through it
  // rebuilds past `C`) is never a fold end. A run of `pass` consecutive
  // over seqs is therefore a wall: no pass from the last fitting seq before
  // it reaches past it, and the log is immutable, so it and everything
  // behind it never fold here (G5). A shorter run is crossed by the pass
  // that starts before it, and a run at the end of the tail can still be
  // ended by later entries.
  const pass = ceilings.maxFoldEntriesPerPass;
  let overRun = 0;
  for (const [i, entry] of tail.entries()) {
    if (isOwnCollection(entry.collection, collection)) {
      // Where `compact()` stops: a row-adding entry at `E` rows.
      if (projection.addsRow(entry.op, entry.doc_id, entry.after) && !(projection.rows < maxRows)) {
        return noProgress(
          `a pending insert cannot fold onto ${projection.rows} rows of ${maxRows}`,
        );
      }
      projection.apply(entry.op, entry.doc_id, entry.after);
    }
    // The snapshot folded through this seq, exactly as compact() sizes it against `C`.
    const rebuilt = projection.bytesAt(head.log_seq_start + i + 1);
    overRun = rebuilt <= maxBytes ? 0 : overRun + 1;
    if (!(overRun < pass)) {
      return noProgress(
        `${overRun} pending entries in a row each leave the snapshot past ${maxBytes} bytes`,
      );
    }
  }
  // Every forced fold of the tail lands: each pass reaches a fitting seq,
  // and the last one ends the tail.
  const tailLands = overRun === 0;

  /**
   * Whether an accepted batch forces its write tick (G6), given `p` with
   * the tail and the writes applied. Only at the refusal point (one more
   * inserted row, or one more byte of growth, would be refused), and then
   * only when that fold is worth its full snapshot rebuild:
   *
   * - folding the pending tail frees room for growth (the snapshot it
   *   rebuilds to admits one more row and byte), or
   * - the pending tail, these writes included, holds a full pass
   *   (`maxFoldEntriesPerPass`).
   *
   * Otherwise the runner's ratio trigger and entry floor apply as usual.
   * The pass floor is the cheapest cadence that keeps the tail bounded at
   * the ceiling: every pending entry costs each read one GET, and on
   * Workers Free the ratio trigger alone would let a collection held at
   * `E - 1` by same-size updates queue ~300 entries. One forced fold per
   * pass also bounds the rebuild cost to one full snapshot per
   * `maxFoldEntriesPerPass` writes, rather than one per write, and with it
   * the snapshots each rebuild orphans: on cf-free that is under one
   * orphan (20-entry pass) per hard-GC interval of 16 writes, against that
   * slice's sweep budget of 10, so GC keeps up even though a forced fold
   * is the tick's only phase.
   */
  const forcesTick = (p: SnapshotProjection): boolean => {
    const atRefusalPoint =
      !(Math.max(p.peakRows, p.rows + 1) < maxRows) || !(p.peakBytes < byteLimit);
    if (!atRefusalPoint) {
      return false;
    }
    // A forced fold that defers rebuilds the snapshot for nothing. Every
    // pass lands when the tail does: each reaches a fitting seq of the
    // tail, and an admitted growth write keeps every prefix within
    // `C - margin` (the margin covers the header's later `max_seq` digits).
    if (!tailLands) {
      return false;
    }
    const foldFreesRoom = p.rows + 1 < maxRows && p.bytes < byteLimit;
    return foldFreesRoom || tail.length + writes.length >= pass;
  };

  /**
   * The first write `p` refuses, applying every write onto `p` from a
   * state `overRun` seqs into a run over `C`: a growth write past the
   * growth limit, or any write that would complete a wall of `pass` seqs
   * over `C` (`stranded`), which it would itself sit behind.
   */
  const firstRefused = (
    p: SnapshotProjection,
    run: number,
  ): { write: PlannedWrite; stranded: boolean } | undefined => {
    for (const [j, write] of writes.entries()) {
      const growth = isGrowth(write);
      p.apply(write.op, write.docId, write.after);
      if (growth && (!(p.peakRows < maxRows) || !(p.peakBytes <= byteLimit))) {
        return { write, stranded: false };
      }
      run = p.bytesAt(head.log_seq_start + tail.length + j + 1) <= maxBytes ? 0 : run + 1;
      if (!(run < pass)) {
        return { write, stranded: true };
      }
    }
    return undefined;
  };

  const first = firstRefused(projection, overRun);
  if (first === undefined) {
    const warning = warningFor(projection.peakRows, projection.peakBytes, maxRows, byteLimit);
    return {
      refusal: undefined,
      pressure: forcesTick(projection),
      ...(warning !== undefined && { warning }),
    };
  }
  if (first.stranded) {
    return {
      refusal: refuse(
        `collection ${JSON.stringify(collection)} is waiting on changes this host cannot fold: ` +
          `the pending changes leave it past ${maxBytes} bytes, and this write would leave ` +
          `them stuck there for good, so it was refused and not committed (rows a batch ` +
          `committed before it are kept). A write that brings the collection back within ` +
          `${maxBytes} bytes still commits; otherwise it needs a larger host or graduation.`,
      ),
      foldFreesRoom: false,
    };
  }
  const refused = first.write;
  const { peakRows, peakBytes } = projection;
  const detail = !(peakRows < maxRows)
    ? `${peakRows} rows would reach the ${maxRows}-row ceiling`
    : `${peakBytes} bytes would pass the ${maxBytes}-byte ceiling`;
  const refusal = refuse(
    `collection ${JSON.stringify(collection)} is full on this host: ${detail}, so this ` +
      `${refused.op === "I" ? "insert" : "growing update"} was refused and not ` +
      `committed (rows a batch committed before it are kept). Deletes and same-size or shrinking updates still commit; delete or shrink ` +
      `rows to make room. If the collection must keep growing, it needs a larger host or graduation.`,
  );
  // `MaintenancePending` promises that folds alone admit these writes, so
  // every pass of the tail must land.
  if (own.length === 0 || !tailLands) {
    return { refusal, foldFreesRoom: false };
  }
  // Would the writes fit once the pending tail folds? The tail's own prefix
  // peaks no longer count after it folds, so the projection restarts at the
  // snapshot the whole tail rebuilds, byte for byte what the retry projects
  // from, so the retry admits what this promises.
  const settled = projectSnapshot(head, base, collection);
  for (const entry of own) {
    settled.apply(entry.op, entry.doc_id, entry.after);
  }
  settled.settle(head.log_seq_start + tail.length);
  return { refusal, foldFreesRoom: firstRefused(settled, 0) === undefined };
};
