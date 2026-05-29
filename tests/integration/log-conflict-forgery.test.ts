/**
 * C2 session-id-unguessability adversarial property test.
 *
 * Threat model (cross-link
 * `packages/server/src/log-conflict-adoption.ts`): the adversary
 * owns bucket-write access (can plant arbitrary bytes at any key)
 * but cannot read the writer's local RAM and therefore cannot
 * observe the per-commit `session` id minted inside
 * `Writer.commit`. Under those constraints, the patent's C2 claim
 * is that no adversary-authored entry can ever be adopted by
 * `tryAdoptOwnSessionLogEntry`.
 *
 * This file exercises three layers of the claim:
 *
 *   A. **Decision-only sanity (documentary).** If we hand the
 *      adversary the writer's session id (counterfactually), the
 *      decision DOES adopt — proving the load-bearing premise is
 *      the unguessability of the session, not some other field
 *      check.
 *
 *   B. **Property (the load-bearing test).** For every 6-char hex
 *      forgery `s_adv` distinct from a freshly-minted writer
 *      session `s_writer`, `tryAdoptOwnSessionLogEntry` returns
 *      `{ adopt: false, reason: "foreign-session" }`. Runs at
 *      `numRuns: 1000` by default; `FC_NUM_RUNS=10000` for the
 *      hardening sweep.
 *
 *   C. **Integration through `Writer.commit` over
 *      `ForgeryStorage`.** Plant a forged entry at the writer's
 *      expected `log/0.json` key BEFORE the writer's PUT. The
 *      writer's `If-None-Match: "*"` PUT 412s, the writer reads
 *      back the planted body, adoption rejects (`foreign-session`),
 *      and the commit surfaces `BaerlyError{code:"Conflict"}` —
 *      never a successful commit returning the adversary's entry.
 */

import { fc } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import {
  BaerlyError,
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  type LogEntry,
  MemoryStorage,
  SESSION_ID_LENGTH,
  createCurrentJson,
  encodeJsonBytes,
  uuid,
} from "@baerly/protocol";
import {
  type AdoptionContext,
  Writer,
  tryAdoptOwnSessionLogEntry,
} from "@baerly/server/_internal/testing";
import { wrapForgeryStorage } from "../fixtures/forgery-storage.ts";

const HEX_CHARS = "0123456789abcdef";
const SESSION_A = "abc123";

/**
 * Mint a fresh writer-style session id the same way `Writer.commit`
 * does. Recreated inline (not exported as a kernel helper) so the
 * test pins the exact derivation path used in production.
 */
const mintSession = (): string => uuid().slice(0, SESSION_ID_LENGTH);

const makeEntry = (overrides: Partial<LogEntry> = {}): LogEntry => ({
  lsn: "z_abc123_z",
  commit_ts: "2026-05-26T00:00:00.000Z",
  op: "I",
  collection: "tickets",
  doc_id: "doc-1",
  session: SESSION_A,
  seq: 0,
  new: { _id: "doc-1" },
  ...overrides,
});

const ctxOf = (parts: Partial<AdoptionContext>): AdoptionContext => ({
  self: makeEntry(),
  existing: makeEntry(),
  batchSize: 1,
  ...parts,
});

