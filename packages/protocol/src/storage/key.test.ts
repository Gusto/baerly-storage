import { describe, expect, test } from "vitest";
import { BaerlyError } from "../errors.ts";
import { assertValidStorageKey } from "./key.ts";

describe("assertValidStorageKey", () => {
  test("accepts ordinary keys, including dots that are not whole segments", () => {
    for (const key of [
      "a",
      "log/0000000001",
      "current.json",
      "content/deadbeef",
      "a.b",
      ".hidden",
      "trailing.",
      "manifests/tickets/index/by_status/open",
      "héllo🌍",
    ]) {
      expect(() => assertValidStorageKey(key)).not.toThrow();
    }
  });

  test('rejects a key whose only segment is "." or ".." — RFC 3986 dot-segment removal makes it unaddressable over HTTP', () => {
    for (const key of [".", ".."]) {
      let err: unknown;
      try {
        assertValidStorageKey(key);
      } catch (error) {
        err = error;
      }
      expect(err, `${JSON.stringify(key)} must reject`).toBeInstanceOf(BaerlyError);
      expect((err as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test('rejects any interior "." / ".." path segment', () => {
    for (const key of ["a/./b", "a/../b", "./a", "a/..", "../a", "a/."]) {
      expect(() => assertValidStorageKey(key)).toThrow(BaerlyError);
    }
  });

  test("rejects the empty key", () => {
    expect(() => assertValidStorageKey("")).toThrow(BaerlyError);
  });

  test("does not enforce the byte ceiling — that lives on the write path (assertKeyWithinLimit)", () => {
    expect(() => assertValidStorageKey("a".repeat(2048))).not.toThrow();
  });
});
