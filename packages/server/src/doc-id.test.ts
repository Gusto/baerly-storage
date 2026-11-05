import { test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";
import { BaerlyError } from "@baerly/protocol";
import { validDocIdArb } from "../../../tests/fixtures/scalar-doc-id-arbitraries.ts";
import { assertDocId, assertStoredDocId } from "./doc-id.ts";
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
    "cafe\u0301", // NFD: canonically equivalent to NFC "caf\u00e9"
    "\u212b", // ANGSTROM SIGN: NFC maps it to U+00C5
    "\u2126", // OHM SIGN: NFC maps it to U+03A9
    "q\u0307\u0323", // combining marks out of canonical order
    "\u1100\u1161", // conjoining jamo that NFC composes to U+AC00
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
    "caf\u00e9", // NFC unicode is fine
    "\u00c5", // NFC LATIN CAPITAL A WITH RING ABOVE
    "\ufb01le", // a compatibility ligature is NFC (only NFKC folds it)
    "\uff21", // FULLWIDTH A is NFC
    "A", // case is preserved: "A" and "a" are distinct ids
    "\u{1f600}", // astral
    "trailing ", // whitespace is allowed (trim rule dropped)
    " leading",
    "a".repeat(MAX_SEGMENT_BYTES), // exactly at the cap passes (pins the off-by-one)
  ])("accepts %j", (ok) => {
    expect(() => assertDocId(ok)).not.toThrow();
  });
});

describe("assertDocId — NFC", () => {
  fcTest.prop({ id: validDocIdArb })(
    "accepts a key-safe scalar id iff it is already NFC",
    ({ id }) => {
      const nfc = id === id.normalize("NFC");
      if (nfc) {
        expect(() => assertDocId(id)).not.toThrow();
      } else {
        expect(() => assertDocId(id)).toThrow(expect.objectContaining({ code: "InvalidConfig" }));
      }
    },
  );
});

describe("assertStoredDocId", () => {
  test.each(["cafe\u0301", "\u212b", "caf\u00e9", "user-42"])(
    "accepts the stored id %j whatever its normalization form",
    (id) => {
      expect(() => assertStoredDocId(id)).not.toThrow();
    },
  );

  test.each(["", "a/b", "..", "_internal", "with\u0000null"])(
    "still applies the key-segment rule to %j",
    (bad) => {
      expect(() => assertStoredDocId(bad)).toThrow(
        expect.objectContaining({ code: "InvalidConfig" }),
      );
    },
  );
});