describe("C2 session-id-unguessability under ForgeryStorage adversary", () => {
  test("decision-only: forged entry whose session string is byte-identical to the writer's session would adopt — the unsafety lives in the unguessability claim, not the decision", () => {
    // Sub-test A. If we hand the adversary the writer's session
    // (impossible under the stated threat model), adoption goes
    // through. The patent claim's load-bearing premise is that
    // `session` is unguessable, not that some downstream check
    // would catch the forgery.
    const seq = 42;
    const self = makeEntry({ session: SESSION_A, seq });
    const forged = makeEntry({
      session: SESSION_A,
      seq,
      doc_id: "adversary-doc",
      new: { _id: "adversary-doc" },
    });
    const decision = tryAdoptOwnSessionLogEntry(ctxOf({ self, existing: forged }));
    expect(decision).toEqual({ adopt: true, entry: forged });
  });

  test("property: an adversary that cannot read writer RAM cannot make tryAdoptOwnSessionLogEntry adopt", () => {
    // Sub-test B. For every 6-char hex forgery distinct from the
    // freshly-minted writer session, adoption rejects with
    // `foreign-session`. Hex-only matches the slice of
    // `crypto.randomUUID()` the writer actually uses.
    //
    // Default `numRuns` is 1000 (overrides the suite-wide 100 from
    // `tests/setup/fast-check.ts` so this load-bearing property
    // gets enough coverage by default). `FC_NUM_RUNS` overrides
    // that for the hardening sweep.
    const numRuns = process.env["FC_NUM_RUNS"] ? Number(process.env["FC_NUM_RUNS"]) : 1000;
    fc.assert(
      fc.property(
        fc.string({ unit: fc.constantFrom(...HEX_CHARS), minLength: 6, maxLength: 6 }),
        fc.integer({ min: 0, max: 100_000 }),
        (forgedSessionString, forgedSeq) => {
          const writerSession = mintSession();
          if (forgedSessionString === writerSession) {
            // Out-of-threat-model collision case (the adversary's
            // random bytes happened to match the writer's freshly-
            // minted session). Sub-test A documents this case; the
            // property test excludes it explicitly so a 1-in-16^6
            // collision can't shrink to a false positive.
            return true;
          }
          const self = makeEntry({ session: writerSession, seq: forgedSeq });
          const forged = makeEntry({ session: forgedSessionString, seq: forgedSeq });
          const decision = tryAdoptOwnSessionLogEntry({
            self,
            existing: forged,
            batchSize: 1,
          });
          return decision.adopt === false && decision.reason === "foreign-session";
        },
      ),
      { numRuns },
    );
  });

  test("integration: writer.commit() over ForgeryStorage surfaces Conflict, never a successful commit returning the forged entry", async () => {
    // Sub-test C. The unit-level decision tests can't see retry-loop
    // interactions. Under `ForgeryStorage`, the writer's PUT-with-
    // If-None-Match conflicts on the planted entry, the writer reads
    // it back, adoption rejects (foreign-session), and Writer.commit
    // surfaces BaerlyError{code:"Conflict"}. The forbidden outcome —
    // "successful commit returning the adversary's LogEntry" — must
    // never happen, regardless of retry budget (S3_REQUEST_MAX_RETRIES
    // = 8 by default).
    const TENANT_PREFIX = "app/a/tenant/t/manifests/c";
    const CURRENT_JSON_KEY = `${TENANT_PREFIX}/current.json`;
    const LOG_0_KEY = `${TENANT_PREFIX}/log/0.json`;
    const COLLECTION = "c";

    const seedCurrent = (): CurrentJson => ({
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "forgery-test", claimed_at: "" },
    });

    const inner = new MemoryStorage();
    await createCurrentJson(inner, CURRENT_JSON_KEY, seedCurrent());

    // Plant a forged entry whose session ("FORGED") cannot match
    // a uuid-derived writer session (which is lowercase hex).
    const forged: LogEntry = {
      lsn: "z_FORGED_z",
      commit_ts: "2026-05-26T00:00:00.000Z",
      op: "I",
      collection: COLLECTION,
      doc_id: "adv-doc",
      session: "FORGED",
      seq: 0,
      new: { _id: "adv-doc", from: "adversary" },
    };
    // Plant via inner.put so the writer's PUT-with-If-None-Match
    // sees a real 412 and reads back the forged body. The
    // ForgeryStorage GET-intercept is wired but not exercised in
    // this test (the inner store already serves the planted bytes);
    // its load-bearing role is documented at the fixture.
    await inner.put(LOG_0_KEY, encodeJsonBytes(forged), {
      contentType: "application/json",
    });

    const forgery = wrapForgeryStorage(inner);

    const writer = new Writer({
      storage: forgery.storage,
      currentJsonKey: CURRENT_JSON_KEY,
      // Fast-path retry budget so the test doesn't burn seconds
      // on backoff. The safety claim is about the OUTCOME (never
      // adopt the forged entry), not the retry count.
      options: { maxRetries: 1, initialBackoffMs: 0, random: () => 0 },
    });

    let caught: unknown;
    try {
      const result = await writer.commit({
        op: "I",
        collection: COLLECTION,
        docId: "writer-doc",
        body: { _id: "writer-doc", from: "writer" },
      });
      // If we ever reach here, the writer adopted the forged entry —
      // the patent-disclosure-shaped claim is violated.
      throw new Error(
        `writer.commit unexpectedly succeeded; returned entry: ${JSON.stringify(result.entry)}`,
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(BaerlyError);
    if (caught instanceof BaerlyError) {
      // The patent-disclosure-shaped safety claim: Writer.commit
      // never returns a successful CommitResult derived from a
      // forged entry. Surfacing Conflict — regardless of the
      // specific message — is the safe outcome. The intermediate
      // `foreign-session` reason is observed at the unit level by
      // `tryAdoptOwnSessionLogEntry`'s own test; the retry-loop
      // catches Conflict-coded errors and surfaces a top-level
      // "after N attempts" message, so the inner reason isn't
      // visible on the public surface.
      expect(caught.code).toBe("Conflict");
    }

    // Even after the commit fails, the forgery must still be in
    // place — pin the adversary-write surface (nothing in the
    // writer's failure path should rewrite the planted entry).
    const planted = await forgery.storage.get(LOG_0_KEY);
    expect(planted?.body).toEqual(encodeJsonBytes(forged));
  });
});
