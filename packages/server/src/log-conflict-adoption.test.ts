import { describe, expect, test } from "vitest";
import type { LogEntry } from "@baerly/protocol";
import { type AdoptionContext, tryAdoptOwnSessionLogEntry } from "./log-conflict-adoption.ts";

const SESSION_A = "abc123";
const SESSION_B = "def456";

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

describe("tryAdoptOwnSessionLogEntry", () => {
  test("clause (1)+(2)+(3) all hold: adopts the existing entry", () => {
    const existing = makeEntry({ commit_ts: "2026-05-26T00:00:01.000Z" });
    const decision = tryAdoptOwnSessionLogEntry(ctxOf({ existing }));
    expect(decision.adopt).toBe(true);
    if (decision.adopt) {
      // The existing entry is returned verbatim — caller substitutes
      // it for `self` so the CommitResult matches stored bytes.
      expect(decision.entry).toBe(existing);
    }
  });

  test("clause (1) fails: foreign session → reject with reason 'foreign-session'", () => {
    const decision = tryAdoptOwnSessionLogEntry(
      ctxOf({ existing: makeEntry({ session: SESSION_B }) }),
    );
    expect(decision).toEqual({ adopt: false, reason: "foreign-session" });
  });

  test("clause (2) fails: mismatched seq → reject with reason 'wrong-seq'", () => {
    const decision = tryAdoptOwnSessionLogEntry(ctxOf({ existing: makeEntry({ seq: 1 }) }));
    expect(decision).toEqual({ adopt: false, reason: "wrong-seq" });
  });

  test("clause (3) fails: batched commit → reject with reason 'batch'", () => {
    const decision = tryAdoptOwnSessionLogEntry(ctxOf({ batchSize: 2 }));
    expect(decision).toEqual({ adopt: false, reason: "batch" });
  });

  test("clause (3) is checked first — batch + foreign session still reports 'batch'", () => {
    // Evaluation order matters for the patent-disclosure narrative:
    // a batched commit must NEVER reach the field comparison, so
    // even a same-session same-seq existing entry inside a batch
    // surfaces as 'batch' (not as adopt: true).
    const decision = tryAdoptOwnSessionLogEntry(
      ctxOf({ batchSize: 2, existing: makeEntry({ session: SESSION_B }) }),
    );
    expect(decision).toEqual({ adopt: false, reason: "batch" });
  });

  test("clause (1) is checked before clause (2)", () => {
    // Foreign session + wrong seq → reason MUST be 'foreign-session'.
    // Documents the precedence so a future refactor can't silently
    // re-order the checks and weaken the patent-disclosure claim.
    const decision = tryAdoptOwnSessionLogEntry(
      ctxOf({ existing: makeEntry({ session: SESSION_B, seq: 99 }) }),
    );
    expect(decision).toEqual({ adopt: false, reason: "foreign-session" });
  });

  test("batchSize: 0 (empty inputs, defensive) → reject with reason 'batch'", () => {
    // Empty-inputs path is short-circuited in commitBatch before
    // this helper is ever called, but the helper itself MUST
    // refuse a non-1 batchSize unconditionally.
    const decision = tryAdoptOwnSessionLogEntry(ctxOf({ batchSize: 0 }));
    expect(decision).toEqual({ adopt: false, reason: "batch" });
  });
});
