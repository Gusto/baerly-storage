import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import { BaerlyError } from "@baerly/protocol";
import { encodeIndexValue } from "./indexes.ts";

// The encoder emits only ASCII base-32 chars ("0123456789a..v"), so a
// JS string `<` comparison on the OUTPUT is a true byte-lex comparison.
const cmp = (x: string, y: string): number => {
  if (x < y) {
    return -1;
  }
  if (x > y) {
    return 1;
  }
  return 0;
};
const sign = (n: number): number => {
  if (n < 0) {
    return -1;
  }
  if (n > 0) {
    return 1;
  }
  return 0;
};

// Numeric comparator that is correct at ±Infinity (where subtraction yields
// NaN). Returns -1/0/1.
const numCompare = (a: number, b: number): number => {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
};

// Type rank mirrors the documented order in `indexes.ts`:
// null < false < true < number < string < object.
const rank = (v: unknown): number => {
  if (v === null) {
    return 0;
  }
  if (v === false) {
    return 1;
  }
  if (v === true) {
    return 2;
  }
  if (typeof v === "number") {
    return 3;
  }
  if (typeof v === "string") {
    return 4;
  }
  return 5; // object
};

const enc = new TextEncoder();
// Compare two strings by their UTF-8 bytes — matches the encoder, which
// emits raw UTF-8 (not UTF-16 code units, which a JS `<` would use).
const utf8Compare = (a: string, b: string): number => {
  const ba = enc.encode(a);
  const bb = enc.encode(b);
  const n = Math.min(ba.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (ba[i]! !== bb[i]!) {
      return ba[i]! - bb[i]!;
    }
  }
  return ba.length - bb.length;
};

// Spans the full type lattice. `fc.double` includes ±Infinity and ±0 by
// default; NaN is excluded (it is a documented throw, tested separately).
// `unit: "binary"` yields only well-formed code points (full 0000–10FFFF
// range, no lone surrogates) — bare `fc.string()` could emit lone surrogates
// that are `!==`-distinct in UTF-16 yet UTF-8-collide to EF BF BD, which would
// spuriously falsify the `===`-based injectivity oracle below. It still
// exercises real multi-byte UTF-8 ordering (it spans the astral plane).
const valueArb = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.double({ noNaN: true }),
  fc.string({ unit: "binary" }),
);

describe("encodeIndexValue — value-order-preserving wire format", () => {
  test.prop({ a: valueArb, b: valueArb })(
    "lex order of encodings matches semantic (type, then within-type) order",
    ({ a, b }) => {
      const ra = rank(a);
      const rb = rank(b);
      const encoded = cmp(encodeIndexValue(a), encodeIndexValue(b));
      if (ra !== rb) {
        expect(sign(encoded)).toBe(sign(ra - rb));
        return;
      }
      // Same type rank — assert within-type ordering for the ordered types.
      switch (ra) {
        case 3: {
          // number
          expect(sign(encoded)).toBe(sign(numCompare(a as number, b as number)));
          break;
        }
        case 4: {
          // string
          expect(sign(encoded)).toBe(sign(utf8Compare(a as string, b as string)));
          break;
        }
        default: {
          // null / false / true — singletons, must be byte-equal
          expect(encoded).toBe(0);
        }
      }
    },
  );

  test.prop({ a: valueArb, b: valueArb })(
    "injective on primitives: byte-equal encodings ⟺ semantically equal",
    ({ a, b }) => {
      const equalEncoding = encodeIndexValue(a) === encodeIndexValue(b);
      // Semantic equality within this lattice: same rank AND (singleton, or
      // numeric ===, or string ===). `Object.is`-style with -0===+0 collapse.
      const ra = rank(a);
      const semanticallyEqual =
        ra === rank(b) &&
        (ra <= 2 || (ra === 3 && (a as number) === (b as number)) || (ra === 4 && a === b));
      expect(equalEncoding).toBe(semanticallyEqual);
    },
  );

  // ── Concrete hand-checked cases (guard against a vacuous property) ──

  test("full type-lattice chain sorts as documented", () => {
    const chain = [
      encodeIndexValue(null),
      encodeIndexValue(false),
      encodeIndexValue(true),
      encodeIndexValue(-Infinity),
      encodeIndexValue(-1),
      encodeIndexValue(0),
      encodeIndexValue(1),
      encodeIndexValue(Infinity),
      encodeIndexValue(""),
      encodeIndexValue("z"),
      encodeIndexValue({ a: 1 }),
    ];
    expect(chain).toEqual([...chain].toSorted());
    // strictly increasing (no two adjacent equal)
    for (let i = 1; i < chain.length; i++) {
      expect(chain[i - 1]! < chain[i]!).toBe(true);
    }
  });

  test("numeric order, not lexical: enc(9) < enc(10)", () => {
    expect(encodeIndexValue(9) < encodeIndexValue(10)).toBe(true);
  });

  test("string '5' and number 5 are kept apart by the type tag", () => {
    expect(encodeIndexValue("5")).not.toBe(encodeIndexValue(5));
  });

  test("-0 and +0 collapse to the same encoding", () => {
    expect(encodeIndexValue(-0)).toBe(encodeIndexValue(0));
  });

  test("NaN throws SchemaError (no order-preserving slot)", () => {
    expect(() => encodeIndexValue(NaN)).toThrow(BaerlyError);
    try {
      encodeIndexValue(NaN);
    } catch (error) {
      expect((error as BaerlyError).code).toBe("SchemaError");
    }
  });
});
