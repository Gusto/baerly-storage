import { describe, expect, test } from "vitest";

import { BaerlyError } from "../errors.ts";

import { normalizeObject, normalizePredicateArg } from "./normalize.ts";
import { validateWire } from "./validate.ts";
import type { PredicateWire } from "./wire.ts";

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

describe("validateWire — happy paths", () => {
  test("accepts an empty wire (matches everything)", () => {
    expect(validateWire({ clauses: [] })).toEqual({ clauses: [] });
  });

  test("accepts a single eq clause on string / number / boolean", () => {
    validateWire({ clauses: [{ op: "eq", field: "status", value: "open" }] });
    validateWire({ clauses: [{ op: "eq", field: "count", value: 7 }] });
    validateWire({ clauses: [{ op: "eq", field: "archived", value: false }] });
  });

  test("accepts dotted-path fields", () => {
    validateWire({ clauses: [{ op: "eq", field: "assignee.team", value: "platform" }] });
    validateWire({ clauses: [{ op: "eq", field: "a.b.c.d", value: 1 }] });
  });

  test("accepts range clauses (gt / gte / lt / lte) on numbers", () => {
    validateWire({ clauses: [{ op: "gt", field: "count", value: 5 }] });
    validateWire({ clauses: [{ op: "gte", field: "count", value: 5 }] });
    validateWire({ clauses: [{ op: "lt", field: "count", value: 10 }] });
    validateWire({ clauses: [{ op: "lte", field: "count", value: 10 }] });
    validateWire({
      clauses: [
        { op: "gte", field: "count", value: 1 },
        { op: "lt", field: "count", value: 10 },
      ],
    });
  });

  test("accepts range clauses on ISO date strings", () => {
    validateWire({
      clauses: [
        { op: "gte", field: "created_at", value: "2026-01-01" },
        { op: "lt", field: "created_at", value: "2026-02-01" },
      ],
    });
  });

  test("accepts in clauses with primitive members", () => {
    validateWire({ clauses: [{ op: "in", field: "priority", value: ["p1", "p2", "p3"] }] });
    validateWire({ clauses: [{ op: "in", field: "count", value: [1, 2, 3] }] });
    validateWire({ clauses: [{ op: "in", field: "archived", value: [true, false] }] });
  });

  test("returns its input unchanged on success", () => {
    const wire: PredicateWire = { clauses: [{ op: "eq", field: "status", value: "open" }] };
    expect(validateWire(wire)).toBe(wire);
  });
});

describe("validateWire — rejections (structural)", () => {
  test("rejects malformed wire shape", () => {
    expectInvalidConfig(() => validateWire(null as unknown as PredicateWire), "clauses");
    expectInvalidConfig(() => validateWire({} as unknown as PredicateWire), "clauses");
    expectInvalidConfig(
      () => validateWire({ clauses: "x" } as unknown as PredicateWire),
      "clauses",
    );
  });

  test("rejects clauses with unsupported op", () => {
    expectInvalidConfig(
      () => validateWire({ clauses: [{ op: "regex", field: "x", value: "foo" } as never] }),
      "unsupported op",
    );
    expectInvalidConfig(
      () => validateWire({ clauses: [{ op: "ne", field: "x", value: 1 } as never] }),
      "unsupported op",
    );
  });

  test("rejects empty / non-string field names", () => {
    expectInvalidConfig(
      () => validateWire({ clauses: [{ op: "eq", field: "", value: "x" }] }),
      "empty",
    );
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "eq", field: 42 as unknown as string, value: "x" }],
        }),
      "empty",
    );
  });

  test("rejects top-level _id field", () => {
    expectInvalidConfig(
      () => validateWire({ clauses: [{ op: "eq", field: "_id", value: "x" }] }),
      "_id",
    );
  });

  test("rejects nested _id.<path> field (matches Path<T>'s `_id.${string}` exclusion)", () => {
    expectInvalidConfig(
      () => validateWire({ clauses: [{ op: "eq", field: "_id.x", value: "x" }] }),
      "_id",
    );
  });

  test("rejects null / undefined values on eq clauses", () => {
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "eq", field: "x", value: null as unknown as string }],
        }),
      "null",
    );
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "eq", field: "x", value: undefined as unknown as string }],
        }),
      "undefined",
    );
  });

  test("rejects NaN / Infinity (don't round-trip through JSON)", () => {
    expectInvalidConfig(
      () => validateWire({ clauses: [{ op: "eq", field: "x", value: NaN }] }),
      "NaN",
    );
    expectInvalidConfig(
      () => validateWire({ clauses: [{ op: "gt", field: "x", value: Infinity }] }),
      "Infinity",
    );
    expectInvalidConfig(
      () => validateWire({ clauses: [{ op: "lt", field: "x", value: -Infinity }] }),
      "Infinity",
    );
  });

  test("rejects range bounds with boolean / null / nested object", () => {
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "gt", field: "x", value: true as unknown as number }],
        }),
      "boolean",
    );
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "gt", field: "x", value: null as unknown as number }],
        }),
      "null",
    );
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [
            {
              op: "gt",
              field: "x",
              value: { y: 1 } as unknown as number,
            },
          ],
        }),
      "nested object",
    );
  });

  test("rejects array value on non-in clauses", () => {
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "eq", field: "x", value: [1, 2] as unknown as number }],
        }),
      "array",
    );
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "gt", field: "x", value: [1, 2] as unknown as number }],
        }),
      "array",
    );
  });

  test("rejects non-array value on in clauses", () => {
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "in", field: "x", value: "x" as unknown as string }],
        }),
      "array",
    );
  });

  test("rejects empty `in` value array as UnsatisfiablePredicate", () => {
    expectUnsatisfiable(
      () => validateWire({ clauses: [{ op: "in", field: "priority", value: [] }] }),
      "empty value array",
    );
  });

  test("rejects null / undefined members inside an in clause", () => {
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "in", field: "x", value: [1, null as unknown as number] }],
        }),
      "null",
    );
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "in", field: "x", value: [1, undefined as unknown as number] }],
        }),
      "undefined",
    );
  });
});

