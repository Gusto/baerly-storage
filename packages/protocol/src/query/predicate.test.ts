import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";

import type { Predicate } from "../db.ts";
import { BaerlyError } from "../errors.ts";
import type { JSONArrayless, JSONObject } from "../json.ts";

import {
  matches,
  mergePredicates,
  predicateImplies,
  type PredicateOp,
  validatePredicate,
} from "./predicate.ts";

const expectInvalidConfig = (fn: () => unknown, snippet: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("InvalidConfig");
    expect((err as BaerlyError).message).toContain(snippet);
    return;
  }
  throw new Error(`Expected BaerlyError{InvalidConfig}, none thrown`);
};

const expectUnsatisfiable = (fn: () => unknown, snippet: string): void => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("UnsatisfiablePredicate");
    expect((err as BaerlyError).message).toContain(snippet);
    return;
  }
  throw new Error(`Expected BaerlyError{UnsatisfiablePredicate}, none thrown`);
};

describe("validatePredicate — happy paths", () => {
  test("accepts top-level equality on string / number / boolean", () => {
    validatePredicate({ status: "open" });
    validatePredicate({ count: 7 });
    validatePredicate({ archived: false });
  });

  test("accepts dotted-path keys", () => {
    validatePredicate({ "assignee.team": "platform" });
    validatePredicate({ "a.b.c.d": 1 });
  });

  test("accepts nested-object sub-predicates", () => {
    validatePredicate({ assignee: { team: "platform" } });
    validatePredicate({ a: { b: { c: 1 } } });
  });

  test("accepts an empty predicate (matches everything)", () => {
    validatePredicate({});
  });

  test("returns its input unchanged", () => {
    const p: Predicate = { status: "open" };
    expect(validatePredicate(p)).toBe(p);
  });
});

describe("validatePredicate — rejections", () => {
  test('rejects "$"-prefixed operator at top level', () => {
    expectInvalidConfig(() => validatePredicate({ $or: "x" } as unknown as Predicate), '"$or"');
    expectInvalidConfig(() => validatePredicate({ $gt: 1 } as unknown as Predicate), '"$gt"');
    expectInvalidConfig(() => validatePredicate({ $in: "x" } as unknown as Predicate), '"$in"');
    expectInvalidConfig(
      () => validatePredicate({ $regex: "x" } as unknown as Predicate),
      '"$regex"',
    );
  });

  test('rejects unsupported "$"-prefixed operator nested under a sub-predicate', () => {
    // T1 widens validation so nested `$gt`/`$in`/etc. are accepted as
    // operator-object values; only operators outside the supported
    // vocabulary (`$or`, `$regex`, etc.) still reject. See the new
    // "validatePredicate — operator-object" block below for the
    // positive coverage.
    expectInvalidConfig(
      () => validatePredicate({ a: { $or: "x" } } as unknown as Predicate),
      '"$or"',
    );
    expectInvalidConfig(
      () => validatePredicate({ a: { b: { $regex: "x" } } } as unknown as Predicate),
      '"$regex"',
    );
  });

  test("rejects null / undefined values", () => {
    expectInvalidConfig(() => validatePredicate({ x: null } as unknown as Predicate), "null");
    expectInvalidConfig(
      () => validatePredicate({ x: undefined } as unknown as Predicate),
      "undefined",
    );
  });

  test("rejects array values (no $in: [...])", () => {
    expectInvalidConfig(() => validatePredicate({ x: [1, 2] } as unknown as Predicate), "array");
  });

  test("rejects __proto__ / constructor / prototype keys", () => {
    // Object literal `{ __proto__: ... }` is a prototype-setter, not an
    // own key — `Object.keys` won't see it. Use `JSON.parse` (or a
    // computed key) so `__proto__` becomes an actual own property of
    // the predicate, mirroring how a malicious payload would arrive.
    expectInvalidConfig(
      () => validatePredicate(JSON.parse('{"__proto__":"x"}') as Predicate),
      "__proto__",
    );
    expectInvalidConfig(
      () => validatePredicate({ constructor: "x" } as unknown as Predicate),
      "constructor",
    );
    expectInvalidConfig(
      () => validatePredicate({ prototype: "x" } as unknown as Predicate),
      "prototype",
    );
  });

  test("rejects NaN / Infinity (don't round-trip through JSON)", () => {
    expectInvalidConfig(() => validatePredicate({ x: NaN } as unknown as Predicate), "NaN");
    expectInvalidConfig(
      () => validatePredicate({ x: Infinity } as unknown as Predicate),
      "Infinity",
    );
    expectInvalidConfig(
      () => validatePredicate({ x: -Infinity } as unknown as Predicate),
      "Infinity",
    );
  });
});

