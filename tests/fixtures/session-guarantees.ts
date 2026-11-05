/**
 * Session-guarantee predicates — the pure decision core the causal
 * cascade asserts against, promoted out of inline lambdas so each
 * invariant is a named, independently testable function rather than an
 * `expect(...)` buried in a concurrent async loop.
 *
 * The cascade fixture (`randomized-cascade.ts`) CALLS these, and the
 * unit suite (`tests/unit/session-guarantees.test.ts`) exercises them
 * deterministically — so the guard the cascade relies on and the guard
 * under test are the same function, with no reconstruction gap. A future
 * edit that silently defangs one of these invariants (e.g. a read that
 * resolves the wrong field so the comparison degrades to always-true)
 * fails the unit test, not just the probabilistic cascade.
 *
 * Guarantee IDs match the spec — see
 * `docs/spec/causal-consistency-checking.md` (SG-1/SG-2/SG-3).
 *
 * Pure module — no Node imports, no vitest — so it loads inside Workerd
 * alongside the cascade fixture and stays cheap to unit-test.
 */

import { BaerlyError } from "@baerly/protocol";

/**
 * SG-1 no-lost-writes: every commit that returned success must have its
 * won `log/<seq>` slot present in the durable committed-slot set. Returns
 * the acked slots MISSING from `committed` — an empty array means the
 * guarantee holds.
 */
export const missingAckedSlots = (
  acked: Iterable<number>,
  committed: ReadonlySet<number>,
): number[] => [...acked].filter((seq) => !committed.has(seq));

/**
 * SG-2 read-your-writes: a self-read issued right after a successful
 * commit must resolve a slot `>=` the one the commit won (LWW — a writer
 * never reads state older than its own write). `ownSeq` is `undefined`
 * when the self-read resolved nothing, which always violates the
 * guarantee.
 */
export const isReadYourWrite = (ownSeq: number | undefined, wonSeq: number): boolean =>
  ownSeq !== undefined && ownSeq >= wonSeq;

/**
 * SG-3 monotonic-reads: a client's resolved read slot never goes backward
 * on a strongly-consistent backend (the log is append-only and entries
 * are immutable, so the freshest matching slot only grows).
 */
export const isMonotonicRead = (observedSeq: number, lastObservedSeq: number): boolean =>
  observedSeq >= lastObservedSeq;

/**
 * Poll-loop read-error policy: reads in the cascade's observe loop
 * tolerate transient backend faults — a {@link BaerlyError} (the
 * node-minio variant flips its Toxiproxy proxy every 100 ms; R2
 * propagation jitter can briefly reject or return stale state) — and the
 * next tick retries. Anything else (notably a failed SG-3 assertion,
 * which throws a plain `Error`) is FATAL and must abort the cascade so it
 * surfaces as a rejection instead of hanging until the test timeout.
 *
 * This is the read-side policy only; the write-side policy is
 * {@link isUnacknowledgedCommitError}.
 */
export const isTransientReadError = (error: unknown): boolean => error instanceof BaerlyError;

/**
 * Commit-error policy for the cascades' write loops: the codes a
 * `Writer.commit()` may legally reject with under contention and fault
 * injection, where the cascade records the write as UNACKNOWLEDGED and
 * carries on.
 *
 * - `WriteConflict`: lost a race; not committed.
 * - `NetworkError`: the commit failed before a create of unknown fate
 *   (the Writer converts an unresolved create into `AmbiguousCommit`).
 * - `AmbiguousCommit`: the create may or may not be durable.
 *
 * The cascades never infer state from an unacknowledged commit: SG-1
 * asserts only acked slots, and every model read (the causal poll loop,
 * the multi-doc log walk) learns writes from storage. A write that
 * landed despite the error is observed like any other; one that didn't
 * is never claimed. Any other code (or a plain `Error`) is fatal.
 */
export const isUnacknowledgedCommitError = (error: unknown): boolean =>
  error instanceof BaerlyError &&
  (error.code === "WriteConflict" ||
    error.code === "NetworkError" ||
    error.code === "AmbiguousCommit");
