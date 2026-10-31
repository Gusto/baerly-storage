import { fc } from "@fast-check/vitest";

/**
 * Shared arbitraries for the `utf8-scalar-v1` document-ID domain (format
 * contract §"Document-ID domain and `utf8-scalar-v1` order"): a Unicode
 * scalar-value string that is non-empty, has no `/`, is neither `.` nor `..`,
 * has no C0/DEL/C1 control, does not begin with `_`, and is at most 256 UTF-8
 * bytes.
 *
 * The pool deliberately spans U+E000–U+FFFF. That is the only range where
 * code-point order and JS `<` (UTF-16 code-unit order) disagree, so a suite
 * that orders IDs with `<` instead of `compareDocIds` goes red on these
 * values.
 *
 * Every domain exclusion is applied by construction, never with `filter`, so
 * shrinking stays inside the domain.
 */

/** The format contract's per-ID byte ceiling, restated here independently. */
export const DOC_ID_MAX_UTF8_BYTES = 256;

const codePointRange = (min: number, max: number): fc.Arbitrary<number> => fc.integer({ min, max });

// Printable ASCII: U+0020–U+007E without `/` (U+002F).
const asciiBody = fc.oneof(
  codePointRange(0x20, 0x2e),
  codePointRange(0x30, 0x7e),
  fc.constantFrom(0x2e, 0x5f, 0x41, 0x61), // ".", "_", "A", "a"
);
// The same, also without `_` (U+005F): the ADR-003 reserved leading char.
const asciiLeading = fc.oneof(
  codePointRange(0x20, 0x2e),
  codePointRange(0x30, 0x5e),
  codePointRange(0x60, 0x7e),
  fc.constantFrom(0x2e, 0x41, 0x61),
);
// U+00A0 is the first code point after the C1 block.
const twoByte = fc.oneof(fc.constant(0xe9), codePointRange(0xa0, 0x7ff));
const combining = fc.oneof(fc.constant(0x301), codePointRange(0x300, 0x36f));
const lowBmpThreeByte = codePointRange(0x800, 0xd7ff);
const highBmp = fc.oneof(
  fc.constantFrom(0xfffd, 0xffff, 0xfffe, 0xe000, 0xfeff),
  codePointRange(0xe000, 0xffff),
);
const astral = fc.oneof(
  fc.constantFrom(0x10000, 0x1f600, 0x10ffff),
  codePointRange(0x10000, 0x10ffff),
);
// Noncharacters plus the zero-width, BOM, and line/paragraph separators the
// contract admits.
const edge = fc.constantFrom(
  0xfdd0,
  0xfdef,
  0xfffe,
  0xffff,
  0x1fffe,
  0x10fffe,
  0x10ffff,
  0xfeff,
  0x200b,
  0x200d,
  0x2028,
  0x2029,
);

const nonAscii = [twoByte, combining, lowBmpThreeByte, highBmp, astral, edge] as const;
const bodyCodePoint = fc.oneof(
  { weight: 4, arbitrary: asciiBody },
  ...nonAscii.map((arbitrary) => ({ weight: 1, arbitrary })),
);
const leadingCodePoint = fc.oneof(
  { weight: 4, arbitrary: asciiLeading },
  ...nonAscii.map((arbitrary) => ({ weight: 1, arbitrary })),
);

/** UTF-8 width of one scalar value. */
export const utf8Width = (codePoint: number): number => {
  if (codePoint < 0x80) {
    return 1;
  }
  if (codePoint < 0x800) {
    return 2;
  }
  return codePoint < 0x10000 ? 3 : 4;
};

/**
 * Join code points, keeping the longest prefix that fits `budget` UTF-8
 * bytes, and rewrite a leading `.` of an all-dot `.` / `..` result so the
 * value is never exactly `.` or `..`. Length is preserved by that rewrite.
 */
const finish = (codePoints: readonly number[], budget: number): string => {
  let bytes = 0;
  let out = "";
  for (const codePoint of codePoints) {
    bytes += utf8Width(codePoint);
    if (bytes > budget) {
      break;
    }
    out += String.fromCodePoint(codePoint);
  }
  return out === "." || out === ".." ? `a${out.slice(1)}` : out;
};

