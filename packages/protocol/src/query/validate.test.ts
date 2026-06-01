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

  test("rejects non-object wire with a .clauses array (kills L45 typeof-guard mutant)", () => {
    // L45: `typeof wire !== "object"` ConditionalExpression→false.
    // A plain number/string still triggers the `!Array.isArray(wire.clauses)` check because
    // `(42).clauses` is `undefined`. The only input that can distinguish the two is a
    // non-object (typeof !== "object") that *also* has a `.clauses` array — e.g. a function
    // with a `.clauses` property assigned.  With the mutant the condition becomes
    // `wire === null || false || !Array.isArray(wire.clauses)`, and since `wire.clauses` IS
    // an array, the throw is bypassed.  Without the mutant, `typeof fn !== "object"` is true
    // and the throw fires.
    const fnWithClauses = Object.assign(() => {}, { clauses: [] }) as unknown as PredicateWire;
    expectInvalidConfig(() => validateWire(fnWithClauses), "clauses");
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

describe("validateWire — RANGE_OPS routing (kills gte/lt/lte string-literal mutants)", () => {
  // If Stryker empties one of the RANGE_OPS strings (e.g. "gte"→""),
  // that op falls through to validateScalar instead of validateRangeBound.
  // validateRangeBound rejects booleans and nested objects; validateScalar
  // accepts them.  Asserting InvalidConfig with "boolean" / "nested object"
  // for every RANGE_OP kills those literal mutants.

  test("gte rejects boolean value (routes to validateRangeBound, not validateScalar)", () => {
    expectInvalidConfig(
      () =>
        validateWire({ clauses: [{ op: "gte", field: "x", value: true as unknown as number }] }),
      "boolean",
    );
  });

  test("lt rejects boolean value (routes to validateRangeBound, not validateScalar)", () => {
    expectInvalidConfig(
      () => validateWire({ clauses: [{ op: "lt", field: "x", value: true as unknown as number }] }),
      "boolean",
    );
  });

  test("lte rejects boolean value (routes to validateRangeBound, not validateScalar)", () => {
    expectInvalidConfig(
      () =>
        validateWire({ clauses: [{ op: "lte", field: "x", value: true as unknown as number }] }),
      "boolean",
    );
  });

  test("gt rejects nested object value (routes to validateRangeBound)", () => {
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "gt", field: "x", value: { a: 1 } as unknown as number }],
        }),
      "nested object",
    );
  });

  test("gte rejects nested object value (routes to validateRangeBound)", () => {
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "gte", field: "x", value: { a: 1 } as unknown as number }],
        }),
      "nested object",
    );
  });

  test("lt rejects nested object value (routes to validateRangeBound)", () => {
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "lt", field: "x", value: { a: 1 } as unknown as number }],
        }),
      "nested object",
    );
  });

  test("lte rejects nested object value (routes to validateRangeBound)", () => {
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "lte", field: "x", value: { a: 1 } as unknown as number }],
        }),
      "nested object",
    );
  });
});

describe("validateWire — wire-shape guard (kills L45 typeof-check mutant)", () => {
  // L45: `typeof wire !== "object"` — if forced to false the condition
  // collapses to `wire === null` only. A number like 42 would slip through.

  test("rejects a number as the wire shape (not null, not object)", () => {
    expectInvalidConfig(() => validateWire(42 as unknown as PredicateWire), "clauses");
  });

  test("rejects a string as the wire shape", () => {
    expectInvalidConfig(() => validateWire("foo" as unknown as PredicateWire), "clauses");
  });
});

describe("validateWire — clause-guard branches (kills L61 mutants)", () => {
  // L61: `clause === null || typeof clause !== "object"` — various mutants
  // collapse the condition. Need tests that pass null and a primitive directly.

  test("rejects null clause at index 0", () => {
    expectInvalidConfig(
      () => validateWire({ clauses: [null as unknown as never] }),
      "must be an object",
    );
  });

  test("rejects number clause at index 0", () => {
    expectInvalidConfig(
      () => validateWire({ clauses: [42 as unknown as never] }),
      "must be an object",
    );
  });

  test("rejects string clause at index 0", () => {
    expectInvalidConfig(
      () => validateWire({ clauses: ["bad" as unknown as never] }),
      "must be an object",
    );
  });

  test("rejects null clause mid-array (non-zero index)", () => {
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "eq", field: "x", value: "a" }, null as unknown as never],
        }),
      "must be an object",
    );
  });

  test("error message contains the clause index", () => {
    // L63 / L64 StringLiteral mutants: kills empty-string replacements of
    // the message template segments.
    try {
      validateWire({ clauses: [null as unknown as never] });
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).code).toBe("InvalidConfig");
      expect((error as BaerlyError).message).toContain("index 0");
    }
  });
});

