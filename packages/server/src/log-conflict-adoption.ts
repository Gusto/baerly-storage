/**
 * Self-session log-conflict adoption — the one decision that
 * distinguishes a retry of our own prior commit attempt from a
 * peer racing us at the same `seq`.
 *
 * Background. `Writer.#singleAttemptCommit` PUTs each log entry with
 * `If-None-Match: "*"`. A 412 on `/log/<seq>.json` can mean either
 *
 *   (a) a peer wrote a DIFFERENT entry at the same seq — we lost
 *       the race; the caller's CAS will also fail; or
 *   (b) our OWN previous attempt landed the log PUT but lost the
 *       subsequent `current.json` CAS-advance, and we're now
 *       re-driving the same logical commit.
 *
 * This function makes the (a)/(b) call. It is callable, separately
 * testable, and patent-disclosable in isolation from the rest of the
 * commit path.
 *
 * ## Soundness invariant
 *
 * Adoption is sound iff all three hold:
 *
 *   1. **Same session.** `existing.session === self.session`. The
 *      session id is a per-commit, in-RAM-only secret minted at
 *      `Writer.commit` from `crypto.randomUUID().slice(0,
 *      SESSION_ID_LENGTH)`; an adversary with bucket-write access
 *      can forge any other field but cannot forge a value they
 *      did not observe being PUT.
 *   2. **Matching seq.** `existing.seq === self.expectedSeq`. The
 *      seq match is also implied by the key shape (the writer
 *      reads `/log/<expectedSeq>.json`), but is re-asserted here
 *      so the invariant is visible at the decision site.
 *   3. **Single-input commit.** `self.batchSize === 1`. Every
 *      commit is single-input now, so this always holds; the guard
 *      is retained as a defensive invariant (its removal is the
 *      deferred follow-up tracked as D1.5). It is sound only for a single-input
 *      commit because per-input adoption decisions would not
 *      compose with the all-or-nothing CAS-advance on
 *      `current.json`.
 *
 * When any of (1)/(2)/(3) fails, the writer MUST throw
 * `BaerlyError{code:"Conflict"}` and let the caller's retry-or-
 * surface logic run.
 *
 * ## Threat model
 *
 * The adversary may (a) write arbitrary bytes to any key in the
 * bucket, (b) replay any PUT they previously observed on the wire,
 * (c) reorder or drop network packets between the writer and the
 * bucket. The adversary may NOT (d) read the writer's local RAM
 * and therefore cannot learn the per-commit `session` id before
 * observing the writer's own `/log/<seq>.json` PUT. Under these
 * constraints, conditions (1)+(2)+(3) close every attack path in
 * the adversarial-replay property test
 * (`tests/integration/log-conflict-adversarial.test.ts`).
 *
 * **Pinned by:** `tests/integration/log-conflict-forgery.test.ts`
 * exercises the session-id-unguessability claim under a
 * `ForgeryStorage` adversary that plants arbitrary entries at the
 * writer's expected log key. Property verified by default at
 * `numRuns: 1000`; `FC_NUM_RUNS=10000` for the hardening sweep.
 *
 * ## Prior art
 *
 * SlateDB's manifest-pivot writer protocol (rfcs/0001-manifest.md,
 * scenarios 1–4) is the closest published prior art on the broader
 * commit-protocol skeleton. SlateDB's scenario 3 — "conflicting SST
 * has same `writer_epoch` as me" — is explicitly labelled an
 * **illegal state that should panic**. The three-clause adoption
 * decision encoded here (same session ∧ matching seq ∧ single-input)
 * recognises that case as the writer's own prior in-flight attempt
 * and adopts it as success rather than aborting, closing the recovery
 * gap SlateDB leaves to operator intervention.
 *
 * Apache Iceberg and Delta Lake commits surface analogous failures as
 * `CommitFailedException` / commit-conflict retries; neither inspects
 * the conflicting object to determine ownership.
 *
 * See `docs/spec/prior-art.md` for the consolidated IDS-shaped
 * differentiation.
 *
 * @see docs/spec/sync-protocol.md §"Contention and retries"
 */

import type { LogEntry } from "@baerly/protocol";

/**
 * Inputs to {@link tryAdoptOwnSessionLogEntry}. All fields are
 * required; the writer constructs this struct at the call site.
 */
export interface AdoptionContext {
  /**
   * The entry the writer just attempted to PUT. Carries the
   * writer's session, expected seq, and the rest of the LogEntry
   * shape minted in `Writer.#singleAttemptCommit` step 3.
   */
  readonly self: LogEntry;
  /**
   * The entry currently stored at `/log/<self.seq>.json`, as read
   * back after a 412. The caller is responsible for the GET (the
   * function is pure, no I/O).
   */
  readonly existing: LogEntry;
  /**
   * Input count of the parent commit attempt. Always `1` now —
   * `Writer.commit` is the only commit path and is single-input.
   * Adoption is only safe when this is exactly `1`; the field is
   * retained as a defensive invariant (removing it is the deferred
   * follow-up tracked as D1.5).
   */
  readonly batchSize: number;
}

/**
 * Discriminated outcome of {@link tryAdoptOwnSessionLogEntry}.
 * `adopt: true` carries the existing entry (which by the
 * invariant is byte-identical to `self` modulo `commit_ts`); the
 * caller substitutes it for `self` so the returned `CommitResult`
 * matches what's actually stored. `adopt: false` carries a
 * machine-readable `reason` so callers and tests can discriminate
 * which clause of the invariant failed.
 */
export type AdoptionDecision =
  | { readonly adopt: true; readonly entry: LogEntry }
  | { readonly adopt: false; readonly reason: "foreign-session" | "wrong-seq" | "batch" };

/**
 * Decide whether the entry already at `/log/<seq>.json` is the
 * writer's own prior in-flight attempt and may be adopted. Pure
 * function; no I/O. The caller performs the GET (when the log PUT
 * surfaces 412) and passes the read-back body in `ctx.existing`.
 *
 * @see {@link AdoptionDecision} for the return shape.
 * @see The soundness invariant in this module's header docstring.
 */
export const tryAdoptOwnSessionLogEntry = (ctx: AdoptionContext): AdoptionDecision => {
  // Clause (3) — single-input commit. Always holds now (every commit
  // is single-input); evaluated first as a defensive guard before any
  // field comparison.
  if (ctx.batchSize !== 1) {
    return { adopt: false, reason: "batch" };
  }
  // Clause (1) — same session.
  if (ctx.existing.session !== ctx.self.session) {
    return { adopt: false, reason: "foreign-session" };
  }
  // Clause (2) — matching seq. The seq is also implied by the
  // key the caller read from, but re-asserted here for
  // patent-disclosure clarity.
  if (ctx.existing.seq !== ctx.self.seq) {
    return { adopt: false, reason: "wrong-seq" };
  }
  return { adopt: true, entry: ctx.existing };
};