export interface ValidDocIdOptions {
  /** Upper bound on code points in the short mode. Default 24. */
  readonly maxCodePoints?: number;
  /** Mix in a mode biased toward the 250–256-byte band. Default `true`. */
  readonly longBand?: boolean;
}

const shortDocIdArb = (maxCodePoints: number): fc.Arbitrary<string> =>
  fc
    .tuple(leadingCodePoint, fc.array(bodyCodePoint, { maxLength: maxCodePoints - 1 }))
    .map(([head, tail]) => finish([head, ...tail], DOC_ID_MAX_UTF8_BYTES));

// 256 code points are at least 256 bytes, so truncation to `target` always
// lands within 3 bytes of it: the band is 247–256 bytes, mostly 250–256.
const longDocIdArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.integer({ min: 250, max: DOC_ID_MAX_UTF8_BYTES }),
    leadingCodePoint,
    fc.array(bodyCodePoint, {
      minLength: DOC_ID_MAX_UTF8_BYTES - 1,
      maxLength: DOC_ID_MAX_UTF8_BYTES - 1,
    }),
  )
  .map(([target, head, tail]) => finish([head, ...tail], target));

/** A `validDocIdArb` with custom size bounds; see {@link ValidDocIdOptions}. */
export const makeValidDocIdArb = ({
  maxCodePoints = 24,
  longBand = true,
}: ValidDocIdOptions = {}): fc.Arbitrary<string> =>
  longBand
    ? fc.oneof(
        { weight: 4, arbitrary: shortDocIdArb(maxCodePoints) },
        { weight: 1, arbitrary: longDocIdArb },
      )
    : shortDocIdArb(maxCodePoints);

/**
 * Domain-valid document IDs: ASCII, two-byte, combining, high-BMP (always
 * including U+FFFD and U+FFFF), astral, and noncharacter code points, with a
 * length mode biased toward the 256-byte ceiling.
 */
export const validDocIdArb: fc.Arbitrary<string> = makeValidDocIdArb();

const shortValid = makeValidDocIdArb({ maxCodePoints: 8, longBand: false });
const shortBody = fc
  .array(bodyCodePoint, { maxLength: 8 })
  .map((codePoints) => String.fromCodePoint(...codePoints));

/** The single domain rule an `invalidDocIdArb` value breaks. */
export type InvalidDocIdRule =
  | "unpaired-high-surrogate"
  | "unpaired-low-surrogate"
  | "reversed-surrogate-pair"
  | "c0-control"
  | "del-control"
  | "c1-control"
  | "slash"
  | "dot"
  | "dot-dot"
  | "leading-underscore"
  | "empty"
  | "too-long";

export interface InvalidDocId {
  readonly rule: InvalidDocIdRule;
  /** Where the offending unit sits, or the width of the last char for `too-long`. */
  readonly detail: string;
  readonly id: string;
}

type Position = "start" | "middle" | "end";

/** Place `bad` at the start, middle, or end of otherwise-valid content. */
const placed = (rule: InvalidDocIdRule, bad: fc.Arbitrary<string>): fc.Arbitrary<InvalidDocId> =>
  fc
    .tuple(fc.constantFrom<Position>("start", "middle", "end"), bad, shortValid, shortBody)
    .map(([position, unit, head, tail]) => {
      if (position === "start") {
        return { rule, detail: position, id: unit + tail };
      }
      return {
        rule,
        detail: position,
        id: position === "middle" ? head + unit + tail : head + unit,
      };
    });

const codeUnit = (min: number, max: number): fc.Arbitrary<string> =>
  codePointRange(min, max).map((unit) => String.fromCharCode(unit));

const tooLong = (width: 1 | 2 | 3 | 4, last: fc.Arbitrary<number>): fc.Arbitrary<InvalidDocId> =>
  fc
    .tuple(
      leadingCodePoint,
      fc.array(bodyCodePoint, {
        minLength: DOC_ID_MAX_UTF8_BYTES,
        maxLength: DOC_ID_MAX_UTF8_BYTES,
      }),
      last,
    )
    .map(([head, tail, lastCodePoint]) => {
      const budget = DOC_ID_MAX_UTF8_BYTES + 1 - width;
      const body = finish([head, ...tail], budget);
      const padded = body + "a".repeat(budget - new TextEncoder().encode(body).length);
      return {
        rule: "too-long" as const,
        detail: `${width}-byte last char`,
        id: padded + String.fromCodePoint(lastCodePoint),
      };
    });

