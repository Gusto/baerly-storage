import { fc, test as fcTest } from "@fast-check/vitest";
import { BaerlyError } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { MAX_SEGMENT_BYTES } from "./path-segment.ts";
import { assertSnapshotDocId, compareDocIds } from "./snapshot-doc-id.ts";

const sign = (value: number): number => {
  if (value < 0) {
    return -1;
  }
  if (value > 0) {
    return 1;
  }
  return 0;
};

const encoder = new TextEncoder();
const compareUtf8Bytes = (left: string, right: string): number => {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const length = Math.min(leftBytes.length, rightBytes.length);
  for (let offset = 0; offset < length; offset++) {
    if (leftBytes[offset] !== rightBytes[offset]) {
      return leftBytes[offset]! < rightBytes[offset]! ? -1 : 1;
    }
  }
  return sign(leftBytes.length - rightBytes.length);
};

// `binary` spans Unicode scalar values, including astral code points, but
// excludes unpaired UTF-16 surrogates. It keeps all comparator properties in
// the `utf8-scalar-v1` domain.
const scalarStringArb = fc.string({ unit: "binary" });
const pathSafeScalarIdArb = fc
  .array(fc.constantFrom("a", "Z", "0", "-", ".", "é", "e", "\u0301", "\u{10000}"), {
    minLength: 1,
    maxLength: 50,
  })
  .map((units) => units.join(""))
  .filter((id) => id !== "." && id !== "..");

describe("snapshot document IDs", () => {
  test.each([
    "",
    "a/b",
    ".",
    "..",
    "../victim",
    "_internal",
    "with\u0000null",
    "tab\tchar",
    "del\u007fchar",
    "x".repeat(MAX_SEGMENT_BYTES + 1),
    "\ud800",
    "\udc00",
    "x\ud800",
    "\udc00x",
  ])("rejects %j as InvalidConfig", (id) => {
    expect(() => assertSnapshotDocId(id)).toThrow(BaerlyError);
    try {
      assertSnapshotDocId(id);
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test.each(["ascii", "é", "e\u0301", "\ud83d\udca9"])("accepts %j", (id) => {
    expect(() => assertSnapshotDocId(id)).not.toThrow();
  });

  test("orders ASCII, BMP, non-BMP, escaped scalars, and prefixes by utf8-scalar-v1", () => {
    for (const [left, right, expected] of [
      ["a", "aa", -1],
      ["a\\b", "aa", -1],
      ["e\u0301", "é", -1],
      ["\ue000", "\u{10000}", -1],
      ["\u{10000}", "\u{1f4a9}", -1],
    ] as const) {
      expect(compareDocIds(left, right)).toBe(expected);
    }
  });

  fcTest.prop({ id: pathSafeScalarIdArb })("accepts generated path-safe scalar IDs", ({ id }) => {
    expect(() => assertSnapshotDocId(id)).not.toThrow();
  });

  fcTest.prop({ left: scalarStringArb, right: scalarStringArb })(
    "is antisymmetric",
    ({ left, right }) => {
      const reverse = sign(compareDocIds(right, left));
      expect(sign(compareDocIds(left, right))).toBe(reverse === 0 ? 0 : -reverse);
    },
  );

  fcTest.prop({ left: scalarStringArb, middle: scalarStringArb, right: scalarStringArb })(
    "is transitive",
    ({ left, middle, right }) => {
      if (compareDocIds(left, middle) <= 0 && compareDocIds(middle, right) <= 0) {
        expect(compareDocIds(left, right)).toBeLessThanOrEqual(0);
      }
    },
  );

  fcTest.prop({ prefix: scalarStringArb, suffix: fc.string({ unit: "binary", minLength: 1 }) })(
    "puts a proper prefix first",
    ({ prefix, suffix }) => {
      expect(compareDocIds(prefix, prefix + suffix)).toBe(-1);
    },
  );

  fcTest.prop({ left: scalarStringArb, right: scalarStringArb })(
    "matches lexicographic UTF-8 byte order",
    ({ left, right }) => {
      expect(compareDocIds(left, right)).toBe(compareUtf8Bytes(left, right));
    },
  );
});
