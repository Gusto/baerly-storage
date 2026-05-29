import { describe, expect, test } from "vitest";
import { LOG_KEY_PREFIX, type LogEntry, lsnParts, type ReplicaIdentity } from "./log.ts";
import { countKey } from "./types.ts";

describe("LogEntry", () => {
  test("INSERT shape: new present, no old", () => {
    const e: LogEntry = {
      lsn: "0fffff_abc_zz",
      commit_ts: "2026-05-10T00:00:00.000Z",
      op: "I",
      collection: "users",
      doc_id: "users/u_42",
      new: { email: "ada@x" },
      session: "abc",
      seq: 0,
    };
    expect(e.old).toBeUndefined();
    expect(e.key_old).toBeUndefined();
    expect(e.new).toBeDefined();
  });

  test("DELETE shape: no new", () => {
    const e: LogEntry = {
      lsn: "0fffff_abc_zy",
      commit_ts: "2026-05-10T00:00:00.000Z",
      op: "D",
      collection: "users",
      doc_id: "users/u_42",
      session: "abc",
      seq: 1,
    };
    expect(e.new).toBeUndefined();
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

  test("throws on malformed lsn", () => {
    expect(() => lsnParts("not-an-lsn")).toThrow(/invalid lsn shape/);
    expect(() => lsnParts("only_two")).toThrow(/invalid lsn shape/);
    expect(() => lsnParts("a_b_c_d")).toThrow(/invalid lsn shape/);
  });
});