/**
 * Values outside the domain, each tagged with the one rule it breaks. Every
 * other rule holds for the value, so a validator that drops a rule accepts
 * the values tagged with it.
 */
export const invalidDocIdArb: fc.Arbitrary<InvalidDocId> = fc.oneof(
  placed("unpaired-high-surrogate", codeUnit(0xd800, 0xdbff)),
  placed("unpaired-low-surrogate", codeUnit(0xdc00, 0xdfff)),
  placed(
    "reversed-surrogate-pair",
    fc.tuple(codeUnit(0xdc00, 0xdfff), codeUnit(0xd800, 0xdbff)).map(([low, high]) => low + high),
  ),
  placed("c0-control", codeUnit(0x00, 0x1f)),
  placed("del-control", fc.constant("\u007f")),
  placed("c1-control", codeUnit(0x80, 0x9f)),
  placed("slash", fc.constant("/")),
  fc.constant({ rule: "dot" as const, detail: "exact", id: "." }),
  fc.constant({ rule: "dot-dot" as const, detail: "exact", id: ".." }),
  shortBody.map((tail) => ({
    rule: "leading-underscore" as const,
    detail: "start",
    id: `_${tail}`,
  })),
  fc.constant({ rule: "empty" as const, detail: "exact", id: "" }),
  tooLong(1, asciiBody),
  tooLong(2, twoByte),
  tooLong(3, fc.oneof(lowBmpThreeByte, highBmp)),
  tooLong(4, astral),
);

/** How a `docIdNearPairArb` pair was built to collide. */
export type DocIdNearPairKind = "normalization" | "case" | "proper-prefix" | "high-bmp-vs-astral";

export interface DocIdNearPair {
  readonly kind: DocIdNearPairKind;
  readonly left: string;
  readonly right: string;
}

const prefixArb = fc.option(shortValid, { nil: "" });

/**
 * Pairs of distinct valid IDs built to collide under a wrong implementation:
 * NFC/NFD spellings (normalization), upper/lower case (case folding), a
 * proper prefix (prefix order), and high-BMP versus astral at the first
 * difference (UTF-16 code-unit order). For `proper-prefix`, `left` is the
 * prefix; for `high-bmp-vs-astral`, `left` holds the high-BMP code point.
 */
export const docIdNearPairArb: fc.Arbitrary<DocIdNearPair> = fc.oneof(
  fc
    .tuple(
      prefixArb,
      fc.constantFrom(["é", "e\u0301"], ["Å", "A\u030a"], ["ñ", "n\u0303"], ["ộ", "o\u0323\u0302"]),
      shortBody,
    )
    .map(([prefix, [composed, decomposed], suffix]) => ({
      kind: "normalization" as const,
      left: prefix + composed + suffix,
      right: prefix + decomposed + suffix,
    })),
  fc.tuple(prefixArb, codePointRange(0x61, 0x7a), shortBody).map(([prefix, lower, suffix]) => ({
    kind: "case" as const,
    left: prefix + String.fromCharCode(lower).toUpperCase() + suffix,
    right: prefix + String.fromCharCode(lower) + suffix,
  })),
  fc
    .tuple(shortValid, fc.array(bodyCodePoint, { minLength: 1, maxLength: 8 }))
    .map(([prefix, suffix]) => ({
      kind: "proper-prefix" as const,
      left: prefix,
      right: prefix + String.fromCodePoint(...suffix),
    })),
  fc
    .tuple(prefixArb, highBmp, astral, shortBody, shortBody)
    .map(([prefix, high, wide, leftSuffix, rightSuffix]) => ({
      kind: "high-bmp-vs-astral" as const,
      left: prefix + String.fromCodePoint(high) + leftSuffix,
      right: prefix + String.fromCodePoint(wide) + rightSuffix,
    })),
);
