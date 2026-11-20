import type { DocumentData } from "@baerly/protocol";
import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";

import {
  countMatches,
  filterRows,
  limitedLength,
  orderRows,
  sortByOrderSpec,
} from "./query-eval.ts";

describe("limitedLength", () => {
  fcTest.prop({
    n: fc.integer({ min: 0, max: 50 }),
    limit: fc.option(
      fc.oneof(
        fc.integer({ min: -60, max: 60 }),
        fc.double({ min: -60, max: 60, noNaN: false }),
        fc.constantFrom(Infinity, -Infinity, -0, 0.5, -0.5),
      ),
      { nil: undefined },
    ),
  })("equals the length the row path's slice leaves", ({ n, limit }) => {
    const rows = Array.from({ length: n }, (_, i) => i);
    const sliced = limit !== undefined && limit < rows.length ? rows.slice(0, limit) : rows;
    expect(Object.is(limitedLength(n, limit), sliced.length)).toBe(true);
  });
});

describe("filterRows / countMatches", () => {
  const docs = new Map(
    Array.from({ length: 10 }, (_, i) => [
      `d${i}`,
      { _id: `d${i}`, n: i, m: { odd: i % 2 === 1 } },
    ]),
  );
  const odd = { clauses: [{ op: "eq" as const, field: "m.odd", value: true }] };

  test("keep map order and count what they keep", () => {
    expect(filterRows(docs, odd).map((row) => row.docId)).toEqual(["d1", "d3", "d5", "d7", "d9"]);
    expect(countMatches(docs, odd)).toBe(5);
    expect(filterRows(docs, undefined)).toHaveLength(10);
    expect(countMatches(docs, undefined)).toBe(10);
  });
});

// ---------------------------------------------------------------------
// orderRows ≡ the stable full sort cut by limit, over the input shapes
// its pre-scan routes differently: in order, reversed, nearly in order
// (both directions), random, heavy ties, missing values, and the keys
// (`null`, objects, mixed types) that must fall back to the full sort.
// ---------------------------------------------------------------------

// Order keys may hold `null` and mixed types, which `DocumentData` does not admit.
type OrderRow = { docId: string; doc: DocumentData };

const valuePools = {
  ties: [0, 1, 2, undefined],
  numbers: [-3, -1, 0, 1, 2, 5, 8, 13, 21, 34],
  strings: ["", "a", "ab", "b", "ba", "c", "z"],
  booleans: [true, false, undefined],
  mixed: [1, "1", 2, "x", undefined],
  nulls: [null, 1, 2, 3, undefined],
  objects: [{ x: 1 }, 1, 2, [1], undefined],
} as const;
const poolArb = fc.constantFrom(...(Object.keys(valuePools) as Array<keyof typeof valuePools>));
const dirArb = fc.constantFrom("asc" as const, "desc" as const);
const shapeArb = fc.constantFrom("random", "sorted", "reversed", "nearlySorted", "nearlyReversed");

const orderCaseArb = fc
  .record({
    poolA: poolArb,
    poolB: poolArb,
    picks: fc.array(fc.tuple(fc.nat(), fc.nat()), { minLength: 0, maxLength: 160 }),
    spec: fc.oneof(
      fc.record({ a: dirArb }),
      fc.record({ a: dirArb, b: dirArb }),
      fc.record({ b: dirArb, a: dirArb }),
    ),
    shape: shapeArb,
    swaps: fc.array(fc.nat(), { maxLength: 4 }),
    limit: fc.oneof(fc.integer({ min: 1, max: 8 }), fc.integer({ min: 1, max: 80 })),
  })
  .map(({ poolA, poolB, picks, spec, shape, swaps, limit }) => {
    const a = valuePools[poolA];
    const b = valuePools[poolB];
    let rows: OrderRow[] = picks.map(([i, j], n) => {
      const doc: Record<string, unknown> = { _id: `d${n}` };
      const va = a[i % a.length];
      const vb = b[j % b.length];
      if (va !== undefined) {
        doc["a"] = va;
      }
      if (vb !== undefined) {
        doc["b"] = vb;
      }
      return { docId: `d${n}`, doc: doc as DocumentData };
    });
    if (shape !== "random") {
      rows = sortByOrderSpec(rows, spec);
      if (shape === "reversed" || shape === "nearlyReversed") {
        rows.reverse();
      }
      if (shape.startsWith("nearly") && rows.length > 1) {
        for (const s of swaps) {
          const i = s % (rows.length - 1);
          [rows[i], rows[i + 1]] = [rows[i + 1]!, rows[i]!];
        }
      }
    }
    return { rows, spec, limit };
  });

