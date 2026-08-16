/**
 * Sequence-based log retention.
 *
 * Log keys are derivable, so retirement uses a half-open sequence range rather
 * than LIST-based discovery. This module computes the range and owns the
 * CAS-then-delete retirement pass. Nothing calls `retireLogRange` yet; PR 5
 * wires it into the two maintenance triggers and removes the `stale-log`
 * discovery it replaces.
 */

import {
  BaerlyError,
  casUpdateCurrentJson,
  certifiedDeleteFloor,
  type CurrentJson,
  LOG_RETENTION_MAX_DELETES_PER_TICK,
  LOG_RETENTION_SEQ_WINDOW,
  logObjectKey,
  logSeqStartOf,
  readCurrentJson,
  type Storage,
} from "@baerly/protocol";

/** A half-open `[start, end)` sequence range. Empty when equal. */
export interface RetirableRange {
  readonly start: number;
  readonly end: number;
}

/** Compute the budgeted prefix of the currently retirable log range. */
export const computeRetirableRange = (
  current: CurrentJson,
  opts?: { window?: number; maxDeletes?: number },
): RetirableRange => {
  const window = opts?.window ?? LOG_RETENTION_SEQ_WINDOW;
  const maxDeletes = opts?.maxDeletes ?? LOG_RETENTION_MAX_DELETES_PER_TICK;
  const liveFloor = logSeqStartOf(current);
  const start = certifiedDeleteFloor(current);
  const boundary = Math.min(liveFloor - window, liveFloor);
  const end = Math.max(start, Math.min(boundary, start + maxDeletes));
  return { start, end };
};

/** Outcome of one budgeted {@link retireLogRange} call. */
export interface RetireLogRangeResult {
  /**
   * Count of DELETEs issued this call — the authorized range's width. An
   * already-absent target is not an error (idempotent under crash-repeat, per
   * the {@link Storage} DELETE contract), so this is a request count, not a
   * count of objects that were physically present.
   *
   * This does NOT cover the call's full subrequest cost: an active pass also
   * issues 2 GETs (the advisory gate read, then {@link casUpdateCurrentJson}'s
   * own read) + 1 PUT (the floor CAS), and a no-op pass (empty gate) still
   * costs 1 GET. A caller budgeting against the 50-subrequest free-tier cap
   * that {@link LOG_RETENTION_MAX_DELETES_PER_TICK}'s JSDoc names — the
   * combined GC-sweep + fold + retirement total per tick — must add those
   * manifest round-trips itself; `deleted` alone undercounts.
   *
   * A stored `log_delete_floor` above `log_seq_start` (e.g. a raised window
   * outrunning a paused fold) makes {@link computeRetirableRange} return an
   * empty range, so the pass no-ops until the fold floor advances past that
   * floor plus the window. That is a temporary stall, not a permanent wedge —
   * the next fold that clears the window unblocks it.
   */
  readonly deleted: number;
}

