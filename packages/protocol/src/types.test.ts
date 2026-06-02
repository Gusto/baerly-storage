/**
 * Property laws for the base-32 LSN codecs in `./types.ts`
 * (`uint2str` / `str2uint` / `uint2strDesc` / `str2uintDesc` /
 * `countKey`). These are the load-bearing ordering primitives: the
 * read path leans on `uint2strDesc`'s order-reversal so a forward
 * `Storage.list` walks the log newest-first.
 *
 * `lsn-reverse-list.test.ts` verifies the *composed* LSN ordering
 * behaviourally through `MemoryStorage.list`; this file pins the raw
 * codec contracts directly so a `padStart` / domain regression fails
 * loud rather than silently inverting key order.
 *
 * @see docs/spec/sync-protocol.md §"Subtleties of the manifest key"
 */
import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import { TIMESTAMP_BIT_WIDTH } from "./constants.ts";
import { countKey, str2uint, str2uintDesc, uint2str, uint2strDesc, uuid, uuidv7 } from "./types.ts";

// Bit-widths the protocol actually uses (COUNT_BIT_WIDTH = 10,
// TIMESTAMP_BIT_WIDTH = 42) plus an intermediate. All ≤ 45, so
// `2 ** bits - 1` stays well under `Number.MAX_SAFE_INTEGER` and
// `parseInt(_, 32)` round-trips exactly.
const bitsArb = fc.constantFrom(10, 20, TIMESTAMP_BIT_WIDTH);

/** A bit-width paired with one in-domain integer `[0, 2^bits)`. */
const bitsAndN = bitsArb.chain((bits) =>
  fc.record({ bits: fc.constant(bits), n: fc.nat({ max: 2 ** bits - 1 }) }),
);

/** A bit-width paired with two in-domain integers. */
const bitsAndPair = bitsArb.chain((bits) =>
  fc.record({
    bits: fc.constant(bits),
    a: fc.nat({ max: 2 ** bits - 1 }),
    b: fc.nat({ max: 2 ** bits - 1 }),
  }),
);

// UUID format regex (v4 / v7 / generic standard hyphenated UUID).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("uuid()", () => {
  // Kills L39 ArrowFunction→undefined: undefined is not a string, fails typeof + regex.
  test("returns a non-empty string in UUID format", () => {
    const id = uuid();
    expect(typeof id).toBe("string");
    expect(id).toMatch(UUID_RE);
  });

  test("two calls return distinct values", () => {
    expect(uuid()).not.toBe(uuid());
  });
});

describe("uuidv7()", () => {
  // Kills L56 NoCoverage BlockStatement: empty body returns undefined, fails typeof.
  test("returns a non-empty string in UUID format (kills L56 BlockStatement)", () => {
    const id = uuidv7();
    expect(typeof id).toBe("string");
    expect(id).toMatch(UUID_RE);
  });

  // Kills L66 StringLiteral→"": millisHex padStart("") omits padding, wrong length.
  // Kills L67 ArrowFunction→undefined: b becomes "undefined,undefined,...", wrong format.
  // Kills L67 StringLiteral "" (padStart "0"→""): hex bytes not zero-padded, wrong length.
  // Kills L67 StringLiteral "Stryker was here!" (join ""→"..."): b won't format as hex pairs.
  test("format: 8-4-4-4-12 hyphen groups, all lowercase hex (kills L66/L67 string/arrow mutants)", () => {
    const id = uuidv7();
    const parts = id.split("-");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toHaveLength(8);
    expect(parts[1]).toHaveLength(4);
    expect(parts[2]).toHaveLength(4);
    expect(parts[3]).toHaveLength(4);
    expect(parts[4]).toHaveLength(12);
    // All characters must be hex digits.
    expect(id.replace(/-/g, "")).toMatch(/^[0-9a-f]{32}$/);
  });

  test("version nibble is 7 (UUIDv7)", () => {
    // UUIDv7: the first char of the third group (time_hi_and_version) is '7'.
    const id = uuidv7();
    expect(id.split("-")[2]![0]).toBe("7");
  });

  test("variant bits are set (RFC 4122: third group[0] is 8, 9, a, or b)", () => {
    const id = uuidv7();
    expect("89ab").toContain(id.split("-")[3]![0]!);
  });

  test("two calls return distinct values", () => {
    expect(uuidv7()).not.toBe(uuidv7());
  });
});