describe("orderRows", () => {
  fcTest.prop({ c: orderCaseArb })("equals the stable full sort cut by limit", ({ c }) => {
    const want = sortByOrderSpec(c.rows, c.spec as never).slice(0, c.limit);
    const got = orderRows(c.rows, c.spec as never, c.limit);
    expect(got.map((row) => row.docId)).toEqual(want.map((row) => row.docId));
  });

  test("orders tied keys by _id on reversed input", () => {
    const rows = [3, 3, 2, 2, 2, 1, 1].map((a, i) => ({
      docId: `d${i}`,
      doc: { _id: `d${i}`, a },
    }));
    expect(orderRows(rows, { a: "asc" }, 4).map((row) => row.docId)).toEqual([
      "d5",
      "d6",
      "d2",
      "d3",
    ]);
  });

  test("breaks heap ties by _id", () => {
    // Neither in order nor reversed, so the heap path runs.
    const rows = Array.from({ length: 40 }, (_, i) => ({
      docId: `d${i}`,
      doc: { _id: `d${i}`, a: (i * 7) % 3 },
    }));
    for (const dir of ["asc", "desc"] as const) {
      const want = sortByOrderSpec(rows, { a: dir }).slice(0, 10);
      expect(orderRows(rows, { a: dir }, 10).map((row) => row.docId)).toEqual(
        want.map((row) => row.docId),
      );
    }
  });

  // The pre-scan keeps comparing past QUERY_TOP_K_SAMPLE while the input
  // still looks monotone, so one late out-of-order row is not missed.
  test("finds a late out-of-order row in otherwise ordered input", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      docId: `d${i}`,
      doc: { _id: `d${i}`, a: i === 150 ? 0 : i + 1 },
    }));
    const got = orderRows(rows, { a: "asc" }, 10).map((row) => row.docId);
    expect(got[0]).toBe("d150");
    expect(got).toEqual(
      sortByOrderSpec(rows, { a: "asc" })
        .slice(0, 10)
        .map((row) => row.docId),
    );
  });

  test("finds a late out-of-order row in otherwise reversed input", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      docId: `d${i}`,
      doc: { _id: `d${i}`, a: i === 150 ? -1 : 200 - i },
    }));
    const got = orderRows(rows, { a: "asc" }, 10).map((row) => row.docId);
    expect(got[0]).toBe("d150");
    expect(got).toEqual(
      sortByOrderSpec(rows, { a: "asc" })
        .slice(0, 10)
        .map((row) => row.docId),
    );
  });

  test("without a small limit it is the full sort", () => {
    const rows = [2, 1, 3].map((a, i) => ({ docId: `d${i}`, doc: { _id: `d${i}`, a } }));
    expect(orderRows(rows, { a: "asc" }, undefined).map((row) => row.docId)).toEqual([
      "d1",
      "d0",
      "d2",
    ]);
  });
});

// ---------------------------------------------------------------------
// `order` is a total order: a fixed cross-type rank, then the value,
// then `_id`.
// ---------------------------------------------------------------------

const rowsOf = (values: readonly unknown[]): OrderRow[] =>
  values.map((value, i) => {
    const doc: Record<string, unknown> = { _id: `d${i}` };
    if (value !== undefined) {
      doc["a"] = value;
    }
    return { docId: `d${i}`, doc: doc as DocumentData };
  });

const idsOf = (rows: readonly OrderRow[]): string[] => rows.map((row) => row.docId);

