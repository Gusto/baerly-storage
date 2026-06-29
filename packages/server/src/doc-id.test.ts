import { describe, expect, test } from "vitest";
import { BaerlyError } from "@baerly/protocol";
import { assertDocId } from "./doc-id.ts";
import { MAX_SEGMENT_BYTES } from "./path-segment.ts";

describe("assertDocId", () => {
  test.each([
    "", // empty
    "a/b", // injects an index-key path level
    "..", // path-segment trick
    "../victim", // traversal-shaped
    "x/../y", // embedded ..
    "_internal", // ADR-003 reserved namespace
    "with\u0000null", // control char (NUL)
    "tab\tchar", // control char (TAB)
  ])("rejects %j", (bad) => {
    expect(() => assertDocId(bad)).toThrow(BaerlyError);
    try {
      assertDocId(bad);
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("rejects overlong", () => {
    expect(() => assertDocId("a".repeat(MAX_SEGMENT_BYTES + 1))).toThrow(BaerlyError);
    try {
      assertDocId("a".repeat(MAX_SEGMENT_BYTES + 1));
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test.each([
    "01890a5d-ac96-774b-bcce-b302099a8057", // a UUIDv7
    "user-42",
    "note.2024", // dots inside a segment are fine
    "café", // NFC unicode is fine
    "trailing ", // whitespace is allowed (trim rule dropped)
    " leading",
    "a".repeat(MAX_SEGMENT_BYTES), // exactly at the cap passes (pins the off-by-one)
  ])("accepts %j", (ok) => {
    expect(() => assertDocId(ok)).not.toThrow();
  });
});
