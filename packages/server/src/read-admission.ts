/**
 * Staged read admission (main-2): a read whose work falls outside the
 * serving host's read envelope is refused whole with `CapacityExceeded`,
 * never truncated, and a read inside it is served exactly as on any other
 * host (P1). Reads stay pure: a refusal writes nothing and dispatches no
 * maintenance, so a read never carries `MaintenancePending`.
 *
 * Every read, index-covered or not, is a full fold: it takes membership
 * from the snapshot plus the log tail, never from an index LIST, so its
 * work is bounded by the full-fold bounds below (I1: materialized =
 * snapshot rows + tail entries). There is no index-specific bound.
 *
 * Two stages, both over the current layout (one snapshot plus the live
 * log tail):
 *
 * 1. **Head.** `current.json` alone refuses a read that is certain not to
 *    fit: its snapshot is over the byte or row bound, or the strict log
 *    range `[log_seq_start, tail_hint)` alone is over the tail or
 *    materialization bound, or the storage calls the read must issue at
 *    least are more than the request ledger has left. `tail_hint` is a
 *    lower bound on the tail, so every head check is a lower bound and
 *    never refuses a read that fits.
 * 2. **Staged.** The read charges each log body before decoding it (tail
 *    entries, tail bytes, materialized rows), and checks the answer's row
 *    count before returning it. Two buckets with identical heads but different tails are told apart
 *    here. Storage calls are charged by the request ledger at issue
 *    (`retryStorageCall`), retries included.
 *
 * Memory: the adapter `GET` has already allocated a body when its length is
 * checked; the head's `snapshot_bytes` bounds the snapshot before its GET.
 * A bounded-read `Storage` seam is not needed while each log entry is one
 * small object.
 */

import {
  BaerlyError,
  CODE_RESOLUTIONS,
  type CurrentJson,
  currentRequestLedger,
  type RequestPool,
} from "@baerly/protocol";
import { getCurrentContext } from "./observability/context.ts";

/**
 * A host's read envelope. Every bound is optional; an absent bound is
 * unbounded. The adapter that owns the invocation sets it on the
 * observability context (`readEnvelope`) next to the request ledger, which
 * carries the storage-call bound.
 */
export interface ReadEnvelope {
  /** Snapshot body bytes (`current.json` `snapshot_bytes`) a read may load. */
  readonly maxSnapshotBytes?: number;
  /** Snapshot rows (`snapshot_rows`) a read may decode. */
  readonly maxSnapshotRows?: number;
  /** Live log entries at or past `log_seq_start` a read may load. */
  readonly maxTailEntries?: number;
  /** Sum of those entries' stored body bytes. */
  readonly maxTailBytes?: number;
  /**
   * Rows decoded before predicate, sort and limit: snapshot rows plus tail
   * entries. On the current layout a sorted `limit(n)` materializes every
   * row, so this bounds it independently of the output.
   */
  readonly maxMaterializedRows?: number;
  /** Rows in the answer. A count's answer is one number, so a count is not output-bounded. */
  readonly maxOutputRows?: number;
  /**
   * The request-ledger pool the host's storage charges: `"internal"` for
   * the R2 binding, `"external"` for storage reached through `fetch`. Sizes
   * the head check against what the ledger has left. Default `"internal"`,
   * the pool every storage call is charged to.
   */
  readonly requestPool?: RequestPool;
}

/** The serving host's read envelope; unbounded outside a context that sets one. */
export const currentReadEnvelope = (): ReadEnvelope => getCurrentContext()?.readEnvelope ?? {};

/**
 * Storage calls the active invocation's request ledger still allows on
 * `pool`; `Infinity` without a ledger.
 */
export const remainingStorageCalls = (pool: RequestPool = "internal"): number =>
  currentRequestLedger()?.remaining(pool) ?? Infinity;

const refuseRead = (collection: string, why: string, remedy: string): BaerlyError =>
  new BaerlyError(
    "CapacityExceeded",
    `this read of collection ${JSON.stringify(collection)} ${why}, more than one request can ` +
      `do on this host, so it was refused and returned no rows. ${remedy}`,
    { resolution: CODE_RESOLUTIONS.CapacityExceeded },
  );

const NARROW = "Narrow the predicate or add a limit.";
const TAIL =
  "The pending log folds into the snapshot as writes run maintenance; until then this read is refused.";
const OUTGROWN =
  "Delete or shrink rows, or export the collection with baerly admin dump and move it to a larger host.";

/**
 * One read's admission state. Built after the read GETs `current.json`;
 * {@link admitHead} runs before any other storage call, and the other
 * methods as the read stages its work. A refusal is always
 * `CapacityExceeded`, not retriable, with the code's canonical resolution.
 */
export class ReadBudget {
  readonly #collection: string;
  readonly #envelope: ReadEnvelope;
  #snapshotRows = 0;
  #tailEntries = 0;
  #tailBytes = 0;