/**
 * Delete a budgeted, computed slice of the stale log prefix and advance
 * `log_delete_floor` to match. Sequence-based: log keys are derivable, so this
 * never LISTs.
 *
 * **The authorized range is computed inside the CAS mutator, against the state
 * the CAS validates — do not hoist it out.** {@link casUpdateCurrentJson}
 * performs its own read and CASes against *that* etag, so a range computed from
 * an earlier read is a plan the CAS never validated. Computing it in the mutator
 * makes plan and validation atomic: whatever floor this call publishes is the
 * floor its own DELETEs are authorized by. If the fresh state yields an empty
 * range (a `restore --force` reseed lowered `log_seq_start` — the one writer
 * allowed to, `restore.ts:191-206`), the pass aborts with `Conflict` and zero
 * DELETEs rather than publishing a floor above the live one.
 *
 * **CAS before deleting, never after.** Every floor this function publishes
 * satisfies `end <= log_seq_start - window`, where `window` is the *effective*
 * window — {@link LOG_RETENTION_SEQ_WINDOW} by default, or `opts.window` when
 * a caller overrides it (via {@link computeRetirableRange}, which also clamps
 * a malformed stored floor per `docs/spec/sync-protocol.md` invariant 12).
 * That bound holds only at the default window: `opts.window` is a test seam
 * that can shrink or erase the safety margin entirely (this module's own
 * `{window: 0}` tests push the floor to `log_seq_start` exactly), so it is
 * never a guarantee a caller passing a non-default `window` gets to rely on.
 * `log_delete_floor` is monotone under the transition validator regardless of
 * `window`. So by the time a slot is physically deleted, a durable
 * certificate that it is gone already exists — which is what makes
 * `log_delete_floor` usable as a witness of "reclaimed" rather than "folded".
 * A crash between the CAS and the end of the DELETE loop leaks the remaining
 * slice permanently below the newly-advanced floor: deliberate, and the
 * fail-safe direction this program picked — leak, never corruption.
 *
 * The writer-side counterpart lives on the commit path, not here.
 * {@link LOG_RETENTION_SEQ_WINDOW} is a cost margin and a rate limit, never a
 * fence — see its JSDoc. What stops a paused or uncertain writer's create from
 * being acknowledged in a slot this pass has already retired is
 * `Writer#assertCommitAboveDeleteFloor`, which re-reads the manifest after the
 * committing create resolves and fails a sub-floor `seq` with
 * `BaerlyError{code:"AmbiguousCommit"}`. See
 * `docs/adr/002-ephemeral-coordination.md` § Closed paths for the two
 * approaches that were tried and rejected, and why that check is what remains.
 *
 * @param opts.signal Threaded to every storage call this makes (the gate
 *   read, the CAS's own read + write, and each DELETE in the loop) — an
 *   already-aborted signal, or one aborted mid-call, rejects the in-flight
 *   {@link Storage} operation.
 * @param opts.window Test seam that overrides {@link LOG_RETENTION_SEQ_WINDOW}.
 *   NOT a production tuning knob — do not promote this to an env var the way
 *   `BAERLY_MAINTENANCE_*` tunes the fold/GC budgets. Shrinking it (this
 *   module's own tests use `{window: 0}`) erases the safety margin described
 *   above; production call sites should omit it and take the default.
 * @param opts.maxDeletes Test seam that overrides
 *   {@link LOG_RETENTION_MAX_DELETES_PER_TICK}. Same caveat as `opts.window`:
 *   a scoped override for exercising the budget boundary in tests, not a
 *   knob meant to reach a config surface.
 * @throws BaerlyError{code:"Conflict"} if the floor CAS loses to another
 *   `current.json` writer, or if the fresh state authorizes nothing. Callers on
 *   the maintenance path already treat `Conflict` from `compact()` / `runGc()`
 *   as an expected, swallowed signal (`maintenance.ts:602-604`); this matches
 *   that idiom rather than swallowing it here.
 */
export async function retireLogRange(
  storage: Storage,
  currentJsonKey: string,
  opts?: { signal?: AbortSignal; window?: number; maxDeletes?: number },
): Promise<RetireLogRangeResult> {
  const readOpts = opts?.signal !== undefined ? { signal: opts.signal } : undefined;
  const read = await readCurrentJson(storage, currentJsonKey, readOpts);
  if (read === null) {
    return { deleted: 0 };
  }
  // Advisory gate only: skip the CAS's PUT when there is provably nothing to
  // do. The authorized range is the one computed in the mutator below.
  const gate = computeRetirableRange(read.json, opts);
  if (gate.start >= gate.end) {
    return { deleted: 0 };
  }

  let range = gate;
  await casUpdateCurrentJson(
    storage,
    currentJsonKey,
    (current: CurrentJson): CurrentJson => {
      // Reassigning the enclosing `range` from inside the mutator is only
      // sound because casUpdateCurrentJson invokes the mutator exactly once
      // per call (see its JSDoc: multiple invocations only happen if a
      // *caller* wraps it in a retry loop, and retireLogRange deliberately
      // does not). So the captured range here is always the one this CAS
      // just validated. A future caller that adds a retry loop around this
      // function must re-read the range from the call's result instead of
      // relying on this closure.
      range = computeRetirableRange(current, opts);
      if (range.start >= range.end) {
        throw new BaerlyError(
          "Conflict",
          `retireLogRange: ${currentJsonKey} authorizes no retirable range at CAS time; a concurrent writer moved log_seq_start`,
        );
      }
      return { ...current, log_delete_floor: range.end };
    },
    readOpts,
  );

  const collectionPrefix = currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"));
  for (let seq = range.start; seq < range.end; seq++) {
    await storage.delete(logObjectKey(collectionPrefix, seq), readOpts);
  }
  return { deleted: range.end - range.start };
}
