import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";

import type { Predicate } from "../db";
import { BaerlyError } from "../errors";
import type { JSONArrayless, JSONObject } from "../json";

import { matches, mergePredicates, validatePredicate } from "./predicate";

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

  test('rejects "$"-prefixed operator nested under a sub-predicate', () => {
    expectInvalidConfig(
      () => validatePredicate({ a: { $or: "x" } } as unknown as Predicate),
      '"$or"',
    );
    expectInvalidConfig(
      () => validatePredicate({ a: { b: { $gt: 1 } } } as unknown as Predicate),
      '"$gt"',
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
      expect((err as BaerlyError).code).toBe("InvalidConfig");
      return;
    }
    expect(matches(merged, doc)).toBe(matches(a, doc) && matches(b, doc));
  },
);
