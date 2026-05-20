import { describe, expect, test } from "vitest";

import type { Predicate } from "../table-api.ts";
import { BaerlyError } from "../errors.ts";

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
