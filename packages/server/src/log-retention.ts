/**
 * Sequence-based log retention.
 *
 * Log keys are derivable, so retirement uses a half-open sequence range rather
 * than LIST-based discovery. This module computes the range and owns the
 * CAS-then-delete retirement pass. Every maintenance trigger runs it through
 * the shared `retireLogs` helper in `maintenance.ts`: `runScheduledMaintenance`
 * after its GC phase, and `runBoundedMaintenance` on the hard-GC early-return
 * path and as its final step.
 */

import {
  BaerlyError,
  casUpdateCurrentJson,
  certifiedDeleteFloor,
  type CurrentJson,
  LOG_RETENTION_MAX_DELETES_PER_TICK,
  LOG_RETENTION_SEQ_WINDOW,
  logDeleteFloorOf,
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
  const boundary = Math.min(liveFloor - window, liveFloor); // clamps a negative window seam only
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
   * Two states make {@link computeRetirableRange} return an empty range, so
   * the pass no-ops until a fold advances `log_seq_start` past the stored
   * floor plus the window: a raised window whose boundary drops below the
   * certified floor (the stored floor is at most `log_seq_start` here — the
   * transition validator throws `Internal` on anything above it), and a
   * stored floor genuinely above `log_seq_start`, reachable only via a
   * `restore --force` reseed or a legacy/hand-edited manifest, which
   * `certifiedDeleteFloor` clamps to `log_seq_start` per
   * `docs/spec/sync-protocol.md` invariant 12. Both are temporary stalls,
   * not permanent wedges — the next fold that clears the window unblocks
   * them.
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
 * that can shrink or erase the pre-image reach the window preserves
 * (`PREIMAGE_SCAN_MAX_GETS`) and steepen the retirement rate it limits (this
 * module's own `{window: 0}` tests push the floor to `log_seq_start`
 * exactly).
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
 *   module's own tests use `{window: 0}`) erases the pre-image reach and
 *   steepens the retirement rate described above; production call sites
 *   should omit it and take the default.
 * @param opts.maxDeletes Test seam that overrides
 *   {@link LOG_RETENTION_MAX_DELETES_PER_TICK}. Same caveat as `opts.window`:
 *   a scoped override for exercising the budget boundary in tests, not a
 *   knob meant to reach a config surface.
 * @throws BaerlyError{code:"Conflict"} if the floor CAS loses to another
 *   `current.json` writer, or if the fresh state authorizes nothing. The
 *   maintenance call sites' shared `retireLogs` helper (`maintenance.ts`)
 *   swallows exactly this code and re-throws everything else, matching how
 *   `Conflict` from `compact()` / `runGc()` is treated at every call site;
 *   returning it unwrapped here is what keeps that policy in one place.
 * @throws BaerlyError{code:"Internal"} if the floor CAS completes without
 *   having authorized the range it published — a wiring tripwire, not a
 *   runtime state. `retireLogs` re-throws it into `runBoundedMaintenance`'s
 *   outer catch (`db.maintenance.unexpected_error_total`), so the failure is
 *   observable rather than silent.
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

  let authorized: RetirableRange | undefined;
  const cas = await casUpdateCurrentJson(
    storage,
    currentJsonKey,
    (current: CurrentJson): CurrentJson => {
      // The mutator runs exactly once per call (see casUpdateCurrentJson's
      // JSDoc), so `authorized` after the await is the range this CAS just
      // validated — the assertion below trips on any wiring that lets the
      // CAS complete without one, rather than deleting unvalidated.
      authorized = computeRetirableRange(current, opts);
      if (authorized.start >= authorized.end) {
        throw new BaerlyError(
          "Conflict",
          `retireLogRange: ${currentJsonKey} authorizes no retirable range at CAS time; a concurrent writer moved log_seq_start`,
        );
      }
      return { ...current, log_delete_floor: authorized.end };
    },
    readOpts,
  );
  // Tripwire, not a runtime state: when the wiring is intact this is a
  // tautology (the mutator just returned `{...current, log_delete_floor:
  // authorized.end}`), but if it ever rots — a hoisted range computation, a
  // retry loop around the CAS — the DELETE loop below must not fall back to
  // the unvalidated advisory-gate range. Fail observable (`retireLogs`
  // re-throws this into the runner's unexpected-error counter) instead.
  if (authorized === undefined || logDeleteFloorOf(cas.json) !== authorized.end) {
    const published = logDeleteFloorOf(cas.json);
    const authorizedEnd = authorized === undefined ? "none" : String(authorized.end);
    throw new BaerlyError(
      "Internal",
      `retireLogRange: ${currentJsonKey}: the floor CAS published ${String(published)} against authorized end ${authorizedEnd}; refusing to DELETE a range the CAS never validated`,
    );
  }
  const range = authorized;

  // Idempotent DELETE on every in-tree Storage impl — a 404 is a no-op —
  // so a crash-leaked slot below the already-advanced floor stays leaked
  // regardless of ordering (leak, never corruption — the deliberate
  // fail-safe above). Parallel via Promise.all for the same reason the GC
  // sweep is: the DELETEs are independent, so serialization only adds
  // round-trip latency — up to `maxDeletes` serial trips on the Node
  // write-tick path, where the retirement pass runs inline on the commit
  // ack. One failure rejects the aggregate while the landed DELETEs stay
  // durable; the floor already authorizes every slot in the range.
  const collectionPrefix = currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"));
  await Promise.all(
    Array.from({ length: range.end - range.start }, (_, i) =>
      storage.delete(logObjectKey(collectionPrefix, range.start + i), readOpts),
    ),
  );
  return { deleted: range.end - range.start };
}