describe("validateWire — satisfiability (cross-clause)", () => {
  test("rejects conflicting eq clauses on the same field", () => {
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [
            { op: "eq", field: "status", value: "open" },
            { op: "eq", field: "status", value: "closed" },
          ],
        }),
      "Conflicting equality",
    );
  });

  test("rejects empty interval (lo > hi)", () => {
    expectUnsatisfiable(
      () =>
        validateWire({
          clauses: [
            { op: "gt", field: "x", value: 10 },
            { op: "lt", field: "x", value: 5 },
          ],
        }),
      "empty interval",
    );
  });

  test("rejects strict-tie ($gt:5, $lte:5) interval", () => {
    expectUnsatisfiable(
      () =>
        validateWire({
          clauses: [
            { op: "gt", field: "x", value: 5 },
            { op: "lte", field: "x", value: 5 },
          ],
        }),
      "empty interval",
    );
  });

  test("rejects eq value outside the residual interval", () => {
    expectUnsatisfiable(
      () =>
        validateWire({
          clauses: [
            { op: "eq", field: "x", value: 1 },
            { op: "gt", field: "x", value: 5 },
          ],
        }),
      "excluded by lower bound",
    );
    expectUnsatisfiable(
      () =>
        validateWire({
          clauses: [
            { op: "eq", field: "x", value: 10 },
            { op: "lt", field: "x", value: 5 },
          ],
        }),
      "excluded by upper bound",
    );
  });

  test("rejects eq value not present in an in() set", () => {
    expectUnsatisfiable(
      () =>
        validateWire({
          clauses: [
            { op: "eq", field: "x", value: "z" },
            { op: "in", field: "x", value: ["a", "b"] },
          ],
        }),
      "not present in in()",
    );
  });

  test("rejects two in() clauses with empty intersection", () => {
    expectUnsatisfiable(
      () =>
        validateWire({
          clauses: [
            { op: "in", field: "x", value: ["a", "b"] },
            { op: "in", field: "x", value: ["c", "d"] },
          ],
        }),
      "empty in() intersection",
    );
  });
});

describe("normalizeObject — rejections (object-form pre-walk)", () => {
  // The pre-redesign `validatePredicate` rejected $-keys on the way in.
  // Post-redesign, `validateWire` never sees a $-key (it ingests
  // already-flat wire clauses), so the rejection lifted into the
  // normaliser. These tests pin that the normaliser surface still
  // catches every shape the old validator did.

  test('rejects "$"-prefixed operator at top level', () => {
    expectInvalidConfig(() => normalizeObject({ $or: "x" }, []), '"$or"');
    expectInvalidConfig(() => normalizeObject({ $or: "x" }, []), "operator vocabulary");
    expectInvalidConfig(() => normalizeObject({ $gt: 1 }, []), '"$gt"');
    expectInvalidConfig(() => normalizeObject({ $in: "x" }, []), '"$in"');
    expectInvalidConfig(() => normalizeObject({ $regex: "x" }, []), '"$regex"');
  });

  test('rejects "$"-prefixed operator nested under a sub-predicate', () => {
    expectInvalidConfig(() => normalizeObject({ a: { $or: "x" } }, []), '"$or"');
    expectInvalidConfig(() => normalizeObject({ a: { b: { $regex: "x" } } }, []), '"$regex"');
  });

  test("rejects null / undefined values", () => {
    expectInvalidConfig(() => normalizeObject({ x: null as unknown as string }, []), "null");
    expectInvalidConfig(
      () => normalizeObject({ x: undefined as unknown as string }, []),
      "undefined",
    );
  });

  test("rejects array values", () => {
    expectInvalidConfig(() => normalizeObject({ x: [1, 2] as unknown as string }, []), "array");
  });

  test("rejects __proto__ / constructor / prototype keys", () => {
    // Object literal `{ __proto__: ... }` is a prototype-setter, not an
    // own key — `Object.keys` won't see it. Use `JSON.parse` so
    // `__proto__` becomes an actual own property, mirroring how a
    // malicious payload would arrive.
    expectInvalidConfig(() => normalizeObject(JSON.parse('{"__proto__":"x"}'), []), "__proto__");
    expectInvalidConfig(() => normalizeObject({ constructor: "x" }, []), "constructor");
    expectInvalidConfig(() => normalizeObject({ prototype: "x" }, []), "prototype");
  });

  test("rejects NaN / Infinity values", () => {
    expectInvalidConfig(() => normalizeObject({ x: NaN }, []), "NaN");
    expectInvalidConfig(() => normalizeObject({ x: Infinity }, []), "Infinity");
    expectInvalidConfig(() => normalizeObject({ x: -Infinity }, []), "Infinity");
  });

  test("normalizePredicateArg threads $-key rejections", () => {
    // Surfaces the same throws when called via the public dispatch.
    expectInvalidConfig(() => normalizePredicateArg({ $or: "x" } as never), "$or");
  });
});