describe("matches — equality and traversal", () => {
  test("top-level equality match and miss", () => {
    expect(matches({ status: "open" }, { status: "open" })).toBe(true);
    expect(matches({ status: "open" }, { status: "closed" })).toBe(false);
    expect(matches({ status: "open" }, {})).toBe(false);
  });

  test("dotted-path traversal hit and miss", () => {
    const doc: JSONObject = { assignee: { team: "platform", oncall: "a" } };
    expect(matches({ "assignee.team": "platform" }, doc)).toBe(true);
    expect(matches({ "assignee.team": "billing" }, doc)).toBe(false);
    expect(matches({ "assignee.missing": "platform" }, doc)).toBe(false);
  });

  test("sub-predicate as open-world filter (extra doc keys allowed)", () => {
    const doc: JSONObject = { assignee: { team: "platform", oncall: "a" } };
    expect(matches({ assignee: { team: "platform" } }, doc)).toBe(true);
    expect(matches({ assignee: { team: "billing" } }, doc)).toBe(false);
  });

  test("sub-predicate fails when doc lacks the key", () => {
    expect(matches({ assignee: { team: "platform" } }, {})).toBe(false);
  });

  test("path traversal stops at primitive / null / array", () => {
    expect(matches({ "a.b": "c" }, { a: "literal" })).toBe(false);
    expect(matches({ "a.b": "c" }, { a: null } as unknown as JSONObject)).toBe(false);
    expect(matches({ "a.b": "c" }, { a: [1, 2] })).toBe(false);
  });

  test("sub-predicate against array / null / primitive in doc is false", () => {
    expect(matches({ a: { b: "c" } }, { a: "literal" })).toBe(false);
    expect(matches({ a: { b: "c" } }, { a: null } as unknown as JSONObject)).toBe(false);
    expect(matches({ a: { b: "c" } }, { a: [1, 2] })).toBe(false);
  });

  test("empty predicate matches every document", () => {
    expect(matches({}, {})).toBe(true);
    expect(matches({}, { a: 1, b: "x", nested: { d: true } })).toBe(true);
    expect(matches({}, { arr: [1, 2, 3] })).toBe(true);
  });

  test("number / boolean equality", () => {
    expect(matches({ count: 7 }, { count: 7 })).toBe(true);
    expect(matches({ count: 7 }, { count: 8 })).toBe(false);
    expect(matches({ archived: false }, { archived: false })).toBe(true);
    expect(matches({ archived: false }, { archived: true })).toBe(false);
  });

  test("AND-conjunction across multiple top-level keys", () => {
    const doc: JSONObject = { status: "open", priority: "p1" };
    expect(matches({ status: "open", priority: "p1" }, doc)).toBe(true);
    expect(matches({ status: "open", priority: "p2" }, doc)).toBe(false);
  });

  test("type mismatch on a terminal value is a miss, not a throw", () => {
    expect(matches({ count: 7 }, { count: "7" } as unknown as JSONObject)).toBe(false);
    expect(matches({ archived: false }, { archived: "false" } as unknown as JSONObject)).toBe(
      false,
    );
  });
});

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

