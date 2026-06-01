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