describe("validateWire — op-guard message (kills L68 / L71 mutants)", () => {
  // L68 ConditionalExpression→false: if the guard is always false the
  // throw never fires even for unknown ops. Existing tests cover this but
  // asserting the error CODE here makes the assertion tighter.
  // L71 StringLiteral→"": message fragment "unsupported op" emptied — need
  // .toContain on it.

  test("throws InvalidConfig with code on unsupported op (not just any error)", () => {
    let thrown: unknown;
    try {
      validateWire({ clauses: [{ op: "BOGUS" as never, field: "x", value: "v" }] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BaerlyError);
    expect((thrown as BaerlyError).code).toBe("InvalidConfig");
    expect((thrown as BaerlyError).message).toContain("unsupported op");
    // The message also embeds the op name:
    expect((thrown as BaerlyError).message).toContain("BOGUS");
    // L71 StringLiteral: OP_NAMES.join(" / ") → OP_NAMES.join(""). The " / " separator
    // is observable — assert it so the empty-string mutant dies.
    expect((thrown as BaerlyError).message).toContain(" / ");
  });

  test("does NOT throw for every valid op — kills ConditionalExpression→true mutant", () => {
    // If the guard were forced to `true`, all valid ops would throw.
    // Confirming each op is accepted pins that branch.
    expect(() => validateWire({ clauses: [{ op: "eq", field: "x", value: 1 }] })).not.toThrow();
    expect(() => validateWire({ clauses: [{ op: "gt", field: "x", value: 1 }] })).not.toThrow();
    expect(() => validateWire({ clauses: [{ op: "gte", field: "x", value: 1 }] })).not.toThrow();
    expect(() => validateWire({ clauses: [{ op: "lt", field: "x", value: 1 }] })).not.toThrow();
    expect(() => validateWire({ clauses: [{ op: "lte", field: "x", value: 1 }] })).not.toThrow();
    expect(() => validateWire({ clauses: [{ op: "in", field: "x", value: ["a"] }] })).not.toThrow();
  });
});

describe("validateMemberValue — full branch coverage (kills L127-L152 mutants)", () => {
  // The NoCoverage items at L133-L152 mean the array-check + type-check +
  // finite-check branches inside validateMemberValue are not exercised at all.

  test("rejects an array as an in-clause member (L133 array check)", () => {
    // L133 BlockStatement / ConditionalExpression mutants.
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "in", field: "x", value: [[1, 2] as unknown as string] }],
        }),
      "array",
    );
  });

  test("array member error message includes clause and member indices (L135 / L136 strings)", () => {
    try {
      validateWire({
        clauses: [{ op: "in", field: "x", value: [[1, 2] as unknown as string] }],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).message).toContain("index 0");
      expect((error as BaerlyError).message).toContain("member 0");
    }
  });

  test("accepts a nested-object member (L140 ConditionalExpression must stay true for object)", () => {
    // If the `t === "object"` check were inverted or its block emptied, a
    // nested object member would fall through to the type-check below and
    // erroneously throw.
    expect(() =>
      validateWire({
        clauses: [{ op: "in", field: "x", value: [{ nested: true } as unknown as string] }],
      }),
    ).not.toThrow();
  });

  test("rejects a Symbol member — exercises L143 type-check (L143 BlockStatement / Conditional)", () => {
    // Symbol is typeof "symbol" — not string/number/boolean/object.
    // If L143's ConditionalExpression is forced to false, the throw is skipped.
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "in", field: "x", value: [Symbol("s") as unknown as string] }],
        }),
      "unsupported type",
    );
  });

  test("L145 / L146 string literals in member-type error message", () => {
    try {
      validateWire({
        clauses: [{ op: "in", field: "x", value: [Symbol("s") as unknown as string] }],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      // The message contains the type name and the member index
      expect((error as BaerlyError).message).toContain("member 0");
      expect((error as BaerlyError).message).toContain("unsupported type");
    }
  });

  test("rejects NaN member in an in-clause (L149 finite check)", () => {
    // L149 BlockStatement → {}: throw is removed; NaN member passes silently.
    // L149 ConditionalExpression→false: guard never fires.
    // L149 StringLiteral→"": "number" in typeof check becomes empty.
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "in", field: "x", value: [1, NaN] }],
        }),
      "NaN",
    );
  });

  test("rejects Infinity member in an in-clause (L149 finite check)", () => {
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "in", field: "x", value: [1, Infinity] }],
        }),
      "Infinity",
    );
  });

  test("rejects -Infinity member in an in-clause", () => {
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "in", field: "x", value: [1, -Infinity] }],
        }),
      "Infinity",
    );
  });

  test("L151 / L152 string literals in member finite-number error message", () => {
    try {
      validateWire({ clauses: [{ op: "in", field: "x", value: [NaN] }] });
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).message).toContain("member 0");
      expect((error as BaerlyError).message).toContain("NaN");
    }
  });
});

