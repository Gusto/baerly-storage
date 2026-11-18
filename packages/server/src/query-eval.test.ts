import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";

import { countMatches, filterRows, limitedLength } from "./query-eval.ts";

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