describe("base-32 codecs — round-trip", () => {
  // Concrete str2uint cases: kill L88 BlockStatement→{} (body returns undefined, fails exact check).
  // The prop test survived because fast-check may use seeds where the TypeError is swallowed;
  // a deterministic test with an exact expected value is reliable.
  test("str2uint('0') === 0", () => {
    expect(str2uint("0")).toBe(0);
  });

  test("str2uint('1') === 1", () => {
    expect(str2uint("1")).toBe(1);
  });

  test("str2uint('10') === 32 (base-32 for 32)", () => {
    expect(str2uint("10")).toBe(32);
  });

  test.prop({ g: bitsAndN })("str2uint(uint2str(n, bits)) === n", ({ g }) => {
    expect(str2uint(uint2str(g.n, g.bits))).toBe(g.n);
  });

  test.prop({ g: bitsAndN })("str2uintDesc(uint2strDesc(n, bits), bits) === n", ({ g }) => {
    expect(str2uintDesc(uint2strDesc(g.n, g.bits), g.bits)).toBe(g.n);
  });

  test.prop({ n: fc.nat({ max: 1023 }) })(
    "str2uintDesc(countKey(n), 10) === n across the full COUNT domain",
    ({ n }) => {
      expect(str2uintDesc(countKey(n), 10)).toBe(n);
    },
  );
});

describe("base-32 codecs — fixed width", () => {
  test.prop({ g: bitsAndN })(
    "uint2str / uint2strDesc pad to ceil(bits/5) chars for every value in domain",
    ({ g }) => {
      const width = Math.ceil(g.bits / 5);
      expect(uint2str(g.n, g.bits)).toHaveLength(width);
      expect(uint2strDesc(g.n, g.bits)).toHaveLength(width);
    },
  );
});

describe("base-32 codecs — ordering", () => {
  test.prop({ g: bitsAndPair })(
    "ascending: a < b ⟺ uint2str(a) < uint2str(b) (lexical, equal width)",
    ({ g }) => {
      if (g.a === g.b) {
        return; // equal values encode equal — nothing to order.
      }
      const ea = uint2str(g.a, g.bits);
      const eb = uint2str(g.b, g.bits);
      expect(g.a < g.b).toBe(ea < eb);
    },
  );

  test.prop({ g: bitsAndPair })(
    "descending: a < b ⟺ uint2strDesc(a) > uint2strDesc(b) (the load-bearing reversal)",
    ({ g }) => {
      if (g.a === g.b) {
        return;
      }
      const ea = uint2strDesc(g.a, g.bits);
      const eb = uint2strDesc(g.b, g.bits);
      expect(g.a < g.b).toBe(ea > eb);
    },
  );

  test.prop({ ns: fc.array(fc.nat({ max: 1023 }), { maxLength: 12 }) })(
    "sort correspondence: lexical sort of uint2strDesc(n,10) === value-descending sort",
    ({ ns }) => {
      const cmp = (x: number, y: number): number => {
        const ex = uint2strDesc(x, 10);
        const ey = uint2strDesc(y, 10);
        if (ex < ey) {
          return -1;
        }
        if (ex > ey) {
          return 1;
        }
        return 0;
      };
      const byEncoding = ns.toSorted(cmp);
      const byValueDesc = ns.toSorted((x, y) => y - x);
      // Both arrays hold the same multiset; equal values are
      // indistinguishable, so compare the resulting value sequences.
      expect(byEncoding).toEqual(byValueDesc);
    },
  );

  // Concrete boundary anchors (also asserted via lsn-reverse-list.test.ts;
  // duplicated here so the raw-codec contract stands on its own).
  test("uint2strDesc boundary values", () => {
    expect(uint2strDesc(0, 10)).toBe("vv");
    expect(uint2strDesc(1023, 10)).toBe("00");
  });
});
