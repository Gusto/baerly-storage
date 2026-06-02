/**
 * Tests for the predicate builder (`makeBuilder` / `wireFromBuilder`).
 *
 * Strategy: assert the EXACT `PredicateWire` produced by each builder
 * entry point — op, field, and value string literals must be exact so
 * that StringLiteral / ObjectLiteral / ArrowFunction mutants die.
 */

import { describe, expect, test } from "vitest";

import { makeBuilder, wireFromBuilder } from "./builder.ts";

describe("makeBuilder — individual operators", () => {
  test("eq produces { op: 'eq', field, value } clause", () => {
    const { builder, clauses } = makeBuilder();
    builder.eq("status", "open");
    expect(clauses).toEqual([{ op: "eq", field: "status", value: "open" }]);
  });

  test("gt produces { op: 'gt', field, value } clause", () => {
    const { builder, clauses } = makeBuilder();
    builder.gt("priority", 5);
    expect(clauses).toEqual([{ op: "gt", field: "priority", value: 5 }]);
  });

  test("gte produces { op: 'gte', field, value } clause", () => {
    const { builder, clauses } = makeBuilder();
    builder.gte("score", 10);
    expect(clauses).toEqual([{ op: "gte", field: "score", value: 10 }]);
  });

  test("lt produces { op: 'lt', field, value } clause", () => {
    const { builder, clauses } = makeBuilder();
    builder.lt("age", 30);
    expect(clauses).toEqual([{ op: "lt", field: "age", value: 30 }]);
  });

  test("lte produces { op: 'lte', field, value } clause", () => {
    const { builder, clauses } = makeBuilder();
    builder.lte("count", 100);
    expect(clauses).toEqual([{ op: "lte", field: "count", value: 100 }]);
  });

  test("in produces { op: 'in', field, value: [...values] } clause", () => {
    const { builder, clauses } = makeBuilder();
    builder.in("tag", ["a", "b", "c"]);
    expect(clauses).toEqual([{ op: "in", field: "tag", value: ["a", "b", "c"] }]);
  });
});

describe("makeBuilder — chaining and accumulation", () => {
  test("chained calls accumulate all clauses in order", () => {
    const { builder, clauses } = makeBuilder();
    builder
      .eq("status", "open")
      .gt("priority", 5)
      .gte("score", 10)
      .lt("age", 30)
      .lte("count", 100)
      .in("tag", ["x", "y"]);
    expect(clauses).toEqual([
      { op: "eq", field: "status", value: "open" },
      { op: "gt", field: "priority", value: 5 },
      { op: "gte", field: "score", value: 10 },
      { op: "lt", field: "age", value: 30 },
      { op: "lte", field: "count", value: 100 },
      { op: "in", field: "tag", value: ["x", "y"] },
    ]);
  });

  test("each method returns the same builder instance (for chaining)", () => {
    const { builder } = makeBuilder();
    const r1 = builder.eq("a", "x");
    const r2 = r1.gt("b", 1);
    const r3 = r2.gte("c", 2);
    const r4 = r3.lt("d", 3);
    const r5 = r4.lte("e", 4);
    const r6 = r5.in("f", ["z"]);
    expect(r1).toBe(builder);
    expect(r2).toBe(builder);
    expect(r3).toBe(builder);
    expect(r4).toBe(builder);
    expect(r5).toBe(builder);
    expect(r6).toBe(builder);
  });

  test("in spreads the values array into a new array (not the same reference)", () => {
    const { builder, clauses } = makeBuilder();
    const original = ["a", "b"] as const;
    builder.in("tag", original);
    const clause = clauses[0];
    expect(clause).toBeDefined();
    expect(clause!.value).toEqual(["a", "b"]);
    // The stored value is a new array, not the original reference
    expect(clause!.value).not.toBe(original);
  });

  test("op string is exactly 'gte' (not 'gt', 'lte', etc.)", () => {
    const { builder, clauses } = makeBuilder();
    builder.gte("x", 1);
    expect(clauses[0]!.op).toBe("gte");
  });

  test("op string is exactly 'lt' (not 'lte', 'gt', etc.)", () => {
    const { builder, clauses } = makeBuilder();
    builder.lt("x", 1);
    expect(clauses[0]!.op).toBe("lt");
  });

  test("op string is exactly 'lte' (not 'lt', 'gte', etc.)", () => {
    const { builder, clauses } = makeBuilder();
    builder.lte("x", 1);
    expect(clauses[0]!.op).toBe("lte");
  });
});

describe("wireFromBuilder", () => {
  test("wraps clauses in a { clauses } envelope", () => {
    const wire = wireFromBuilder((q) =>
      q.eq("status", "open").gte("priority", 3).lt("age", 50).lte("count", 99),
    );
    expect(wire).toEqual({
      clauses: [
        { op: "eq", field: "status", value: "open" },
        { op: "gte", field: "priority", value: 3 },
        { op: "lt", field: "age", value: 50 },
        { op: "lte", field: "count", value: 99 },
      ],
    });
  });

  test("empty callback produces { clauses: [] }", () => {
    const wire = wireFromBuilder((q) => q);
    expect(wire).toEqual({ clauses: [] });
  });

  test("field names are converted to strings via String()", () => {
    // Path<T> values pass through String() — field is always a string.
    // Use a typed shape so the dotted-path key resolves cleanly.
    type Doc = { outer: { inner: number } };
    const { builder, clauses } = makeBuilder<Doc>();
    builder.gte("outer.inner", 5);
    expect(clauses[0]!.field).toBe("outer.inner");
  });
});