describe("order is a total order", () => {
  test("null sorts among numbers instead of equalling everything", () => {
    const rows = rowsOf([5, null, 1, 3]);
    expect(idsOf(sortByOrderSpec(rows, { a: "asc" }))).toEqual(["d1", "d2", "d3", "d0"]);
    expect(idsOf(orderRows(rows, { a: "asc" }, 2))).toEqual(["d1", "d2"]);
  });

  test("ranks null and missing, numbers, strings, booleans, objects, arrays", () => {
    const rows = rowsOf([[1], { x: 1 }, true, "b", 2, null, undefined, false, "a", -1]);
    // null and missing tie on rank, so `_id` orders them.
    expect(idsOf(sortByOrderSpec(rows, { a: "asc" }))).toEqual([
      "d5", // null
      "d6", // missing
      "d9", // -1
      "d4", // 2
      "d8", // "a"
      "d3", // "b"
      "d7", // false
      "d2", // true
      "d1", // object
      "d0", // array
    ]);
  });

  test("a number never ties a string that coerces to it", () => {
    const rows = rowsOf(["2", 10, "10", 2]);
    expect(idsOf(sortByOrderSpec(rows, { a: "asc" }))).toEqual(["d3", "d1", "d2", "d0"]);
  });

  test("desc reverses the whole order, null and missing last", () => {
    const rows = rowsOf([5, null, 1, undefined, "x"]);
    expect(idsOf(sortByOrderSpec(rows, { a: "desc" }))).toEqual(["d4", "d0", "d2", "d3", "d1"]);
  });

  test("equal keys resolve by _id, in the last key's direction", () => {
    const rows = rowsOf([1, 1, 1]);
    expect(idsOf(sortByOrderSpec(rows.toReversed(), { a: "asc" }))).toEqual(["d0", "d1", "d2"]);
    expect(idsOf(sortByOrderSpec(rows, { a: "desc" }))).toEqual(["d2", "d1", "d0"]);
    expect(idsOf(sortByOrderSpec(rows.toReversed(), {}))).toEqual(["d0", "d1", "d2"]);
  });

  test("the bounded path agrees on ties and mixed types", () => {
    const rows = rowsOf(Array.from({ length: 100 }, (_, i) => [null, 1, "1", false][i % 4]));
    for (const dir of ["asc", "desc"] as const) {
      expect(idsOf(orderRows(rows, { a: dir }, 7))).toEqual(
        idsOf(sortByOrderSpec(rows, { a: dir }).slice(0, 7)),
      );
    }
  });

  const anyValueArb = fc.constantFrom(
    undefined,
    null,
    -2,
    0,
    3.5,
    "",
    "a",
    "ab",
    "10",
    "2",
    true,
    false,
    { x: 1 },
    [1],
  );
  const rowsArb = fc
    .array(anyValueArb, { minLength: 0, maxLength: 40 })
    .map((values) => rowsOf(values));

  fcTest.prop({ rows: rowsArb, dir: dirArb })(
    "sorted output is sorted and independent of input order",
    ({ rows, dir }) => {
      const spec = { a: dir };
      const out = sortByOrderSpec(rows, spec);
      for (let i = 1; i < out.length; i++) {
        expect(sortByOrderSpec([out[i]!, out[i - 1]!], spec)).toEqual([out[i - 1], out[i]]);
      }
      expect(idsOf(sortByOrderSpec(rows.toReversed(), spec))).toEqual(idsOf(out));
      expect(
        idsOf(
          sortByOrderSpec(
            rows.toSorted((x, y) => (x.docId < y.docId ? 1 : -1)),
            spec,
          ),
        ),
      ).toEqual(idsOf(out));
    },
  );

  fcTest.prop({ rows: rowsArb, dir: dirArb })(
    "the comparator is antisymmetric and transitive",
    ({ rows, dir }) => {
      const spec = { a: dir };
      const before = (x: OrderRow, y: OrderRow): boolean =>
        idsOf(sortByOrderSpec([y, x], spec))[0] === x.docId && x.docId !== y.docId;
      for (const x of rows) {
        for (const y of rows) {
          expect(before(x, y) && before(y, x)).toBe(false);
          if (x.docId !== y.docId) {
            expect(before(x, y) || before(y, x)).toBe(true);
          }
        }
      }
      const out = sortByOrderSpec(rows, spec);
      // Transitivity: every earlier row orders before every later one.
      for (let i = 0; i < out.length; i++) {
        for (let j = i + 1; j < out.length; j++) {
          expect(before(out[i]!, out[j]!)).toBe(true);
        }
      }
    },
  );
});
