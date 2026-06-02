import { fc, test as fcTest } from "@fast-check/vitest";
import { describe, expect, test } from "vitest";

import type { DocumentValue, JSONObject } from "../json.ts";

import { matchesWire } from "./matches.ts";
import type { PredicateClause, PredicateWire } from "./wire.ts";

describe("matchesWire — equality and traversal", () => {
  test("top-level equality match and miss", () => {
    const wire: PredicateWire = { clauses: [{ op: "eq", field: "status", value: "open" }] };
    expect(matchesWire(wire, { status: "open" })).toBe(true);
    expect(matchesWire(wire, { status: "closed" })).toBe(false);
    expect(matchesWire(wire, {})).toBe(false);
  });

  test("dotted-path traversal hit and miss", () => {
    const doc: JSONObject = { assignee: { team: "platform", oncall: "a" } };
    expect(
      matchesWire({ clauses: [{ op: "eq", field: "assignee.team", value: "platform" }] }, doc),
    ).toBe(true);
    expect(
      matchesWire({ clauses: [{ op: "eq", field: "assignee.team", value: "billing" }] }, doc),
    ).toBe(false);
    expect(
      matchesWire({ clauses: [{ op: "eq", field: "assignee.missing", value: "platform" }] }, doc),
    ).toBe(false);
  });

  test("path traversal stops at primitive / null / array", () => {
    const wire: PredicateWire = { clauses: [{ op: "eq", field: "a.b", value: "c" }] };
    expect(matchesWire(wire, { a: "literal" })).toBe(false);
    expect(matchesWire(wire, { a: null } as unknown as JSONObject)).toBe(false);
    expect(matchesWire(wire, { a: [1, 2] })).toBe(false);
  });

  test("empty wire matches every document", () => {
    const wire: PredicateWire = { clauses: [] };
    expect(matchesWire(wire, {})).toBe(true);
    expect(matchesWire(wire, { a: 1, b: "x", nested: { d: true } })).toBe(true);
    expect(matchesWire(wire, { arr: [1, 2, 3] })).toBe(true);
  });

  test("number / boolean equality", () => {
    expect(matchesWire({ clauses: [{ op: "eq", field: "count", value: 7 }] }, { count: 7 })).toBe(
      true,
    );
    expect(matchesWire({ clauses: [{ op: "eq", field: "count", value: 7 }] }, { count: 8 })).toBe(
      false,
    );
    expect(
      matchesWire(
        { clauses: [{ op: "eq", field: "archived", value: false }] },
        { archived: false },
      ),
    ).toBe(true);
    expect(
      matchesWire({ clauses: [{ op: "eq", field: "archived", value: false }] }, { archived: true }),
    ).toBe(false);
  });

  test("AND-conjunction across multiple top-level clauses", () => {
    const wire: PredicateWire = {
      clauses: [
        { op: "eq", field: "status", value: "open" },
        { op: "eq", field: "priority", value: "p1" },
      ],
    };
    expect(matchesWire(wire, { status: "open", priority: "p1" })).toBe(true);
    expect(matchesWire(wire, { status: "open", priority: "p2" })).toBe(false);
  });

  test("type mismatch on a terminal value is a miss, not a throw", () => {
    expect(
      matchesWire({ clauses: [{ op: "eq", field: "count", value: 7 }] }, {
        count: "7",
      } as unknown as JSONObject),
    ).toBe(false);
    expect(
      matchesWire({ clauses: [{ op: "eq", field: "archived", value: false }] }, {
        archived: "false",
      } as unknown as JSONObject),
    ).toBe(false);
  });
});

