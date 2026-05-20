import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";

import type { Predicate } from "../table-api.ts";
import { BaerlyError } from "../errors.ts";
import type { DocumentValue, JSONObject } from "../json.ts";

import { type PredicateOp } from "./_internals.ts";
import { matches } from "./matches.ts";
import { mergePredicates } from "./merge.ts";
import { validatePredicate } from "./validate.ts";

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

describe("mergePredicates", () => {
  test("disjoint keys merge to a union", () => {
    expect(mergePredicates({ status: "open" }, { priority: "p1" })).toEqual({
      status: "open",
      priority: "p1",
    });
  });

  test("merging with an empty predicate returns the other side", () => {
    expect(mergePredicates({}, { status: "open" })).toEqual({ status: "open" });
    expect(mergePredicates({ status: "open" }, {})).toEqual({ status: "open" });
  });

  test("shared key with deep-equal primitive values collapses", () => {
    expect(mergePredicates({ status: "open" }, { status: "open" })).toEqual({
      status: "open",
    });
  });

  test("shared key with deep-equal sub-predicates collapses", () => {
    expect(
      mergePredicates({ assignee: { team: "platform" } }, { assignee: { team: "platform" } }),
    ).toEqual({ assignee: { team: "platform" } });
  });

  test("shared key with conflicting primitive values throws InvalidConfig", () => {
    expectInvalidConfig(
      () => mergePredicates<{ status: string }>({ status: "open" }, { status: "closed" }),
      '"status"',
    );
  });

  test("shared key with conflicting sub-predicate throws InvalidConfig", () => {
    expectInvalidConfig(
      () =>
        mergePredicates<{ assignee: { team: string } }>(
          { assignee: { team: "platform" } },
          { assignee: { team: "billing" } },
        ),
      '"assignee"',
    );
  });

  test("acceptance is symmetric: merge(a,b) ≡ merge(b,a) when both succeed", () => {
    const m1 = mergePredicates({ status: "open" }, { priority: "p1" });
    const m2 = mergePredicates({ priority: "p1" }, { status: "open" });
    expect(matches(m1, { status: "open", priority: "p1" })).toBe(true);
    expect(matches(m2, { status: "open", priority: "p1" })).toBe(true);
    expect(matches(m1, { status: "closed", priority: "p1" })).toBe(false);
    expect(matches(m2, { status: "closed", priority: "p1" })).toBe(false);
  });
});

