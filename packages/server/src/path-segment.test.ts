import { describe, expect, test } from "vitest";
import { BaerlyError } from "@baerly/protocol";
import { assertPathSegment, MAX_SEGMENT_BYTES } from "./path-segment.ts";

describe("assertPathSegment", () => {
  test.each([
    "", // empty
    "a/b", // contains separator
    ".", // path-segment trick
    "..", // traversal
    "../victim", // traversal-shaped
    "x/../y", // embedded ..
    "_internal", // ADR-007 reserved
    "with\u0000null", // C0 control (NUL) - escape, never a literal byte
    "tab\tchar", // C0 control (TAB)
    "del\u007fchar", // DEL / C1
    "x".repeat(MAX_SEGMENT_BYTES + 1), // overlong
  ])("rejects %j as InvalidConfig", (bad) => {
    expect(() => assertPathSegment(bad, "collection", "test")).toThrow(BaerlyError);
    try {
      assertPathSegment(bad, "collection", "test");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test.each([
    "tickets",
    "a.b.c", // dots that are not . or ..
    "\u00e9\u00e8", // non-ASCII letters allowed
    "x".repeat(MAX_SEGMENT_BYTES), // exactly at the cap
  ])("accepts %j", (ok) => {
    expect(() => assertPathSegment(ok, "collection", "test")).not.toThrow();
  });

  test("error message names the role", () => {
    expect.assertions(1);
    try {
      assertPathSegment("..", "tenant", "Db.create");
    } catch (error) {
      expect((error as BaerlyError).message).toContain("tenant");
    }
  });
});
