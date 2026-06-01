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
import { countKey, str2uint, str2uintDesc, uint2str, uint2strDesc } from "./types.ts";

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

describe("base-32 codecs — round-trip", () => {
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