describe("matchesWire — sub-predicate equality (callback-form q.eq(field, object))", () => {
  // Object-form normaliser flattens nested literal sub-predicates to
  // dotted-path eq clauses on the way in. The only callers reaching
  // matchesEq's nested-object branch are callback-form
  // `q.eq("nested", { ... })` invocations — we synthesise the
  // equivalent wire here to pin the matcher's open-world semantics.
  test("nested-object eq is an open-world sub-predicate match", () => {
    const wire: PredicateWire = {
      clauses: [{ op: "eq", field: "assignee", value: { team: "platform" } }],
    };
    expect(matchesWire(wire, { assignee: { team: "platform", oncall: "a" } })).toBe(true);
    expect(matchesWire(wire, { assignee: { team: "billing" } })).toBe(false);
  });

  test("nested-object eq fails when doc lacks the key", () => {
    const wire: PredicateWire = {
      clauses: [{ op: "eq", field: "assignee", value: { team: "platform" } }],
    };
    expect(matchesWire(wire, {})).toBe(false);
  });

  test("nested-object eq against primitive / null / array in doc is false", () => {
    const wire: PredicateWire = {
      clauses: [{ op: "eq", field: "a", value: { b: "c" } }],
    };
    expect(matchesWire(wire, { a: "literal" })).toBe(false);
    expect(matchesWire(wire, { a: null } as unknown as JSONObject)).toBe(false);
    expect(matchesWire(wire, { a: [1, 2] })).toBe(false);
  });
});

describe("matchesWire — range clauses", () => {
  test("gt / gte on numbers (boundary inclusivity)", () => {
    expect(matchesWire({ clauses: [{ op: "gt", field: "x", value: 5 }] }, { x: 5 })).toBe(false);
    expect(matchesWire({ clauses: [{ op: "gt", field: "x", value: 5 }] }, { x: 6 })).toBe(true);
    expect(matchesWire({ clauses: [{ op: "gte", field: "x", value: 5 }] }, { x: 5 })).toBe(true);
    expect(matchesWire({ clauses: [{ op: "gte", field: "x", value: 5 }] }, { x: 4 })).toBe(false);
  });

  test("lt / lte on numbers (boundary inclusivity)", () => {
    expect(matchesWire({ clauses: [{ op: "lt", field: "x", value: 5 }] }, { x: 5 })).toBe(false);
    expect(matchesWire({ clauses: [{ op: "lt", field: "x", value: 5 }] }, { x: 4 })).toBe(true);
    expect(matchesWire({ clauses: [{ op: "lte", field: "x", value: 5 }] }, { x: 5 })).toBe(true);
    expect(matchesWire({ clauses: [{ op: "lte", field: "x", value: 5 }] }, { x: 6 })).toBe(false);
  });

  test("range ops on ISO date strings", () => {
    const wire: PredicateWire = {
      clauses: [
        { op: "gte", field: "created_at", value: "2026-01-01" },
        { op: "lt", field: "created_at", value: "2026-02-01" },
      ],
    };
    expect(matchesWire(wire, { created_at: "2025-12-31" })).toBe(false);
    expect(matchesWire(wire, { created_at: "2026-01-01" })).toBe(true);
    expect(matchesWire(wire, { created_at: "2026-01-15" })).toBe(true);
    expect(matchesWire(wire, { created_at: "2026-02-01" })).toBe(false);
    expect(matchesWire(wire, { created_at: "2026-02-15" })).toBe(false);
  });

  test("range ops always-miss on type-mismatch / boolean / null / missing", () => {
    // Numeric bound vs. string actual → miss, not throw.
    expect(
      matchesWire({ clauses: [{ op: "gte", field: "x", value: 1 }] }, {
        x: "1",
      } as unknown as JSONObject),
    ).toBe(false);
    // String bound vs. number actual → miss.
    expect(
      matchesWire({ clauses: [{ op: "gte", field: "x", value: "a" }] }, {
        x: 1,
      } as unknown as JSONObject),
    ).toBe(false);
    // Missing key → miss.
    expect(matchesWire({ clauses: [{ op: "gte", field: "x", value: 1 }] }, {})).toBe(false);
    // Null actual → miss.
    expect(
      matchesWire({ clauses: [{ op: "gte", field: "x", value: 1 }] }, {
        x: null,
      } as unknown as JSONObject),
    ).toBe(false);
  });

  test("AND across multiple range clauses on one field", () => {
    const wire: PredicateWire = {
      clauses: [
        { op: "gte", field: "count", value: 1 },
        { op: "lt", field: "count", value: 10 },
      ],
    };
    expect(matchesWire(wire, { count: 0 })).toBe(false);
    expect(matchesWire(wire, { count: 1 })).toBe(true);
    expect(matchesWire(wire, { count: 9 })).toBe(true);
    expect(matchesWire(wire, { count: 10 })).toBe(false);
  });

  test("dotted-path key with range clause", () => {
    const doc: JSONObject = { meta: { count: 7 } };
    expect(matchesWire({ clauses: [{ op: "gte", field: "meta.count", value: 5 }] }, doc)).toBe(
      true,
    );
    expect(matchesWire({ clauses: [{ op: "gte", field: "meta.count", value: 10 }] }, doc)).toBe(
      false,
    );
  });
});

