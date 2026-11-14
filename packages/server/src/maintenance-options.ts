/**
 * Types for `runScheduledMaintenance` and the internal maintenance pass,
 * split out of `./maintenance.ts` so the published entry
 * (`./maintenance-entry.ts`) re-exports the three public types by name
 * while the `Internal*` pass options stay on unpublished subpaths.
 */
import type { Storage } from "@baerly/protocol";
import type { InternalCompactOptions } from "./compactor.ts";
import type { InternalRunGcOptions } from "./gc.ts";
import type { BoundedMaintenanceOptions } from "./maintenance.ts";

/** The collection one {@link runScheduledMaintenance} call maintains. */
export interface MaintenanceTarget {
  readonly storage: Storage;
  /** The same `app` the `Db` that writes this collection was created with. */
  readonly app: string;
  /** The same `tenant` the `Db` that writes this collection was created with. */
  readonly tenant: string;
  /** The collection name, as passed to `db.collection(name)`. */
  readonly collection: string;
}

/** Options for {@link runScheduledMaintenance}. All optional. */
export interface MaintenanceOptions {
  /**
   * The host this pass runs on, in the `BAERLY_MAINTENANCE_PROFILE`
   * vocabulary. `"cf-free"` and `"cf-paid"` cap one pass's work so it fits
   * one Workers invocation on that plan; `"node"` (the default) is
   * unbounded.
   */
  readonly tier?: "cf-free" | "cf-paid" | "node";
  /**
   * Run one phase instead of the whole pass. `"compact"` folds the
   * collection's recent writes; `"gc"` deletes data nothing references any
   * more. Omitted, the pass runs both and then retires old log entries.
   * Use it on Workers Free with storage reached over `fetch` (S3 over
   * HTTP), where a whole pass does not fit one invocation: alternate the
   * two phases across invocations.
   */
  readonly phase?: "compact" | "gc";
  /** Forwarded to every storage call. */
  readonly signal?: AbortSignal;
}

/** What one {@link runScheduledMaintenance} call did. */
export interface MaintenanceResult {
  /** Writes folded into the collection's compacted state. `0` when the pass did not compact. */
  readonly folded: number;
  /**
   * Present when there was work to fold but this pass folded none of it.
   * Nothing is lost; the next pass retries. `"contention"`: a concurrent
   * write or pass won the race. `"budget"`: the pass ran out of its
   * per-invocation budget while locating the latest writes; it saved its
   * progress, so later passes get further.
   */
  readonly deferred?: { readonly reason: "contention" | "budget" };
  /** Objects this pass deleted from storage. */
  readonly gcDeleted: number;
  /**
   * Objects marked for deletion that a later pass deletes once their grace
   * period ends. `0` when the pass did not run its GC phase.
   */
  readonly pending: number;
}

/**
 * The internal pass's options: the per-phase knobs the tiers set, plus
 * test seams. Surfaced via `@baerly/server/_internal/maintenance` and
 * `@baerly/server/_internal/testing`, neither of which is published.
 *
 * Publishing it would expose `gc.graceMillis`. `GC_GRACE_PERIOD_MILLIS`
 * documents that production MUST NOT go below the default outside a
 * maintenance window, since that risks deleting an anchor a writer is
 * about to find on retry. `0` is a perfectly valid number, so no input
 * validation can catch it; keeping the type unpublished is the only
 * control that works. Pinned by
 * `tests/integration/internal-types-unpublished.test.ts`.
 *
 * @internal
 */
export interface InternalMaintenanceOptions {
  /** @internal Forwarded to `compact()`. */
  readonly compact?: InternalCompactOptions;
  /** @internal Forwarded to `runGc()`. */
  readonly gc?: InternalRunGcOptions;
  /** @internal Log retention options (window size, max deletes per pass). */
  readonly logRetention?: LogRetentionOptions;
  /** Forwarded to every phase. */
  readonly signal?: AbortSignal;
}

/**
 * Log retention options for stale log retirement.
 *
 * @internal
 */
export interface LogRetentionOptions {
  /**
   * Retention window size (default: {@link LOG_RETENTION_SEQ_WINDOW}).
   * A test seam that overrides the default window; production callers
   * should omit it and take the default.
   */
  readonly window?: number;
  /**
   * Maximum DELETEs per maintenance pass (default:
   * {@link LOG_RETENTION_MAX_DELETES_PER_TICK}). A test seam for
   * exercising the budget boundary; production callers should omit it.
   */
  readonly maxDeletes?: number;
}

/**
 * {@link BoundedMaintenanceOptions} plus the host trigger an adapter may
 * thread into the write tick. Unpublished, like
 * {@link InternalMaintenanceOptions}: it is adapter wiring, not an app
 * or operator setting.
 *
 * @internal
 */
export interface InternalBoundedMaintenanceOptions extends BoundedMaintenanceOptions {
  /**
   * @internal Fold once the live tail reaches this many entries, whatever
   * the tail-to-snapshot ratio. Absent ⇒ only the ratio trigger (with the
   * `minEntriesToCompact` floor) folds. The Cloudflare adapter passes
   * `CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES` on Workers Free when storage is
   * reached through `fetch` rather than the R2 binding, where a write that
   * replays a ratio-length tail plus the fold it triggers would not fit in
   * one request.
   */
  readonly foldAtTailEntries?: number;
}