describe("validateScalar — full branch coverage (kills L158-L175 mutants)", () => {
  // validateScalar is called for op="eq" only (non-array, non-range).
  // Several branches have no coverage — adding precise tests below.

  test("rejects null eq value (L158 ConditionalExpression)", () => {
    // Already covered by the existing null-value test, but verify code too:
    let thrown: unknown;
    try {
      validateWire({ clauses: [{ op: "eq", field: "x", value: null as unknown as string }] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BaerlyError);
    expect((thrown as BaerlyError).code).toBe("InvalidConfig");
    expect((thrown as BaerlyError).message).toContain("null");
  });

  test("accepts nested-object eq value (L165 object early-return must stay)", () => {
    // L165 ConditionalExpression→false: the `return` is skipped, the object
    // falls through to the type check and throws erroneously.
    // L165 StringLiteral→"": "object" in typeof check breaks the routing.
    expect(() =>
      validateWire({
        clauses: [{ op: "eq", field: "x", value: { nested: true } as unknown as string }],
      }),
    ).not.toThrow();
  });

  test("rejects Symbol eq value — exercises L172 type-check (L172 BlockStatement / Conditional)", () => {
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "eq", field: "x", value: Symbol("s") as unknown as string }],
        }),
      "unsupported type",
    );
  });

  test("L174 / L175 string literals in scalar-type error message", () => {
    try {
      validateWire({
        clauses: [{ op: "eq", field: "x", value: Symbol("s") as unknown as string }],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).message).toContain("unsupported type");
      expect((error as BaerlyError).message).toContain("index 0");
    }
  });

  test("rejects NaN eq value (L178 finite check — already in test but assert CODE)", () => {
    let thrown: unknown;
    try {
      validateWire({ clauses: [{ op: "eq", field: "x", value: NaN }] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BaerlyError);
    expect((thrown as BaerlyError).code).toBe("InvalidConfig");
    expect((thrown as BaerlyError).message).toContain("NaN");
  });
});

describe("validateRangeBound — full branch coverage (kills L187-L209 mutants)", () => {
  // Several branches in validateRangeBound have no coverage.

  test("rejects null range bound (L187 ConditionalExpression)", () => {
    let thrown: unknown;
    try {
      validateWire({ clauses: [{ op: "gt", field: "x", value: null as unknown as number }] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BaerlyError);
    expect((thrown as BaerlyError).code).toBe("InvalidConfig");
    expect((thrown as BaerlyError).message).toContain("null");
  });

  test("rejects undefined range bound (L187 covers undefined branch)", () => {
    let thrown: unknown;
    try {
      validateWire({
        clauses: [{ op: "gt", field: "x", value: undefined as unknown as number }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BaerlyError);
    expect((thrown as BaerlyError).code).toBe("InvalidConfig");
    expect((thrown as BaerlyError).message).toContain("undefined");
  });

  test("L190 message string literal must be non-empty — L190 ConditionalExpression→true survivor", () => {
    // L190 ConditionalExpression→true means the null check always fires,
    // even for valid values.  The not.toThrow below kills that mutant.
    expect(() => validateWire({ clauses: [{ op: "gt", field: "x", value: 5 }] })).not.toThrow();
    // Also verify that the thrown error message contains the required fragment:
    try {
      validateWire({ clauses: [{ op: "gt", field: "x", value: null as unknown as number }] });
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).message).toContain("range bound");
    }
  });

  test("rejects boolean range bound with specific message (kills L194 block/string/conditional mutants)", () => {
    // L194 BlockStatement→{}: the throw is removed; boolean falls through to
    // `t !== "string" && t !== "number"` which also throws, but with "unsupported type".
    // L194 StringLiteral `"boolean"`→`""`: the if condition checks `t === ""`, never true,
    // so boolean still falls through to the generic check.
    // L194 ConditionalExpression→false: guard never fires, same fallthrough.
    // All three mutants produce a message containing "unsupported type" but NOT
    // "booleans are not ordered" — asserting the specific phrase kills all three.
    let thrown: unknown;
    try {
      validateWire({ clauses: [{ op: "gt", field: "x", value: true as unknown as number }] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BaerlyError);
    expect((thrown as BaerlyError).code).toBe("InvalidConfig");
    // The specific boolean-branch message fragment distinguishes the early check
    // from the generic catch-all "unsupported type" message:
    expect((thrown as BaerlyError).message).toContain("booleans are not ordered");
  });

  test("rejects Symbol range bound — exercises L206 catch-all type check", () => {
    // L206 BlockStatement / ConditionalExpression: if the guard is removed,
    // Symbol falls through without throwing.
    expectInvalidConfig(
      () =>
        validateWire({
          clauses: [{ op: "gt", field: "x", value: Symbol("s") as unknown as number }],
        }),
      "unsupported type",
    );
  });

  test("L208 / L209 string literals in range-bound type error message", () => {
    try {
      validateWire({
        clauses: [{ op: "gt", field: "x", value: Symbol("s") as unknown as number }],
      });
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).message).toContain("unsupported type");
      expect((error as BaerlyError).message).toContain("clause 0");
    }
  });

  test("rejects NaN range bound (L212 finite check)", () => {
    expectInvalidConfig(
      () => validateWire({ clauses: [{ op: "gt", field: "x", value: NaN }] }),
      "NaN",
    );
  });

  test("accepts string range bound (not a boolean / object / other type)", () => {
    // Pins that string passes through validateRangeBound without throwing.
    expect(() =>
      validateWire({ clauses: [{ op: "gte", field: "created_at", value: "2026-01-01" }] }),
    ).not.toThrow();
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
