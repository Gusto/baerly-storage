import { describe, expect, test } from "vitest";
import { decodeJsonBytes, encodeJsonBytes } from "./bytes.ts";
import type { LogEntry } from "./log.ts";

describe("encodeJsonBytes / decodeJsonBytes", () => {
  // Order-stable round-trip (premise P2 of log-conflict-adoption.ts):
  // the writer's lost-ack self-retry adopts via a full-entry
  // `JSON.stringify` equality of the read-back entry against the
  // attempted one. That equality holds ONLY because the encode/decode
  // idiom preserves key order — `JSON.stringify(JSON.parse(s))` keeps
  // document order. A future canonical/sorting encoder would re-order
  // keys, break the equality, and make a legitimate self-retry
  // duplicate-write. Keys here are deliberately NOT alphabetical so a
  // sorting encoder fails this test loudly.
  const entries: readonly LogEntry[] = [
    {
      lsn: "0fffff_abc_zz",
      commit_ts: "2026-05-10T00:00:00.000Z",
      op: "I",
      collection: "users",
      doc_id: "users/u_42",
      session: "abc",
      seq: 0,
      after: { zeta: 1, alpha: 2, mid: { name: "ada", id: 7 } },
    },
    {
      lsn: "0fffff_abc_zy",
      commit_ts: "2026-05-10T00:00:01.000Z",
      op: "U",
      collection: "users",
      doc_id: "users/u_42",
      session: "abc",
      seq: 1,
      after: { email: "ada@x" },
      origin: "replica-2",
    },
    {
      lsn: "0fffff_abc_zx",
      commit_ts: "2026-05-10T00:00:02.000Z",
      op: "D",
      collection: "users",
      doc_id: "users/u_42",
      session: "abc",
      seq: 2,
    },
  ];

  for (const e of entries) {
    test(`round-trip preserves key order for op:${e.op}`, () => {
      expect(JSON.stringify(decodeJsonBytes(encodeJsonBytes(e)))).toBe(JSON.stringify(e));
    });
  }
});