describe("validatePredicate — operator-object", () => {
  test("accepts $eq alone on string / number / boolean", () => {
    validatePredicate({ status: { $eq: "open" } } as unknown as Predicate);
    validatePredicate({ count: { $eq: 7 } } as unknown as Predicate);
    validatePredicate({ archived: { $eq: false } } as unknown as Predicate);
  });

  test("accepts $gt / $gte / $lt / $lte on numbers", () => {
    validatePredicate({ count: { $gt: 5 } } as unknown as Predicate);
    validatePredicate({ count: { $gte: 5 } } as unknown as Predicate);
    validatePredicate({ count: { $lt: 10 } } as unknown as Predicate);
    validatePredicate({ count: { $lte: 10 } } as unknown as Predicate);
    validatePredicate({ count: { $gte: 1, $lt: 10 } } as unknown as Predicate);
  });

  test("accepts $gt / $gte / $lt / $lte on ISO date strings", () => {
    validatePredicate({
      created_at: { $gte: "2026-01-01", $lt: "2026-02-01" },
    } as unknown as Predicate);
  });

  test("accepts $in with primitive members", () => {
    validatePredicate({ priority: { $in: ["p1", "p2", "p3"] } } as unknown as Predicate);
    validatePredicate({ count: { $in: [1, 2, 3] } } as unknown as Predicate);
    validatePredicate({ archived: { $in: [true, false] } } as unknown as Predicate);
  });

  test("accepts dotted-path key with operator value", () => {
    validatePredicate({
      "assignee.priority": { $in: ["p1", "p2"] },
    } as unknown as Predicate);
  });

  test("accepts x: {} as a match-all sub-predicate (not an op-object)", () => {
    // Empty object falls through op-detection (length === 0) into
    // the equality-walker — a match-all sub-predicate, which is the
    // documented behaviour.
    validatePredicate({ x: {} } as unknown as Predicate);
  });

  test("rejects unknown operator ($regex / $or)", () => {
    expectInvalidConfig(
      () => validatePredicate({ x: { $regex: "x" } } as unknown as Predicate),
      '"$regex"',
    );
    expectInvalidConfig(
      () => validatePredicate({ x: { $or: 1 } } as unknown as Predicate),
      '"$or"',
    );
  });

  test("rejects mixed operator + non-operator keys", () => {
    // Outer predicate-mode `$`-key check fires.
    expectInvalidConfig(
      () => validatePredicate({ x: { $eq: 1, y: 2 } } as unknown as Predicate),
      '"$eq"',
    );
  });

  test("rejects $in: [] as UnsatisfiablePredicate", () => {
    expectUnsatisfiable(() => validatePredicate({ x: { $in: [] } } as unknown as Predicate), "$in");
  });

  test("rejects range op on boolean / null / nested-object bound", () => {
    expectInvalidConfig(
      () => validatePredicate({ x: { $gt: true } } as unknown as Predicate),
      "boolean",
    );
    expectInvalidConfig(
      () => validatePredicate({ x: { $gt: null } } as unknown as Predicate),
      "null",
    );
    expectInvalidConfig(
      () => validatePredicate({ x: { $gt: { y: 1 } } } as unknown as Predicate),
      "nested object",
    );
  });

  test("rejects range op with NaN / Infinity bound", () => {
    expectInvalidConfig(
      () => validatePredicate({ x: { $gt: NaN } } as unknown as Predicate),
      "NaN",
    );
    expectInvalidConfig(
      () => validatePredicate({ x: { $lt: Infinity } } as unknown as Predicate),
      "Infinity",
    );
  });

  test("rejects $eq + range whose interval excludes $eq", () => {
    expectUnsatisfiable(
      () => validatePredicate({ x: { $eq: 1, $gt: 5 } } as unknown as Predicate),
      "$eq=1",
    );
    expectUnsatisfiable(
      () => validatePredicate({ x: { $eq: 10, $lt: 5 } } as unknown as Predicate),
      "$eq=10",
    );
  });

  test("rejects lo > hi and strict-tie ($gt:5, $lte:5)", () => {
    expectUnsatisfiable(
      () => validatePredicate({ x: { $gt: 10, $lt: 5 } } as unknown as Predicate),
      "empty interval",
    );
    expectUnsatisfiable(
      () => validatePredicate({ x: { $gt: 5, $lte: 5 } } as unknown as Predicate),
      "empty interval",
    );
    expectUnsatisfiable(
      () => validatePredicate({ x: { $gte: 5, $lt: 5 } } as unknown as Predicate),
      "empty interval",
    );
  });

  test("rejects $eq not present in $in set", () => {
    expectUnsatisfiable(
      () => validatePredicate({ x: { $eq: "z", $in: ["a", "b"] } } as unknown as Predicate),
      "$in set",
    );
  });

  test("rejects empty operator object at field value via mixed-keys path", () => {
    // `{ x: {} }` is a valid match-all sub-predicate; we cover the
    // explicit empty-op via the direct internal hint:
    //   `{ x: { $eq: undefined } }` is structurally an op-object via
    //   `$eq` presence but undefined value rejects in $eq validation.
    expectInvalidConfig(
      () => validatePredicate({ x: { $eq: undefined } } as unknown as Predicate),
      "undefined",
    );
  });
});

