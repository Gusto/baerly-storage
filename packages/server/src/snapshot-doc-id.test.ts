import { fc, test as fcTest } from "@fast-check/vitest";
import { BaerlyError } from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import {
  docIdNearPairArb,
  invalidDocIdArb,
  validDocIdArb,
} from "../../../tests/fixtures/scalar-doc-id-arbitraries.ts";
import { encodeIndexValue } from "./indexes.ts";
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

/** Oracle 1: lexicographic order of the UTF-8 bytes, proper prefix first. */
const compareUtf8Bytes = (left: string, right: string): number =>
  Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));

/** Oracle 2: lexicographic order of the code-point arrays, proper prefix first. */
const compareCodePointArrays = (left: string, right: string): number => {
  const leftPoints = Array.from(left, (char) => char.codePointAt(0)!);
  const rightPoints = Array.from(right, (char) => char.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    if (leftPoints[index] !== rightPoints[index]) {
      return leftPoints[index]! < rightPoints[index]! ? -1 : 1;
    }
  }
  return sign(leftPoints.length - rightPoints.length);
};

/** `encodeIndexValue` output is ASCII base-32, so JS `<` is its byte order. */
const compareIndexEncodings = (left: string, right: string): number => {
  const leftKey = encodeIndexValue(left);
  const rightKey = encodeIndexValue(right);
  if (leftKey === rightKey) {
    return 0;
  }
  return leftKey < rightKey ? -1 : 1;
};

// The format contract hard-codes this ceiling; it is restated, not imported.
const CONTRACT_MAX_ID_BYTES = 256;
// eslint-disable-next-line no-control-regex -- intentional control-char class
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** Independent re-implementation of the document-ID domain. */
const oracleAccepts = (id: string): boolean =>
  id.isWellFormed() &&
  id.length > 0 &&
  !id.includes("/") &&
  id !== "." &&
  id !== ".." &&
  !CONTROL.test(id) &&
  !id.startsWith("_") &&
  Buffer.byteLength(id, "utf8") <= CONTRACT_MAX_ID_BYTES;

const rejectionCode = (id: string): string | undefined => {
  try {
    assertSnapshotDocId(id);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(BaerlyError);
    return (error as BaerlyError).code;
  }
};

const anyUtf16String = fc.string({
  unit: fc.integer({ min: 0, max: 0xffff }).map((unit) => String.fromCharCode(unit)),
});
const candidateArb = fc.oneof(
  validDocIdArb,
  invalidDocIdArb.map(({ id }) => id),
  fc.string(),
  fc.string({ unit: "binary" }),
  anyUtf16String,
);

describe("assertSnapshotDocId", () => {
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
    "\udc00\ud800",
  ])("rejects %j as InvalidConfig", (id) => {
    expect(rejectionCode(id)).toBe("InvalidConfig");
  });

  test.each(["ascii", "é", "e\u0301", "\u{1f4a9}"])("accepts %j", (id) => {
    expect(() => assertSnapshotDocId(id)).not.toThrow();
  });

  fcTest.prop({ id: candidateArb })(
    "accepts iff isWellFormed and the independent path-rule oracle accept",
    ({ id }) => {
      const code = rejectionCode(id);
      if (oracleAccepts(id)) {
        expect(code).toBeUndefined();
      } else {
        expect(code).toBe("InvalidConfig");
      }
    },
  );

  // One `[accepted at 256 bytes, rejected at 257 bytes]` pair per width of the
  // character that reaches the ceiling.
  test.each([
    ["1-byte tail", "a".repeat(255) + "z", "a".repeat(256) + "z"],
    ["2-byte tail", "a".repeat(254) + "é", "a".repeat(255) + "é"],
    ["3-byte tail", "a".repeat(253) + "\ufffd", "a".repeat(254) + "\ufffd"],
    ["4-byte tail", "a".repeat(252) + "\u{10000}", "a".repeat(253) + "\u{10000}"],
    ["all 2-byte", "é".repeat(128), "é".repeat(128) + "a"],
    ["all 3-byte", "\ue000".repeat(85) + "a", "\ue000".repeat(85) + "aa"],
    ["all 4-byte", "\u{1f600}".repeat(64), "\u{1f600}".repeat(64) + "a"],
    // The surrogate pair straddles the boundary: bytes 254–257.
    ["straddling pair", "a".repeat(252) + "\u{10ffff}", "a".repeat(253) + "\u{10ffff}"],
  ])("pins the 256-byte boundary (%s)", (_name, accepted, rejected) => {
    expect(Buffer.byteLength(accepted, "utf8")).toBe(256);
    expect(Buffer.byteLength(rejected, "utf8")).toBe(257);
    expect(rejectionCode(accepted)).toBeUndefined();
    expect(rejectionCode(rejected)).toBe("InvalidConfig");
  });

  test("rejects U+009F and accepts U+00A0", () => {
    expect(rejectionCode("a\u009f")).toBe("InvalidConfig");
    expect(rejectionCode("a\u00a0")).toBeUndefined();
  });

  test.each([
    "\ufffd",
    "\ufffe",
    "\uffff",
    "\ufdd0",
    "\ufdef",
    "\u{1fffe}",
    "\u{10ffff}",
    "\ufeff",
    "\u200b",
    "\u200d",
    "\u2028",
    "\u2029",
    "\ue000",
    "\u{f0000}",
    "\u0378",
    "...",
    ".a",
    "1",
  ])("admits the edge code point or name %j", (id) => {
    expect(rejectionCode(id)).toBeUndefined();
  });

  test("MAX_SEGMENT_BYTES is the format contract's 256-byte ID ceiling", () => {
    // format-contract §"Document-ID domain and `utf8-scalar-v1` order" fixes
    // IDs at "at most 256 UTF-8 bytes". Changing the constant changes the
    // durable ID domain: that is a format change, not a policy tweak.
    expect(MAX_SEGMENT_BYTES).toBe(256);
  });
});

