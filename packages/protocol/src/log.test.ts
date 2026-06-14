import { describe, expect, test } from "vitest";
import { COUNT_BIT_WIDTH } from "./constants.ts";
import {
  LOG_KEY_PREFIX,
  type LogEntry,
  logObjectKey,
  lsnParts,
  type ReplicaIdentity,
} from "./log.ts";
import { countKey, str2uintDesc } from "./types.ts";

describe("LogEntry", () => {
  test("INSERT shape: after present, no before", () => {
    const e: LogEntry = {
      lsn: "0fffff_abc_zz",
      commit_ts: "2026-05-10T00:00:00.000Z",
      op: "I",
      collection: "users",
      doc_id: "users/u_42",
      after: { email: "ada@x" },
      session: "abc",
      seq: 0,
    };
    expect(e.before).toBeUndefined();
    expect(e.key_old).toBeUndefined();
    expect(e.after).toBeDefined();
  });

  test("DELETE shape: no after", () => {
    const e: LogEntry = {
      lsn: "0fffff_abc_zy",
      commit_ts: "2026-05-10T00:00:00.000Z",
      op: "D",
      collection: "users",
      doc_id: "users/u_42",
      session: "abc",
      seq: 1,
    };
    expect(e.after).toBeUndefined();
  });

  test("op accepts the documented union", () => {
    const ops: LogEntry["op"][] = ["I", "U", "D"];
    expect(ops).toHaveLength(3);
  });

  test("ReplicaIdentity is the documented union", () => {
    const a: ReplicaIdentity = "PATCH_ONLY";
    const b: ReplicaIdentity = "FULL";
    expect([a, b]).toEqual(["PATCH_ONLY", "FULL"]);
  });
});

describe("LOG_KEY_PREFIX", () => {
  test("is 'log'", () => {
    expect(LOG_KEY_PREFIX).toBe("log");
  });
});

describe("logObjectKey", () => {
  // Byte-identical guarantee: this literal is the key shape that every
  // caller (db / writer / gc / log-walk) must produce. Ticket 01 flips
  // the meaning of the trailing integer; this pins the shape until then.
  test("composes <prefix>/log/<seq>.json", () => {
    expect(logObjectKey("apps/_/tenants/_/manifests/users", 7)).toBe(
      "apps/_/tenants/_/manifests/users/log/7.json",
    );
  });
});

describe("lsnParts", () => {
  test("splits session and decodes seq", () => {
    // countKey(0) is the seq for the first write in a session.
    const lsn = `0fffff_abc123_${countKey(0)}`;
    const { session, seq } = lsnParts(lsn);
    expect(session).toBe("abc123");
    expect(seq).toBe(0);
  });

  test("round-trips against countKey across a range", () => {
    for (const n of [0, 1, 2, 17, 256, 1023]) {
      const lsn = `0fffff_sess_${countKey(n)}`;
      expect(lsnParts(lsn).seq).toBe(n);
    }
  });

  // Regression: seq overflow at 1024 — countKey(1024) used to produce "-1"
  // which the LSN_RE validator rejected, killing the change feed.
  test("round-trips past seq 1023 without overflow (regression for seq overflow bug)", () => {
    for (const n of [1024, 2048, 100_000, Number.MAX_SAFE_INTEGER]) {
      const encoded = countKey(n);
      // Must not produce a negative-number string ("-1", "-101", etc.)
      expect(encoded).not.toMatch(/^-/);
      // Must be decodable back to the original value
      const lsn = `0fffff_sess_${encoded}`;
      expect(lsnParts(lsn).seq).toBe(n);
    }
  });

  test("throws on malformed lsn", () => {
    expect(() => lsnParts("not-an-lsn")).toThrow(/invalid lsn shape/);
    expect(() => lsnParts("only_two")).toThrow(/invalid lsn shape/);
    expect(() => lsnParts("a_b_c_d")).toThrow(/invalid lsn shape/);
  });

  test("error message includes the invalid lsn value", () => {
    // This test ensures that the error message prefix "invalid lsn shape: "
    // is not mutated to an empty string. If the string literal is changed to "",
    // the error would just contain the lsn value, not the descriptive prefix.
    expect(() => lsnParts("bad_format")).toThrow("invalid lsn shape: bad_format");
  });

  test("error has InvalidResponse code", () => {
    // This test ensures that the error code string literal "InvalidResponse"
    // is not mutated to an empty string. We check that the error is specifically
    // a BaerlyError with code "InvalidResponse", not some other code.
    try {
      lsnParts("malformed");
      expect.fail("should have thrown");
    } catch (error) {
      const err = error as any;
      expect(err.code).toBe("InvalidResponse");
    }
  });
});

describe("countKey — seq segment encoding", () => {
  // The seq segment of an LSN uses a descending fixed-width base-32 encoding
  // so that S3 forward-list yields entries in reverse-causal order.
  // This suite pins the correctness properties the rest of the protocol
  // relies on.

  test("round-trips through str2uintDesc for boundary and large values", () => {
    // COUNT_BIT_WIDTH imported from constants.ts — no hand-copied literal
    // so this test auto-fails if the constant is changed without updating
    // the encoder/decoder pair.
    for (const n of [0, 1, 1023, 1024, 100_000, Number.MAX_SAFE_INTEGER]) {
      const encoded = countKey(n);
      const decoded = str2uintDesc(encoded, COUNT_BIT_WIDTH);
      expect(decoded).toBe(n);
    }
  });

  test("every produced key consists only of base-32 chars [0-9a-v]", () => {
    const BASE32_RE = /^[0-9a-v]+$/;
    for (const n of [0, 1, 1023, 1024, 2048, 100_000, Number.MAX_SAFE_INTEGER]) {
      expect(countKey(n)).toMatch(BASE32_RE);
    }
  });

  test("descending lex order is preserved: countKey(a) > countKey(b) when a < b", () => {
    // The reverse-walk on the log depends on this invariant.
    const pairs: [number, number][] = [
      [0, 1],
      [1, 2],
      [0, 1023],
      [0, 1024],
      [1023, 1024],
      [1024, 1025],
      [0, Number.MAX_SAFE_INTEGER],
      [100_000, 200_000],
    ];
    for (const [a, b] of pairs) {
      // a < b  →  countKey(a) should be lex-GREATER than countKey(b)
      expect(countKey(a) > countKey(b)).toBe(true);
    }
  });

  test("all keys produced across a range have equal length (fixed-width)", () => {
    const samples = [0, 1, 1023, 1024, 100_000, Number.MAX_SAFE_INTEGER];
    const lengths = samples.map((n) => countKey(n).length);
    // All values must produce the same character count.
    const firstLen = lengths[0]!;
    for (const len of lengths) {
      expect(len).toBe(firstLen);
    }
    // After widening to 53 bits, the expected width is ceil(53/5) = 11.
    expect(firstLen).toBe(11);
  });
});