  constructor(collection: string, envelope: ReadEnvelope = currentReadEnvelope()) {
    this.#collection = collection;
    this.#envelope = envelope;
  }

  /** The pool the host's storage charges; see {@link ReadEnvelope.requestPool}. */
  get requestPool(): RequestPool {
    return this.#envelope.requestPool ?? "internal";
  }

  /**
   * Refuse from the head alone when the read cannot fit (stage 1). Every
   * read folds up front: it loads the snapshot and walks the strict log
   * range `[log_seq_start, tail_hint)`. Every figure here is a lower bound
   * on the read's work, because `tail_hint` never passes the true tail.
   *
   * @throws BaerlyError code="CapacityExceeded"
   */
  admitHead(head: CurrentJson): void {
    const strict = Math.max(0, head.tail_hint - head.log_seq_start);
    if (strict > (this.#envelope.maxTailEntries ?? Infinity)) {
      throw this.#tailEntriesRefusal(strict);
    }
    this.admitSnapshot(head, strict);
    // The snapshot, the strict range, and the probe's closing empty slot.
    const calls = 1 + strict + (head.snapshot === null ? 0 : 1);
    const left = remainingStorageCalls(this.requestPool);
    if (calls > left) {
      throw refuseRead(
        this.#collection,
        `must issue at least ${calls} storage calls, over the ${left} this request has left`,
        `${TAIL} ${NARROW}`,
      );
    }
  }

  /**
   * Admit loading the snapshot `head` names, before its GET: its bytes and
   * rows, and its rows plus `pendingEntries` (the tail entries the read
   * will fold at least, beyond those already charged) toward
   * materialization.
   *
   * @throws BaerlyError code="CapacityExceeded"
   */
  admitSnapshot(head: CurrentJson, pendingEntries = 0): void {
    const env = this.#envelope;
    if (head.snapshot_bytes > (env.maxSnapshotBytes ?? Infinity)) {
      throw refuseRead(
        this.#collection,
        `must load a ${head.snapshot_bytes}-byte snapshot, over the ${env.maxSnapshotBytes} bytes it may load`,
        OUTGROWN,
      );
    }
    if (head.snapshot_rows > (env.maxSnapshotRows ?? Infinity)) {
      throw refuseRead(
        this.#collection,
        `must decode ${head.snapshot_rows} snapshot rows, over the ${env.maxSnapshotRows} it may decode`,
        OUTGROWN,
      );
    }
    this.#snapshotRows = head.snapshot_rows;
    this.#checkMaterialized(this.#tailEntries + pendingEntries);
  }

  /**
   * Charge one log entry's stored body before it is decoded (stage 2).
   * Bound so it can be passed as a callback.
   *
   * @throws BaerlyError code="CapacityExceeded"
   */
  readonly chargeTailBody = (bytes: number): void => {
    const env = this.#envelope;
    this.#tailEntries += 1;
    this.#tailBytes += bytes;
    if (this.#tailEntries > (env.maxTailEntries ?? Infinity)) {
      throw this.#tailEntriesRefusal(this.#tailEntries);
    }
    if (this.#tailBytes > (env.maxTailBytes ?? Infinity)) {
      throw refuseRead(
        this.#collection,
        `must load more than ${env.maxTailBytes} bytes of pending log entries`,
        TAIL,
      );
    }
    this.#checkMaterialized(this.#tailEntries);
  };

  /**
   * The refusal for a forward probe that ran out of request budget before
   * it found the tail.
   */
  readonly probeRefusal = (): BaerlyError =>
    refuseRead(
      this.#collection,
      `must probe more pending log entries than this request has storage calls left`,
      `${TAIL} ${NARROW}`,
    );

  /**
   * Refuse an answer over the output bound whole, never a truncated one.
   *
   * @throws BaerlyError code="CapacityExceeded"
   */
  admitOutput(rows: number): void {
    const max = this.#envelope.maxOutputRows ?? Infinity;
    if (rows > max) {
      throw refuseRead(
        this.#collection,
        `returns ${rows} rows, over the ${max} it may return`,
        NARROW,
      );
    }
  }

  #checkMaterialized(tailEntries: number): void {
    const rows = this.#snapshotRows + tailEntries;
    const max = this.#envelope.maxMaterializedRows ?? Infinity;
    if (rows > max) {
      throw refuseRead(
        this.#collection,
        `must decode at least ${rows} rows before filtering, over the ${max} it may decode`,
        `${NARROW} ${TAIL}`,
      );
    }
  }

  #tailEntriesRefusal(entries: number): BaerlyError {
    return refuseRead(
      this.#collection,
      `must load at least ${entries} pending log entries, over the ${this.#envelope.maxTailEntries} it may load`,
      TAIL,
    );
  }
}