describe("matches — operator-object", () => {
  test("$eq routes through equality", () => {
    expect(matches({ status: { $eq: "open" } } as unknown as Predicate, { status: "open" })).toBe(
      true,
    );
    expect(matches({ status: { $eq: "open" } } as unknown as Predicate, { status: "closed" })).toBe(
      false,
    );
  });

  test("$gt / $gte on numbers (boundary inclusivity)", () => {
    expect(matches({ x: { $gt: 5 } } as unknown as Predicate, { x: 5 })).toBe(false);
    expect(matches({ x: { $gt: 5 } } as unknown as Predicate, { x: 6 })).toBe(true);
    expect(matches({ x: { $gte: 5 } } as unknown as Predicate, { x: 5 })).toBe(true);
    expect(matches({ x: { $gte: 5 } } as unknown as Predicate, { x: 4 })).toBe(false);
  });

  test("$lt / $lte on numbers (boundary inclusivity)", () => {
    expect(matches({ x: { $lt: 5 } } as unknown as Predicate, { x: 5 })).toBe(false);
    expect(matches({ x: { $lt: 5 } } as unknown as Predicate, { x: 4 })).toBe(true);
    expect(matches({ x: { $lte: 5 } } as unknown as Predicate, { x: 5 })).toBe(true);
    expect(matches({ x: { $lte: 5 } } as unknown as Predicate, { x: 6 })).toBe(false);
  });

  test("range ops on ISO date strings", () => {
    const p = {
      created_at: { $gte: "2026-01-01", $lt: "2026-02-01" },
    } as unknown as Predicate;
    expect(matches(p, { created_at: "2025-12-31" })).toBe(false);
    expect(matches(p, { created_at: "2026-01-01" })).toBe(true);
    expect(matches(p, { created_at: "2026-01-15" })).toBe(true);
    expect(matches(p, { created_at: "2026-02-01" })).toBe(false);
    expect(matches(p, { created_at: "2026-02-15" })).toBe(false);
  });

  test("range ops always-miss on type-mismatch / boolean / null / missing", () => {
    // Numeric bound vs. string actual → miss, not throw.
    expect(
      matches({ x: { $gte: 1 } } as unknown as Predicate, { x: "1" } as unknown as JSONObject),
    ).toBe(false);
    // String bound vs. number actual → miss.
    expect(
      matches({ x: { $gte: "a" } } as unknown as Predicate, { x: 1 } as unknown as JSONObject),
    ).toBe(false);
    // Missing key → miss.
    expect(matches({ x: { $gte: 1 } } as unknown as Predicate, {})).toBe(false);
    // Null actual → miss.
    expect(
      matches({ x: { $gte: 1 } } as unknown as Predicate, { x: null } as unknown as JSONObject),
    ).toBe(false);
  });

  test("$in primitive membership", () => {
    expect(
      matches({ priority: { $in: ["p1", "p2"] } } as unknown as Predicate, { priority: "p1" }),
    ).toBe(true);
    expect(
      matches({ priority: { $in: ["p1", "p2"] } } as unknown as Predicate, { priority: "p3" }),
    ).toBe(false);
    expect(matches({ x: { $in: [1, 2, 3] } } as unknown as Predicate, { x: 2 })).toBe(true);
    expect(matches({ x: { $in: [1, 2, 3] } } as unknown as Predicate, { x: 4 })).toBe(false);
  });

  test("$in sub-predicate members (open-world)", () => {
    const p = {
      assignee: { $in: [{ team: "platform" }, { team: "billing" }] },
    } as unknown as Predicate;
    expect(matches(p, { assignee: { team: "platform", oncall: "a" } })).toBe(true);
    expect(matches(p, { assignee: { team: "billing" } })).toBe(true);
    expect(matches(p, { assignee: { team: "growth" } })).toBe(false);
  });

  test("dotted-path key with operator value", () => {
    const doc: JSONObject = { meta: { count: 7 } };
    expect(matches({ "meta.count": { $gte: 5 } } as unknown as Predicate, doc)).toBe(true);
    expect(matches({ "meta.count": { $gte: 10 } } as unknown as Predicate, doc)).toBe(false);
  });

  test("AND across multiple ops on one field", () => {
    const p = { count: { $gte: 1, $lt: 10 } } as unknown as Predicate;
    expect(matches(p, { count: 0 })).toBe(false);
    expect(matches(p, { count: 1 })).toBe(true);
    expect(matches(p, { count: 9 })).toBe(true);
    expect(matches(p, { count: 10 })).toBe(false);
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

  test("PredicateOp<V> type is re-exported from the predicate module", () => {
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
    const out: Record<string, JSONArrayless> = {};
    for (const [k, v] of pairs) out[k] = v as JSONArrayless;
    return out as Predicate;
  });
const docArb: fc.Arbitrary<JSONObject> = fc
  .array(fc.tuple(keyArb, valArb), { maxLength: 4 })
  .map((pairs) => {
    const out: Record<string, JSONArrayless> = {};
    for (const [k, v] of pairs) out[k] = v as JSONArrayless;
    return out as JSONObject;
  });

fcTest.prop({ a: flatPredArb, b: flatPredArb, doc: docArb })(
  "matches(merge(a,b), doc) === matches(a, doc) && matches(b, doc) (when merge doesn't throw)",
  ({ a, b, doc }) => {
    let merged: Predicate;
    try {
      merged = mergePredicates(a, b);
    } catch (err) {
      expect(err).toBeInstanceOf(BaerlyError);
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
const opObjArb: fc.Arbitrary<JSONArrayless> = fc
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
    const out: Record<string, JSONArrayless> = {};
    if (r.$eq !== undefined) out.$eq = r.$eq as JSONArrayless;
    if (r.$gt !== undefined) out.$gt = r.$gt as JSONArrayless;
    if (r.$lt !== undefined) out.$lt = r.$lt as JSONArrayless;
    if (r.$in !== undefined) out.$in = r.$in as JSONArrayless[] as unknown as JSONArrayless;
    return out as JSONArrayless;
  });

const opPredArb: fc.Arbitrary<Predicate> = fc
  .array(fc.tuple(keyArb, fc.oneof(valArb, opObjArb)), { maxLength: 4 })
  .map((pairs) => {
    const out: Record<string, JSONArrayless> = {};
    for (const [k, v] of pairs) out[k] = v;
    return out as Predicate;
  });

fcTest.prop({ a: opPredArb, b: opPredArb, doc: docArb })(
  "matches(merge(a,b), doc) === matches(a, doc) && matches(b, doc) — operators",
  ({ a, b, doc }) => {
    try {
      validatePredicate(a);
      validatePredicate(b);
    } catch (err) {
      expect(err).toBeInstanceOf(BaerlyError);
      return;
    }
    let merged: Predicate;
    try {
      merged = mergePredicates(a, b);
    } catch (err) {
      expect(err).toBeInstanceOf(BaerlyError);
      return;
    }
    expect(matches(merged, doc)).toBe(matches(a, doc) && matches(b, doc));
  },
);

describe("predicateImplies", () => {
  // Helper to construct predicates without TypeScript's literal-type
  // narrowing. The runtime predicate type is far more permissive
  // than the declared `Predicate<T>` (which keys off the doc shape);
  // tests over arbitrary fixtures use the open-world JSONArrayless
  // shape directly.
  const P = (p: Record<string, JSONArrayless>): Predicate => p as unknown as Predicate;

  test("identical equality predicates → true", () => {
    expect(predicateImplies(P({ status: "open" }), P({ status: "open" }))).toBe(true);
  });

  test("query is a strict superset of filter → true", () => {
    expect(predicateImplies(P({ status: "open" }), P({ status: "open", assignee: "alice" }))).toBe(
      true,
    );
  });

  test("mismatched primitive value → false", () => {
    expect(predicateImplies(P({ status: "open" }), P({ status: "closed" }))).toBe(false);
  });

  test("missing key in queryPredicate → false", () => {
    expect(predicateImplies(P({ status: "open" }), P({ assignee: "a" }))).toBe(false);
  });

  test("nested object equality → true", () => {
    expect(
      predicateImplies(
        P({ assignee: { team: "platform" } }),
        P({ assignee: { team: "platform" } }),
      ),
    ).toBe(true);
  });

  test("nested object — primitive on query side → false", () => {
    expect(predicateImplies(P({ assignee: { team: "p" } }), P({ assignee: "literal" }))).toBe(
      false,
    );
  });

  test("nested object — mismatched leaf → false", () => {
    expect(
      predicateImplies(P({ assignee: { team: "p" } }), P({ assignee: { team: "infra" } })),
    ).toBe(false);
  });

  test("operator-shaped indexFilter → false (conservative deferred)", () => {
    expect(predicateImplies(P({ age: { $gte: 18 } }), P({ age: 21 }))).toBe(false);
  });

  test("empty indexFilter → true (vacuously implied)", () => {
    expect(predicateImplies({}, P({ status: "open" }))).toBe(true);
    expect(predicateImplies({}, {})).toBe(true);
  });

  test("soundness — when implied, matches(query, doc) ⇒ matches(filter, doc)", () => {
    // Pin the load-bearing soundness property: when
    // predicateImplies(filter, query) is `true`,
    // matches(query, doc) ⇒ matches(filter, doc) for any doc.
    const filter = P({ status: "open" });
    const query = P({ status: "open", priority: "p1" });
    expect(predicateImplies(filter, query)).toBe(true);
    const matchingDoc: JSONObject = { status: "open", priority: "p1", assignee: "alice" };
    expect(matches(query, matchingDoc)).toBe(true);
    expect(matches(filter, matchingDoc)).toBe(true);
  });
});