describe("mergePredicates — operator-object", () => {
  test("disjoint operator clauses on different fields union", () => {
    const m = mergePredicates(
      { count: { $gt: 5 } } as unknown as Predicate,
      { priority: { $in: ["p1"] } } as unknown as Predicate,
    );
    expect(matches(m, { count: 10, priority: "p1" })).toBe(true);
    expect(matches(m, { count: 10, priority: "p2" })).toBe(false);
    expect(matches(m, { count: 4, priority: "p1" })).toBe(false);
  });

  test("intersect $gt → keep higher bound; strict tie wins", () => {
    const m = mergePredicates(
      { x: { $gt: 5 } } as unknown as Predicate,
      { x: { $gt: 10 } } as unknown as Predicate,
    );
    expect(matches(m, { x: 10 })).toBe(false);
    expect(matches(m, { x: 11 })).toBe(true);
  });

  test("intersect $lt → keep lower bound", () => {
    const m = mergePredicates(
      { x: { $lt: 100 } } as unknown as Predicate,
      { x: { $lt: 50 } } as unknown as Predicate,
    );
    expect(matches(m, { x: 50 })).toBe(false);
    expect(matches(m, { x: 49 })).toBe(true);
  });

  test("$gt beats $gte on equal bound", () => {
    const m = mergePredicates(
      { x: { $gt: 5 } } as unknown as Predicate,
      { x: { $gte: 5 } } as unknown as Predicate,
    );
    // Strict wins on tie → effectively `$gt: 5`.
    expect(matches(m, { x: 5 })).toBe(false);
    expect(matches(m, { x: 6 })).toBe(true);
  });

  test("$in intersection collapses to shared members", () => {
    const m = mergePredicates(
      { x: { $in: ["a", "b", "c"] } } as unknown as Predicate,
      { x: { $in: ["b", "c", "d"] } } as unknown as Predicate,
    );
    expect(matches(m, { x: "a" })).toBe(false);
    expect(matches(m, { x: "b" })).toBe(true);
    expect(matches(m, { x: "c" })).toBe(true);
    expect(matches(m, { x: "d" })).toBe(false);
  });

  test("empty $in intersection → UnsatisfiablePredicate", () => {
    expectUnsatisfiable(
      () =>
        mergePredicates(
          { x: { $in: ["a", "b"] } } as unknown as Predicate,
          { x: { $in: ["c", "d"] } } as unknown as Predicate,
        ),
      "$in intersection",
    );
  });

  test("conflicting $eq → UnsatisfiablePredicate", () => {
    expectUnsatisfiable(
      () =>
        mergePredicates(
          { x: { $eq: 1 } } as unknown as Predicate,
          { x: { $eq: 2 } } as unknown as Predicate,
        ),
      "conflicting $eq",
    );
  });

  test("lo > hi after merge → UnsatisfiablePredicate", () => {
    expectUnsatisfiable(
      () =>
        mergePredicates(
          { x: { $gt: 10 } } as unknown as Predicate,
          { x: { $lt: 5 } } as unknown as Predicate,
        ),
      "empty interval",
    );
  });

  test("primitive on one side coerces to $eq and collapses inside interval", () => {
    // Pre-T1 behaviour: this chain threw InvalidConfig because the
    // two sides disagreed structurally. Post-T1: the primitive
    // promotes to `{$eq:1}`, merges with `{$in:[1,2]}`, and
    // collapses to `{$eq:1}`. Verified end-to-end via matches().
    const m = mergePredicates(
      { x: 1 } as unknown as Predicate,
      { x: { $in: [1, 2] } } as unknown as Predicate,
    );
    expect(matches(m, { x: 1 })).toBe(true);
    expect(matches(m, { x: 2 })).toBe(false);
  });

  test("primitive outside operator interval → UnsatisfiablePredicate", () => {
    expectUnsatisfiable(
      () =>
        mergePredicates(
          { x: 1 } as unknown as Predicate,
          { x: { $gt: 5 } } as unknown as Predicate,
        ),
      "$eq=1",
    );
  });

  // Regression: primitive of a different type than the range bound
  // is provably unsatisfiable (boolean $eq vs numeric range, string
  // $eq vs numeric range, etc.). Without the type-compatibility
  // check inside `assertOpObjectSatisfiable`, the satisfiability
  // pass silently skipped the cross-type case and the collapse step
  // dropped the range, leaving a predicate that incorrectly accepted
  // the boolean/string value. Surfaced by the property test under
  // FC_NUM_RUNS=10000 (counterexample: a={b:false}, b={b:{$gt:0}}).
  test("boolean $eq vs numeric range → UnsatisfiablePredicate (T1 regression)", () => {
    expectUnsatisfiable(
      () =>
        mergePredicates(
          { b: false } as unknown as Predicate,
          { b: { $gt: 0 } } as unknown as Predicate,
        ),
      "type-incompatible",
    );
  });

  test("string $eq vs numeric upper bound → UnsatisfiablePredicate", () => {
    expectUnsatisfiable(
      () =>
        mergePredicates(
          { x: "p2" } as unknown as Predicate,
          { x: { $lt: 10 } } as unknown as Predicate,
        ),
      "type-incompatible",
    );
  });

  test("numeric $eq vs string range → UnsatisfiablePredicate", () => {
    expectUnsatisfiable(
      () =>
        mergePredicates(
          { x: 5 } as unknown as Predicate,
          { x: { $gte: "a" } } as unknown as Predicate,
        ),
      "type-incompatible",
    );
  });

  test("PredicateOp<V> type is re-exported from the protocol barrel", () => {
    // Smoke test: the new type flows through the protocol barrel
    // and can be used to type-cast a predicate's value position.
    const op: PredicateOp<number> = { $gte: 1, $lt: 10 };
    expect(matches({ x: op } as unknown as Predicate, { x: 5 })).toBe(true);
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
const flatPredArb: fc.Arbitrary<Predicate> = fc
  .array(fc.tuple(keyArb, valArb), { maxLength: 4 })
  .map((pairs) => {
    const out: Record<string, DocumentValue> = {};
    for (const [k, v] of pairs) {
      out[k] = v as DocumentValue;
    }
    return out as Predicate;
  });
const docArb: fc.Arbitrary<JSONObject> = fc
  .array(fc.tuple(keyArb, valArb), { maxLength: 4 })
  .map((pairs) => {
    const out: Record<string, DocumentValue> = {};
    for (const [k, v] of pairs) {
      out[k] = v as DocumentValue;
    }
    return out as JSONObject;
  });

fcTest.prop({ a: flatPredArb, b: flatPredArb, doc: docArb })(
  "matches(merge(a,b), doc) === matches(a, doc) && matches(b, doc) (when merge doesn't throw)",
  ({ a, b, doc }) => {
    let merged: Predicate;
    try {
      merged = mergePredicates(a, b);
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      return;
    }
    expect(matches(merged, doc)).toBe(matches(a, doc) && matches(b, doc));
  },
);

// Operator-aware property test: each field value is either a
// primitive or an operator object (`$eq` / `$gt` / `$lt` / `$in`).
// We validate both predicates first — only valid inputs participate
// (the validator owns the "well-formed" boundary; the property
// concerns matcher/merge agreement post-validation).
const opObjArb: fc.Arbitrary<DocumentValue> = fc
  .record(
    {
      $eq: fc.option(valArb, { nil: undefined }),
      $gt: fc.option(fc.integer({ min: -3, max: 3 }), { nil: undefined }),
      $lt: fc.option(fc.integer({ min: -3, max: 3 }), { nil: undefined }),
      $in: fc.option(fc.array(valArb, { minLength: 1, maxLength: 3 }), { nil: undefined }),
    },
    { requiredKeys: [] },
  )
  .filter((r) => Object.values(r).some((v) => v !== undefined))
  .map((r) => {
    const out: Record<string, DocumentValue> = {};
    if (r.$eq !== undefined) {
      out["$eq"] = r.$eq as DocumentValue;
    }
    if (r.$gt !== undefined) {
      out["$gt"] = r.$gt as DocumentValue;
    }
    if (r.$lt !== undefined) {
      out["$lt"] = r.$lt as DocumentValue;
    }
    if (r.$in !== undefined) {
      out["$in"] = r.$in as DocumentValue[] as unknown as DocumentValue;
    }
    return out as DocumentValue;
  });

const opPredArb: fc.Arbitrary<Predicate> = fc
  .array(fc.tuple(keyArb, fc.oneof(valArb, opObjArb)), { maxLength: 4 })
  .map((pairs) => {
    const out: Record<string, DocumentValue> = {};
    for (const [k, v] of pairs) {
      out[k] = v;
    }
    return out as Predicate;
  });

fcTest.prop({ a: opPredArb, b: opPredArb, doc: docArb })(
  "matches(merge(a,b), doc) === matches(a, doc) && matches(b, doc) — operators",
  ({ a, b, doc }) => {
    try {
      validatePredicate(a);
      validatePredicate(b);
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      return;
    }
    let merged: Predicate;
    try {
      merged = mergePredicates(a, b);
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      return;
    }
    expect(matches(merged, doc)).toBe(matches(a, doc) && matches(b, doc));
  },
);
