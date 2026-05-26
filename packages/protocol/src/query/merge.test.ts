import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";

import { BaerlyError } from "../errors.ts";
import type { DocumentValue, JSONObject } from "../json.ts";

import { matchesWire } from "./matches.ts";
import { mergePredicateWires } from "./merge.ts";
import { validateWire } from "./validate.ts";
import type { PredicateClause, PredicateOpName, PredicateWire } from "./wire.ts";

const expectInvalidConfig = (fn: () => unknown, snippet: string): void => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BaerlyError);
    expect((error as BaerlyError).code).toBe("InvalidConfig");
    expect((error as BaerlyError).message).toContain(snippet);
    return;
  }
  throw new Error(`Expected BaerlyError{InvalidConfig}, none thrown`);
};

const expectUnsatisfiable = (fn: () => unknown, snippet: string): void => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BaerlyError);
    expect((error as BaerlyError).code).toBe("UnsatisfiablePredicate");
    expect((error as BaerlyError).message).toContain(snippet);
    return;
  }
  throw new Error(`Expected BaerlyError{UnsatisfiablePredicate}, none thrown`);
};

const eq = (field: string, value: DocumentValue): PredicateClause => ({
  op: "eq",
  field,
  value,
});
const op = (
  o: PredicateOpName,
  field: string,
  value: DocumentValue | ReadonlyArray<DocumentValue>,
): PredicateClause => ({ op: o, field, value });

describe("mergePredicateWires", () => {
  test("disjoint clauses concatenate", () => {
    expect(
      mergePredicateWires({ clauses: [eq("status", "open")] }, { clauses: [eq("priority", "p1")] }),
    ).toEqual({ clauses: [eq("status", "open"), eq("priority", "p1")] });
  });

  test("merging with an empty wire returns the other side's clauses", () => {
    expect(mergePredicateWires({ clauses: [] }, { clauses: [eq("status", "open")] })).toEqual({
      clauses: [eq("status", "open")],
    });
    expect(mergePredicateWires({ clauses: [eq("status", "open")] }, { clauses: [] })).toEqual({
      clauses: [eq("status", "open")],
    });
  });

  test("shared field with deep-equal eq values is kept (no contradiction)", () => {
    // The merger concatenates; the per-field satisfiability check sees
    // two eq clauses with equal values and accepts.
    const merged = mergePredicateWires(
      { clauses: [eq("status", "open")] },
      { clauses: [eq("status", "open")] },
    );
    expect(merged).toEqual({ clauses: [eq("status", "open"), eq("status", "open")] });
    // The merged wire matches any doc where status==="open" — identical to
    // the result for either side alone.
    expect(matchesWire(merged, { status: "open" })).toBe(true);
    expect(matchesWire(merged, { status: "closed" })).toBe(false);
  });

  test("shared field with conflicting eq primitives throws InvalidConfig", () => {
    expectInvalidConfig(
      () =>
        mergePredicateWires(
          { clauses: [eq("status", "open")] },
          { clauses: [eq("status", "closed")] },
        ),
      '"status"',
    );
  });

  test("disjoint range clauses on different fields concatenate", () => {
    const m = mergePredicateWires(
      { clauses: [op("gt", "count", 5)] },
      { clauses: [op("in", "priority", ["p1"])] },
    );
    expect(matchesWire(m, { count: 10, priority: "p1" })).toBe(true);
    expect(matchesWire(m, { count: 10, priority: "p2" })).toBe(false);
    expect(matchesWire(m, { count: 4, priority: "p1" })).toBe(false);
  });

  test("two gt clauses → both retained; matcher AND's so the tighter bound wins", () => {
    const m = mergePredicateWires(
      { clauses: [op("gt", "x", 5)] },
      { clauses: [op("gt", "x", 10)] },
    );
    expect(matchesWire(m, { x: 10 })).toBe(false);
    expect(matchesWire(m, { x: 11 })).toBe(true);
  });

  test("two lt clauses → matcher AND keeps the lower bound", () => {
    const m = mergePredicateWires(
      { clauses: [op("lt", "x", 100)] },
      { clauses: [op("lt", "x", 50)] },
    );
    expect(matchesWire(m, { x: 50 })).toBe(false);
    expect(matchesWire(m, { x: 49 })).toBe(true);
  });

  test("gt + gte on the same equal bound — strict wins via the matcher AND", () => {
    const m = mergePredicateWires(
      { clauses: [op("gt", "x", 5)] },
      { clauses: [op("gte", "x", 5)] },
    );
    expect(matchesWire(m, { x: 5 })).toBe(false);
    expect(matchesWire(m, { x: 6 })).toBe(true);
  });

  test("two in clauses on the same field — matcher AND keeps the intersection", () => {
    const m = mergePredicateWires(
      { clauses: [op("in", "x", ["a", "b", "c"])] },
      { clauses: [op("in", "x", ["b", "c", "d"])] },
    );
    expect(matchesWire(m, { x: "a" })).toBe(false);
    expect(matchesWire(m, { x: "b" })).toBe(true);
    expect(matchesWire(m, { x: "c" })).toBe(true);
    expect(matchesWire(m, { x: "d" })).toBe(false);
  });

  test("two in clauses with empty intersection → UnsatisfiablePredicate", () => {
    expectUnsatisfiable(
      () =>
        mergePredicateWires(
          { clauses: [op("in", "x", ["a", "b"])] },
          { clauses: [op("in", "x", ["c", "d"])] },
        ),
      "empty in() intersection",
    );
  });

  test("lo > hi after merge → UnsatisfiablePredicate", () => {
    expectUnsatisfiable(
      () =>
        mergePredicateWires(
          { clauses: [op("gt", "x", 10)] },
          { clauses: [op("lt", "x", 5)] },
        ),
      "empty interval",
    );
  });

  test("eq on one side + in on the other collapses via the matcher", () => {
    const m = mergePredicateWires(
      { clauses: [eq("x", 1)] },
      { clauses: [op("in", "x", [1, 2])] },
    );
    expect(matchesWire(m, { x: 1 })).toBe(true);
    expect(matchesWire(m, { x: 2 })).toBe(false);
  });

  test("eq outside the merged interval → UnsatisfiablePredicate", () => {
    expectUnsatisfiable(
      () =>
        mergePredicateWires(
          { clauses: [eq("x", 1)] },
          { clauses: [op("gt", "x", 5)] },
        ),
      "excluded by lower bound",
    );
  });

  test("boolean eq vs numeric range → UnsatisfiablePredicate", () => {
    expectUnsatisfiable(
      () =>
        mergePredicateWires(
          { clauses: [eq("b", false)] },
          { clauses: [op("gt", "b", 0)] },
        ),
      "type-incompatible",
    );
  });

  test("string eq vs numeric upper bound → UnsatisfiablePredicate", () => {
    expectUnsatisfiable(
      () =>
        mergePredicateWires(
          { clauses: [eq("x", "p2")] },
          { clauses: [op("lt", "x", 10)] },
        ),
      "type-incompatible",
    );
  });

  test("numeric eq vs string range → UnsatisfiablePredicate", () => {
    expectUnsatisfiable(
      () =>
        mergePredicateWires(
          { clauses: [eq("x", 5)] },
          { clauses: [op("gte", "x", "a")] },
        ),
      "type-incompatible",
    );
  });

  test("acceptance is symmetric: merge(a,b) and merge(b,a) accept the same doc set", () => {
    const m1 = mergePredicateWires(
      { clauses: [eq("status", "open")] },
      { clauses: [eq("priority", "p1")] },
    );
    const m2 = mergePredicateWires(
      { clauses: [eq("priority", "p1")] },
      { clauses: [eq("status", "open")] },
    );
    expect(matchesWire(m1, { status: "open", priority: "p1" })).toBe(true);
    expect(matchesWire(m2, { status: "open", priority: "p1" })).toBe(true);
    expect(matchesWire(m1, { status: "closed", priority: "p1" })).toBe(false);
    expect(matchesWire(m2, { status: "closed", priority: "p1" })).toBe(false);
  });
});