describe("compareDocIds", () => {
  // The format contract's ordering vector, in `utf8-scalar-v1` order.
  const orderingTable = [
    ["A", "41"],
    ["a", "61"],
    ["aa", "6161"],
    ["e\u0301", "65cc81"],
    ["é", "c3a9"],
    ["\ufffd", "efbfbd"],
    ["\u{10000}", "f0908080"],
    ["\u{1f600}", "f09f9880"],
  ] as const;

  test("pins the format contract's ordering table and UTF-8 hex", () => {
    const ids = orderingTable.map(([id]) => id);
    for (const [id, hex] of orderingTable) {
      expect(Buffer.from(id, "utf8").toString("hex")).toBe(hex);
      expect(rejectionCode(id)).toBeUndefined();
    }
    for (let index = 1; index < ids.length; index++) {
      expect(compareDocIds(ids[index - 1]!, ids[index]!)).toBe(-1);
      expect(compareDocIds(ids[index]!, ids[index - 1]!)).toBe(1);
    }
    expect(ids.toReversed().toSorted(compareDocIds)).toEqual(ids);
  });

  test("diverges from JS < on high-BMP versus astral", () => {
    const jsLess = (left: string, right: string): boolean => left < right;
    expect(jsLess("\ufffd", "\u{10000}")).toBe(false);
    expect(compareDocIds("\ufffd", "\u{10000}")).toBe(-1);
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

  for (const [name, idArb] of [
    ["validDocIdArb", validDocIdArb],
    ["binary strings", fc.string({ unit: "binary" })],
  ] as const) {
    describe(`over ${name}`, () => {
      fcTest.prop({ left: idArb, right: idArb })(
        "returns exactly -1, 0, or 1",
        ({ left, right }) => {
          expect([-1, 0, 1]).toContain(compareDocIds(left, right));
        },
      );

      fcTest.prop({ left: idArb, right: idArb })("is 0 iff ===", ({ left, right }) => {
        expect(compareDocIds(left, left)).toBe(0);
        expect(compareDocIds(left, right) === 0).toBe(left === right);
      });

      fcTest.prop({ left: idArb, right: idArb })("is antisymmetric", ({ left, right }) => {
        expect(compareDocIds(right, left)).toBe(-compareDocIds(left, right) || 0);
      });

      fcTest.prop({ triple: fc.tuple(idArb, idArb, idArb) })(
        "is transitive on oracle-sorted triples",
        ({ triple }) => {
          const [low, mid, high] = triple.toSorted(compareUtf8Bytes);
          expect(compareDocIds(low!, mid!)).toBeLessThanOrEqual(0);
          expect(compareDocIds(mid!, high!)).toBeLessThanOrEqual(0);
          expect(compareDocIds(low!, high!)).toBeLessThanOrEqual(0);
          if (low !== mid || mid !== high) {
            expect(compareDocIds(low!, high!)).toBe(-1);
          }
        },
      );

      fcTest.prop({ prefix: idArb, suffix: fc.string({ unit: "binary", minLength: 1 }) })(
        "puts a proper prefix first",
        ({ prefix, suffix }) => {
          expect(compareDocIds(prefix, prefix + suffix)).toBe(-1);
        },
      );

      fcTest.prop({ left: idArb, right: idArb })(
        "agrees with the UTF-8 byte and code-point-array oracles",
        ({ left, right }) => {
          const actual = compareDocIds(left, right);
          expect(actual).toBe(compareUtf8Bytes(left, right));
          expect(actual).toBe(compareCodePointArrays(left, right));
        },
      );

      fcTest.prop({ left: idArb, right: idArb })(
        "agrees with encodeIndexValue's string order",
        ({ left, right }) => {
          expect(compareDocIds(left, right)).toBe(compareIndexEncodings(left, right));
        },
      );

      fcTest.prop({ ids: fc.array(idArb, { maxLength: 24 }) })(
        "sorts like the UTF-8 oracle, duplicates removed",
        ({ ids }) => {
          const unique = [...new Set(ids)];
          expect(unique.toSorted(compareDocIds)).toEqual(unique.toSorted(compareUtf8Bytes));
        },
      );
    });
  }

  fcTest.prop({ pair: docIdNearPairArb })(
    "agrees with both oracles on near-colliding pairs",
    ({ pair: { left, right } }) => {
      const actual = compareDocIds(left, right);
      expect(actual).not.toBe(0);
      expect(actual).toBe(compareUtf8Bytes(left, right));
      expect(actual).toBe(compareCodePointArrays(left, right));
      expect(actual).toBe(compareIndexEncodings(left, right));
    },
  );
});
