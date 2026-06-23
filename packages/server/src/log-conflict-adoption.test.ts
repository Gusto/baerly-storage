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
  after: { _id: "doc-1" },
  ...overrides,
});

const ctxOf = (parts: Partial<AdoptionContext>): AdoptionContext => ({
  self: makeEntry(),
  existing: makeEntry(),
  ...parts,
});

describe("tryAdoptOwnSessionLogEntry", () => {
  test("all adoption clauses hold: adopts the existing entry", () => {
    const existing = makeEntry();
    const decision = tryAdoptOwnSessionLogEntry(ctxOf({ existing }));
    expect(decision.adopt).toBe(true);
    if (decision.adopt) {
      // The existing entry is returned verbatim — caller substitutes
      // it for `self` so the CommitResult matches stored bytes.
      expect(decision.entry).toBe(existing);
    }
  });

  test("matching session and seq but different commit timestamp rejects", () => {
    const existing = makeEntry({ commit_ts: "2026-05-26T00:00:01.000Z" });
    const decision = tryAdoptOwnSessionLogEntry(ctxOf({ existing }));
    expect(decision).toEqual({ adopt: false, reason: "intent-mismatch" });
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

  test("clause (1) is checked before clause (2)", () => {
    // Foreign session + wrong seq → reason MUST be 'foreign-session'.
    // Documents the precedence so a future refactor can't silently
    // re-order the checks and weaken the patent-disclosure claim.
    const decision = tryAdoptOwnSessionLogEntry(
      ctxOf({ existing: makeEntry({ session: SESSION_B, seq: 99 }) }),
    );
    expect(decision).toEqual({ adopt: false, reason: "foreign-session" });
  });
});