// Property test: when the merge doesn't throw, the merged predicate
// accepts a document iff both inputs do. Keeps the search space small
// — string keys from a 4-element pool, primitive values only.
const keyArb = fc.constantFrom("a", "b", "c", "d");
const valArb = fc.oneof(
  fc.string({ minLength: 0, maxLength: 4 }),
  fc.integer({ min: -3, max: 3 }),
  fc.boolean(),
);

const eqClauseArb: fc.Arbitrary<PredicateClause> = fc
  .tuple(keyArb, valArb)
  .map(([k, v]) => ({ op: "eq" as const, field: k, value: v as DocumentValue }));

const wireArb: fc.Arbitrary<PredicateWire> = fc
  .array(eqClauseArb, { maxLength: 4 })
  .map((clauses) => ({ clauses }));

const docArb: fc.Arbitrary<JSONObject> = fc
  .array(fc.tuple(keyArb, valArb), { maxLength: 4 })
  .map((pairs) => {
    const out: Record<string, DocumentValue> = {};
    for (const [k, v] of pairs) {
      out[k] = v as DocumentValue;
    }
    return out as JSONObject;
  });

fcTest.prop({ a: wireArb, b: wireArb, doc: docArb })(
  "matchesWire(merge(a,b), doc) === matchesWire(a, doc) && matchesWire(b, doc) (when merge doesn't throw)",
  ({ a, b, doc }) => {
    let merged: PredicateWire;
    try {
      merged = mergePredicateWires(a, b);
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      return;
    }
    expect(matchesWire(merged, doc)).toBe(matchesWire(a, doc) && matchesWire(b, doc));
  },
);

// Operator-aware property test: build wires with eq / gt / lt / in
// clauses on a small key/value pool, validate each side first, and
// assert matcher/merge agreement when the merge doesn't throw.
const opClauseArb: fc.Arbitrary<PredicateClause> = fc.oneof(
  fc.tuple(keyArb, valArb).map(([k, v]) => ({
    op: "eq" as const,
    field: k,
    value: v as DocumentValue,
  })),
  fc.tuple(keyArb, fc.integer({ min: -3, max: 3 })).map(([k, v]) => ({
    op: "gt" as const,
    field: k,
    value: v as DocumentValue,
  })),
  fc.tuple(keyArb, fc.integer({ min: -3, max: 3 })).map(([k, v]) => ({
    op: "lt" as const,
    field: k,
    value: v as DocumentValue,
  })),
  fc
    .tuple(keyArb, fc.array(valArb, { minLength: 1, maxLength: 3 }))
    .map(([k, vs]) => ({
      op: "in" as const,
      field: k,
      value: vs as ReadonlyArray<DocumentValue>,
    })),
);

const opWireArb: fc.Arbitrary<PredicateWire> = fc
  .array(opClauseArb, { maxLength: 4 })
  .map((clauses) => ({ clauses }));

fcTest.prop({ a: opWireArb, b: opWireArb, doc: docArb })(
  "matchesWire(merge(a,b), doc) === matchesWire(a, doc) && matchesWire(b, doc) — operators",
  ({ a, b, doc }) => {
    try {
      validateWire(a);
      validateWire(b);
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      return;
    }
    let merged: PredicateWire;
    try {
      merged = mergePredicateWires(a, b);
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      return;
    }
    expect(matchesWire(merged, doc)).toBe(matchesWire(a, doc) && matchesWire(b, doc));
  },
);
