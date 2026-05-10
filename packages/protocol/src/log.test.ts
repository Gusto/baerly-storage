import { describe, expect, test } from "vitest";
import type { LogEntry, ReplicaIdentity } from "./log";
import { LOG_KEY_PREFIX, logKey, lsnParts } from "./log";
import { countKey } from "./types";

describe("LogEntry", () => {
  test("INSERT shape: new+patch present, no old", () => {
    const e: LogEntry = {
      lsn: "0fffff_abc_zz",
      commit_ts: "2026-05-10T00:00:00.000Z",
      op: "I",
      collection: "users",
      doc_id: "users/u_42",
      schema_version: 0,
      new: { email: "ada@x" },
      patch: { email: "ada@x" },
      session: "abc",
      seq: 0,
    };
    expect(e.old).toBeUndefined();
    expect(e.key_old).toBeUndefined();
    expect(e.new).toEqual(e.patch);
  });

  test("DELETE shape: no new/patch", () => {
    const e: LogEntry = {
      lsn: "0fffff_abc_zy",
      commit_ts: "2026-05-10T00:00:00.000Z",
      op: "D",
      collection: "users",
      doc_id: "users/u_42",
      schema_version: 0,
      session: "abc",
      seq: 1,
    };
    expect(e.new).toBeUndefined();
    expect(e.patch).toBeUndefined();
  });

  test("op accepts the documented union", () => {
    const ops: LogEntry["op"][] = ["I", "U", "D", "T", "M"];
    expect(ops).toHaveLength(5);
  });

  test("ReplicaIdentity is the documented union", () => {
    const a: ReplicaIdentity = "PATCH_ONLY";
    const b: ReplicaIdentity = "FULL";
    expect([a, b]).toEqual(["PATCH_ONLY", "FULL"]);
  });
});

describe("logKey", () => {
  test("composes <prefix>/log/<lsn>.json", () => {
    expect(logKey("manifest", "0fffff_abc_zz")).toBe(
      `manifest/${LOG_KEY_PREFIX}/0fffff_abc_zz.json`,
    );
  });

  test("LOG_KEY_PREFIX is 'log'", () => {
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