describe("matchesWire — in clauses", () => {
  test("in primitive membership", () => {
    expect(
      matchesWire(
        { clauses: [{ op: "in", field: "priority", value: ["p1", "p2"] }] },
        { priority: "p1" },
      ),
    ).toBe(true);
    expect(
      matchesWire(
        { clauses: [{ op: "in", field: "priority", value: ["p1", "p2"] }] },
        { priority: "p3" },
      ),
    ).toBe(false);
    expect(matchesWire({ clauses: [{ op: "in", field: "x", value: [1, 2, 3] }] }, { x: 2 })).toBe(
      true,
    );
    expect(matchesWire({ clauses: [{ op: "in", field: "x", value: [1, 2, 3] }] }, { x: 4 })).toBe(
      false,
    );
  });

  test("in sub-predicate members (open-world)", () => {
    const wire: PredicateWire = {
      clauses: [
        { op: "in", field: "assignee", value: [{ team: "platform" }, { team: "billing" }] },
      ],
    };
    expect(matchesWire(wire, { assignee: { team: "platform", oncall: "a" } })).toBe(true);
    expect(matchesWire(wire, { assignee: { team: "billing" } })).toBe(true);
    expect(matchesWire(wire, { assignee: { team: "growth" } })).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Targeted mutant-kill tests — one assertion per surviving mutant.
// ---------------------------------------------------------------------

describe("lookupPath — fast-path dot detection (L58 mutants)", () => {
  // StringLiteral→"" / BlockStatement→{} / ConditionalExpression→false:
  // All three mutations degrade to "always use the slow (split) path". For a
  // dotless field "foo", the slow path produces split("foo") = ["foo"] and
  // traverses exactly one segment — giving the same result as the fast path.
  // There is no observable behaviour difference between fast and slow paths
  // for any valid dotless field name, nor for fields containing a dot (slow
  // path is used in both original and mutated code). These are true
  // structural equivalences; suppression is auditable by stripping all three
  // and rerunning: the score stays the same.
  //
  // The one exception that IS observable: field="" → fast path returns doc[""]
  // directly; slow path does split("") = [""] and traverses doc[""] → same value.
  // Still equivalent.
  //
  // The critical semantic tested below is that field="a.b" uses segment
  // traversal, not top-level lookup. That behaviour is covered by the dotted-
  // path traversal tests above (in the "equality and traversal" describe block).
  test("dot in field routes to segment traversal not top-level lookup", () => {
    // doc has literal key "a.b" AND a nested { a: { b: "nested" } }
    const doc = { "a.b": "literal", a: { b: "nested" } } as unknown as JSONObject;
    // field "a.b" → dotted path → traverses a → b → "nested"
    expect(matchesWire({ clauses: [{ op: "eq", field: "a.b", value: "nested" }] }, doc)).toBe(true);
    // field "a.b" does NOT match the literal top-level "a.b" key
    expect(matchesWire({ clauses: [{ op: "eq", field: "a.b", value: "literal" }] }, doc)).toBe(
      false,
    );
  });
});

describe("lookupPath — traversal guard conditions (L65, L67 mutants)", () => {
  // L65 ConditionalExpression→false (cursor===undefined):
  //   cursor===undefined → skipped. But typeof undefined !== "object" is true,
  //   so L67 catches it next. The guard outcome is identical. True equivalence.
  // L67 ConditionalExpression→false (typeof cursor !== "object"):
  //   If cursor is a number/boolean/string at an intermediate segment, without
  //   this check the code does (42 as JSONObject)["b"] which is `undefined` in
  //   JS. The next iteration has cursor===undefined → L65 fires → return undefined.
  //   For the last segment, the loop ends and returns undefined directly.
  //   In all cases the final return value is the same: undefined → false.
  //   True equivalence.
  //
  // These tests document the observed behaviour (which IS correct); the guards
  // are belt-and-suspenders defensive checks, not observationally distinguishable.
  test("undefined intermediate key returns undefined (not a match)", () => {
    // doc.a is undefined → cursor becomes undefined at second segment "b"
    expect(matchesWire({ clauses: [{ op: "eq", field: "a.b", value: "x" }] }, {})).toBe(false);
  });

  test("number at intermediate path position returns undefined (not a match)", () => {
    const doc = { a: 42 } as unknown as JSONObject;
    expect(matchesWire({ clauses: [{ op: "eq", field: "a.b", value: 42 }] }, doc)).toBe(false);
    // Boolean at intermediate position
    const doc2 = { a: true } as unknown as JSONObject;
    expect(matchesWire({ clauses: [{ op: "eq", field: "a.b", value: true }] }, doc2)).toBe(false);
  });

  // Three-segment path with non-object at first intermediate position:
  // ensures the guard cascade is exercised at depths > 2.
  test("non-object at depth-1 of a 3-segment path returns false", () => {
    expect(
      matchesWire({ clauses: [{ op: "eq", field: "a.b.c", value: "x" }] }, { a: "stop-here" }),
    ).toBe(false);
    expect(matchesWire({ clauses: [{ op: "eq", field: "a.b.c", value: "x" }] }, { a: 0 })).toBe(
      false,
    );
  });
});

describe("matchesEq — object-branch guard conditions (L110, L112 mutants)", () => {
  // L110 ConditionalExpression→false (actual===undefined):
  //   actual is undefined → skip the undefined check → continue to L111 (null check)
  //   → false → L112: typeof undefined !== "object" is true → guard fires → return false.
  //   End result: false. Same as original. True equivalence.
  // L112 ConditionalExpression→false (typeof actual !== "object"):
  //   For actual=number: `typeof 42 !== "object"` → skip. actual===undefined → false.
  //   actual===null → false. Then typeof check removed → Array.isArray(42) → false.
  //   Guard doesn't fire; body: `Object.keys({x:1})` = ["x"]; `(42 as JSONObject)["x"]`
  //   = undefined; matchesEq(1, undefined) = `1 === undefined` = false → return false.
  //   Same result. However for booleans: `(true as JSONObject)["x"]` = undefined too.
  //   True equivalence for all non-object non-null actuals.
  //
  // These tests document the correct behaviour.
  test("object eq against undefined actual is false", () => {
    const wire: PredicateWire = {
      clauses: [{ op: "eq", field: "missing", value: { x: 1 } }],
    };
    expect(matchesWire(wire, {})).toBe(false);
  });

  test("object eq against number actual is false", () => {
    const doc = { a: 42 } as unknown as JSONObject;
    const wire: PredicateWire = {
      clauses: [{ op: "eq", field: "a", value: { x: 1 } }],
    };
    expect(matchesWire(wire, doc)).toBe(false);
  });

  test("object eq against string actual is false", () => {
    const doc = { a: "hello" } as unknown as JSONObject;
    const wire: PredicateWire = {
      clauses: [{ op: "eq", field: "a", value: { x: 1 } }],
    };
    expect(matchesWire(wire, doc)).toBe(false);
  });

  test("object eq against boolean actual is false", () => {
    const doc = { a: true } as unknown as JSONObject;
    const wire: PredicateWire = {
      clauses: [{ op: "eq", field: "a", value: { x: 1 } }],
    };
    expect(matchesWire(wire, doc)).toBe(false);
  });
});

describe("matchesEq — subExpected===undefined branch (L119 mutants)", () => {
  // L119 ConditionalExpression→false: the `if (subExpected === undefined)` check
  //   never fires → the `continue` is never skipped → same as original.
  //   True equivalence: removing the condition (→false) is identical to removing
  //   the continue body (BlockStatement→{}).
  //
  // L119 BlockStatement→{}: `continue` removed → subKey with undefined value is
  //   NOT skipped; instead matchesEq(undefined, subActual) runs.
  //   matchesEq(undefined, X) → typeof undefined !== "object" → returns undefined===X.
  //   - If doc.assignee has the same key and its value IS undefined: undefined===undefined
  //     = true → same as skipping (no kill).
  //   - If doc.assignee has the same key with a CONCRETE value: undefined!==value → false
  //     → overall returns false when original would return true. KILL!
  //
  // Distinguishing test: expected has `ignoredKey: undefined`; doc.assignee has
  // `ignoredKey: "present"` (non-undefined). Original skips → matches on "team" only.
  // Mutant doesn't skip → matchesEq(undefined, "present") = false → overall false.
  test("sub-predicate with undefined-valued subkey is skipped even when doc has that key", () => {
    const expectedObj = Object.assign(Object.create(null) as object, {
      team: "platform",
      ignoredKey: undefined,
    }) as DocumentValue;
    const wire: PredicateWire = {
      clauses: [{ op: "eq", field: "assignee", value: expectedObj }],
    };
    // doc has ignoredKey="present" (non-undefined) — mutant would fail here
    expect(
      matchesWire(wire, {
        assignee: { team: "platform", oncall: "a", ignoredKey: "present" },
      } as unknown as JSONObject),
    ).toBe(true);
    // doc missing ignoredKey entirely — both original and mutant give true
    expect(matchesWire(wire, { assignee: { team: "platform", oncall: "a" } })).toBe(true);
    // team mismatch still fails
    expect(matchesWire(wire, { assignee: { team: "billing", ignoredKey: "present" } })).toBe(false);
  });
});

describe("matchesIn — object member branch (L137 mutant)", () => {
  // L137 ConditionalExpression→true: `if (typeof m === "object")` → always true.
  // Every member goes through matchesEq instead of the else-if `m === actual` branch.
  // For any valid primitive DocumentValue (string, number, boolean):
  //   matchesEq(primitive, actual) → typeof primitive !== "object" → returns
  //   `primitive === actual`. Identical to `m === actual`.
  // For null (typeof null === "object"): already goes through matchesEq in the original.
  // No observable difference for any DocumentValue member. True equivalence.
  //
  // NOTE: null as a member uses matchesEq(null, actual). matchesEq(null, X):
  //   typeof null === "object" → true → guard: actual===null → return false.
  //   So `in [null]` never matches anything via the object branch.
  //   The `→true` mutation routes string/number members through matchesEq too,
  //   but matchesEq(primitive, actual) = primitive===actual — same result.
  test("in with null member — matchesEq path (typeof null === 'object')", () => {
    const wire: PredicateWire = {
      clauses: [{ op: "in", field: "x", value: [null as unknown as DocumentValue, "y"] }],
    };
    expect(matchesWire(wire, { x: null } as unknown as JSONObject)).toBe(false); // matchesEq(null, null) = false (actual===null guard)
    expect(matchesWire(wire, { x: "y" })).toBe(true);
    expect(matchesWire(wire, { x: "z" })).toBe(false);
  });

  test("in with mixed object and primitive members", () => {
    const wire: PredicateWire = {
      clauses: [
        {
          op: "in",
          field: "assignee",
          value: [{ team: "platform" } as unknown as DocumentValue, "unassigned"],
        },
      ],
    };
    expect(matchesWire(wire, { assignee: { team: "platform", oncall: "a" } })).toBe(true);
    expect(matchesWire(wire, { assignee: "unassigned" })).toBe(true);
    expect(matchesWire(wire, { assignee: { team: "billing" } })).toBe(false);
  });
});

describe("compareGT — type-checking mutants (L154, L156, L157)", () => {
  // L154 ConditionalExpression→true: `typeof actual === "string"` always true.
  // For non-string actual values, the mutation evaluates `actual > bound` directly.
  // In JS, `number > string` coerces: `5 > "3"` = `5 > 3` = true.
  // We need actual=5, bound="3": original returns false (type mismatch); mutant returns true.
  test("gt string bound: numeric actual that would coerce to true is still false (type-strict)", () => {
    // 5 > "3" = true in JS coercion, but we require type-strict → false
    expect(
      matchesWire({ clauses: [{ op: "gt", field: "x", value: "3" }] }, {
        x: 5,
      } as unknown as JSONObject),
    ).toBe(false);
    // 10 >= "2" = true in JS coercion, but type-strict → false
    expect(
      matchesWire({ clauses: [{ op: "gte", field: "x", value: "2" }] }, {
        x: 10,
      } as unknown as JSONObject),
    ).toBe(false);
    // Boolean true > "0" = true in JS, but type-strict → false
    expect(
      matchesWire({ clauses: [{ op: "gt", field: "x", value: "0" }] }, {
        x: true,
      } as unknown as JSONObject),
    ).toBe(false);
  });

  test("gt string bound: boundary — equal string is false, greater is true", () => {
    expect(matchesWire({ clauses: [{ op: "gt", field: "x", value: "b" }] }, { x: "b" })).toBe(
      false,
    );
    expect(matchesWire({ clauses: [{ op: "gt", field: "x", value: "b" }] }, { x: "c" })).toBe(true);
  });

  test("gte string bound: boundary — equal string is true, less is false", () => {
    expect(matchesWire({ clauses: [{ op: "gte", field: "x", value: "b" }] }, { x: "b" })).toBe(
      true,
    );
    expect(matchesWire({ clauses: [{ op: "gte", field: "x", value: "b" }] }, { x: "a" })).toBe(
      false,
    );
  });

  test("gte string: matching strings return true", () => {
    expect(
      matchesWire({ clauses: [{ op: "gte", field: "x", value: "apple" }] }, { x: "banana" }),
    ).toBe(true);
  });

  // L156 ConditionalExpression→true: `typeof bound === "number"` → true (compareGT).
  // This makes even string/boolean/null bounds fall through to the number branch.
  // For string bound "5" and actual=10: `10 >= "5"` = `10 >= 5` = true in JS coercion.
  // Original: bound is string → string branch fires (L153), returns `typeof 10 === "string"` = false.
  // Mutant: string branch fires anyway for string bounds, L156 is never reached. So L156→true
  // only differs when bound is NOT a string and NOT a number (e.g. boolean/null).
  // For bound=true: L153 fires? No — `typeof true === "string"` = false. So falls to L156.
  // Mutant: L156→true → number branch: `typeof actual === "number" && actual >= true`.
  // `5 >= true` = `5 >= 1` = true. Original: returns false (defensive return at L160).
  test("gt/gte with boolean bound returns false (validator-forbidden but defensive)", () => {
    // bound=true, actual=5: mutant gives true; original false. KILL.
    expect(
      matchesWire(
        { clauses: [{ op: "gte", field: "x", value: true as unknown as DocumentValue }] },
        { x: 5 } as unknown as JSONObject,
      ),
    ).toBe(false);
    expect(
      matchesWire(
        { clauses: [{ op: "gt", field: "x", value: false as unknown as DocumentValue }] },
        { x: 0 } as unknown as JSONObject,
      ),
    ).toBe(false);
    // bound=true, actual=true (boolean): mutant: `typeof true === "number"` = false → false. Same.
    expect(
      matchesWire(
        { clauses: [{ op: "gt", field: "x", value: true as unknown as DocumentValue }] },
        { x: true } as unknown as JSONObject,
      ),
    ).toBe(false);
  });

  test("gt/gte with null bound returns false (validator-forbidden but defensive)", () => {
    // bound=null, actual=5: mutant L156→true → `5 >= null` = `5 >= 0` = true. KILL.
    expect(
      matchesWire(
        { clauses: [{ op: "gte", field: "x", value: null as unknown as DocumentValue }] },
        { x: 5 } as unknown as JSONObject,
      ),
    ).toBe(false);
    expect(
      matchesWire(
        { clauses: [{ op: "gt", field: "x", value: null as unknown as DocumentValue }] },
        { x: 1 } as unknown as JSONObject,
      ),
    ).toBe(false);
  });
});

describe("compareLT — type-checking mutants (L169, L171, L172, L174)", () => {
  // L169 ConditionalExpression→true: `typeof actual === "string"` always true (compareLT string branch).
  // In JS, `number < string` coerces: `0 < "3"` = `0 < 3` = true.
  // We need actual=0, bound="3": original returns false (type mismatch); mutant returns true.
  test("lt string bound: numeric actual that would coerce to true is still false (type-strict)", () => {
    // 0 < "3" = true in JS coercion, but type-strict → false
    expect(
      matchesWire({ clauses: [{ op: "lt", field: "x", value: "3" }] }, {
        x: 0,
      } as unknown as JSONObject),
    ).toBe(false);
    // 1 <= "2" = true in JS coercion, but type-strict → false
    expect(
      matchesWire({ clauses: [{ op: "lte", field: "x", value: "2" }] }, {
        x: 1,
      } as unknown as JSONObject),
    ).toBe(false);
    // Boolean false < "z" = true in JS (false→0, "z"→NaN... actually false < "z" = false)
    // Let's pick: `true < "2"` = `1 < 2` = true in JS; type-strict → false
    expect(
      matchesWire({ clauses: [{ op: "lt", field: "x", value: "2" }] }, {
        x: true,
      } as unknown as JSONObject),
    ).toBe(false);
  });

  test("lte string bound: boundary — equal is true, greater is false", () => {
    expect(matchesWire({ clauses: [{ op: "lte", field: "x", value: "m" }] }, { x: "m" })).toBe(
      true,
    );
    expect(matchesWire({ clauses: [{ op: "lte", field: "x", value: "m" }] }, { x: "n" })).toBe(
      false,
    );
  });

  test("lt string: matching strings return true", () => {
    expect(matchesWire({ clauses: [{ op: "lt", field: "x", value: "z" }] }, { x: "a" })).toBe(true);
  });

  test("lt string bound: boundary — equal string is false, less is true", () => {
    expect(matchesWire({ clauses: [{ op: "lt", field: "x", value: "m" }] }, { x: "m" })).toBe(
      false,
    );
    expect(matchesWire({ clauses: [{ op: "lt", field: "x", value: "m" }] }, { x: "l" })).toBe(true);
  });

  // L171 ConditionalExpression→true: `typeof bound === "number"` always true (compareLT).
  // For boolean/null bounds (not string, not number), the mutation enters the number branch.
  // bound=true, actual=0: `typeof 0 === "number"` = true, `0 <= true` = `0 <= 1` = true.
  // Original: bound=true → not string → not number → return false (L174). KILL.
  test("lt/lte with boolean bound returns false (validator-forbidden but defensive)", () => {
    // bound=true, actual=0: mutant gives true; original false. KILL L171.
    expect(
      matchesWire(
        { clauses: [{ op: "lte", field: "x", value: true as unknown as DocumentValue }] },
        { x: 0 } as unknown as JSONObject,
      ),
    ).toBe(false);
    expect(
      matchesWire(
        { clauses: [{ op: "lt", field: "x", value: true as unknown as DocumentValue }] },
        { x: 0 } as unknown as JSONObject,
      ),
    ).toBe(false);
    expect(
      matchesWire(
        { clauses: [{ op: "lte", field: "x", value: false as unknown as DocumentValue }] },
        { x: -1 } as unknown as JSONObject,
      ),
    ).toBe(false);
  });

  test("lt/lte with null bound returns false (validator-forbidden but defensive)", () => {
    // bound=null, actual=-1: `(-1) < null` = `(-1) < 0` = true in JS. KILL L171.
    expect(
      matchesWire(
        { clauses: [{ op: "lt", field: "x", value: null as unknown as DocumentValue }] },
        { x: -1 } as unknown as JSONObject,
      ),
    ).toBe(false);
    expect(
      matchesWire(
        { clauses: [{ op: "lte", field: "x", value: null as unknown as DocumentValue }] },
        { x: 0 } as unknown as JSONObject,
      ),
    ).toBe(false);
  });

  // L172 ConditionalExpression→true: `typeof actual === "number"` always true in number branch.
  // For non-number actual with numeric bound: `"50" <= 100` coerces `"50"` to 50 → 50<=100 = true.
  // Original: `typeof "50" === "number"` = false → false. KILL.
  test("lt/lte number bound: non-number actual is always false (type-strict)", () => {
    // "50" <= 100 = true in JS coercion, but type-strict → false
    expect(
      matchesWire({ clauses: [{ op: "lte", field: "x", value: 100 }] }, {
        x: "50",
      } as unknown as JSONObject),
    ).toBe(false);
    // "1" < 5 = true in JS coercion, but type-strict → false
    expect(
      matchesWire({ clauses: [{ op: "lt", field: "x", value: 5 }] }, {
        x: "1",
      } as unknown as JSONObject),
    ).toBe(false);
    // true <= 2 = 1 <= 2 = true in JS, but type-strict → false
    expect(
      matchesWire({ clauses: [{ op: "lte", field: "x", value: 2 }] }, {
        x: true,
      } as unknown as JSONObject),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------
// Property laws — the matcher's algebraic contract. Small bounded pools
// (mirrors query/merge.test.ts). These hold for any wire, validated or
// not: the laws are structural over the clause loop.
// ---------------------------------------------------------------------

const keyArb = fc.constantFrom("a", "b", "c", "d");
const valArb = fc.oneof(
  fc.string({ minLength: 0, maxLength: 4 }),
  fc.integer({ min: -3, max: 3 }),
  fc.boolean(),
);
// number | string only — the type space where range ops are defined.
const orderedValArb = fc.oneof(
  fc.string({ minLength: 0, maxLength: 4 }),
  fc.integer({ min: -3, max: 3 }),
);

const opClauseArb: fc.Arbitrary<PredicateClause> = fc.oneof(
  fc
    .tuple(keyArb, valArb)
    .map(([k, v]) => ({ op: "eq" as const, field: k, value: v as DocumentValue })),
  fc
    .tuple(keyArb, fc.integer({ min: -3, max: 3 }))
    .map(([k, v]) => ({ op: "gt" as const, field: k, value: v as DocumentValue })),
  fc
    .tuple(keyArb, fc.integer({ min: -3, max: 3 }))
    .map(([k, v]) => ({ op: "lt" as const, field: k, value: v as DocumentValue })),
  fc
    .tuple(keyArb, fc.array(valArb, { minLength: 1, maxLength: 3 }))
    .map(([k, vs]) => ({ op: "in" as const, field: k, value: vs as ReadonlyArray<DocumentValue> })),
);

const wireArb: fc.Arbitrary<PredicateWire> = fc
  .array(opClauseArb, { maxLength: 4 })
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

describe("matchesWire — property laws", () => {
  fcTest.prop({ a: wireArb, b: wireArb, doc: docArb })(
    "AND-decomposition: matches(a ++ b) === matches(a) && matches(b)",
    ({ a, b, doc }) => {
      const joined: PredicateWire = { clauses: [...a.clauses, ...b.clauses] };
      expect(matchesWire(joined, doc)).toBe(matchesWire(a, doc) && matchesWire(b, doc));
    },
  );

  fcTest.prop({ doc: docArb })("empty wire matches every document", ({ doc }) => {
    expect(matchesWire({ clauses: [] }, doc)).toBe(true);
  });

  fcTest.prop({ field: keyArb, value: orderedValArb, doc: docArb })(
    "eq(f,v) ⟺ gte(f,v) ∧ lte(f,v) for ordered (number/string) values",
    ({ field, value, doc }) => {
      const viaEq = matchesWire({ clauses: [{ op: "eq", field, value }] }, doc);
      const viaRange = matchesWire(
        {
          clauses: [
            { op: "gte", field, value },
            { op: "lte", field, value },
          ],
        },
        doc,
      );
      expect(viaEq).toBe(viaRange);
    },
  );

  fcTest.prop({ field: keyArb, value: valArb, doc: docArb })(
    "in(f,[v]) ⟺ eq(f,v)",
    ({ field, value, doc }) => {
      const viaIn = matchesWire({ clauses: [{ op: "in", field, value: [value] }] }, doc);
      const viaEq = matchesWire({ clauses: [{ op: "eq", field, value }] }, doc);
      expect(viaIn).toBe(viaEq);
    },
  );

  fcTest.prop({ field: keyArb, value: orderedValArb, actual: orderedValArb })(
    "gt/lte duality: with a present, same-typed field, exactly one of gt / lte holds",
    ({ field, value, actual }) => {
      // Same-typed only — the matcher is type-strict, so a cross-type
      // actual misses both bounds (the duality is vacuous there).
      if (typeof actual !== typeof value) {
        return;
      }
      const doc = { [field]: actual } as JSONObject;
      const gt = matchesWire({ clauses: [{ op: "gt", field, value }] }, doc);
      const lte = matchesWire({ clauses: [{ op: "lte", field, value }] }, doc);
      expect(gt).toBe(!lte);
    },
  );
});
