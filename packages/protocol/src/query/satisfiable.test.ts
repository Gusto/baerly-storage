/**
 * Oracle properties for `./satisfiable.ts:assertWireSatisfiable`,
 * exercised through its real entry point `validateWire` (which calls
 * it at `validate.ts:56`). The module has 249 LoC of interval / set
 * algebra and no dedicated suite — `merge.test.ts` and
 * `validate.test.ts` only cover it transitively.
 *
 * Headline contract — **soundness**: when `validateWire` rejects a
 * wire as `UnsatisfiablePredicate`, there is genuinely no document the
 * matcher accepts. We verify this against an exhaustive enumeration of
 * the model space derived from the wire's own clause values (plus
 * integer-bound neighbours). This direction is valid regardless of how
 * complete the enumeration is: "no model exists" implies "no model in
 * any subset of docs."
 *
 * `assertWireSatisfiable` is intentionally INcomplete (its docstring
 * lists specific triggers; it does not, e.g., cross-check `in` members
 * against range bounds), so we do NOT assert the converse over
 * arbitrary wires. Instead a separate **witness** property uses
 * single-clause-per-field wires — which always have a trivial model
 * when accepted — and constructs the witness directly.
 *
 * @see docs/spec/sync-protocol.md — predicate algebra.
 */
import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";

import { BaerlyError } from "../errors.ts";
import type { DocumentValue, JSONObject } from "../json.ts";

import { matchesWire } from "./matches.ts";
import { validateWire } from "./validate.ts";
import type { PredicateClause, PredicateWire } from "./wire.ts";

// Small bounded pools (mirrors query/merge.test.ts). Range ops carry
// integers only, so the model space stays enumerable.
const keyArb = fc.constantFrom("a", "b", "c", "d");
const valArb = fc.oneof(
  fc.string({ minLength: 0, maxLength: 4 }),
  fc.integer({ min: -3, max: 3 }),
  fc.boolean(),
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
    .map(([k, v]) => ({ op: "gte" as const, field: k, value: v as DocumentValue })),
  fc
    .tuple(keyArb, fc.integer({ min: -3, max: 3 }))
    .map(([k, v]) => ({ op: "lt" as const, field: k, value: v as DocumentValue })),
  fc
    .tuple(keyArb, fc.integer({ min: -3, max: 3 }))
    .map(([k, v]) => ({ op: "lte" as const, field: k, value: v as DocumentValue })),
  fc
    .tuple(keyArb, fc.array(valArb, { minLength: 1, maxLength: 3 }))
    .map(([k, vs]) => ({ op: "in" as const, field: k, value: vs as ReadonlyArray<DocumentValue> })),
);

const opWireArb: fc.Arbitrary<PredicateWire> = fc
  .array(opClauseArb, { maxLength: 4 })
  .map((clauses) => ({ clauses }));

/**
 * The set of field values worth probing for `field` against `wire`:
 * every clause value / `in` member on that field, plus ±1 neighbours
 * of integer range bounds (so a `gt n` / `lt n` interior point is
 * covered). Membership / equality / boundary behaviour of the matcher
 * only changes at these points, so a satisfying assignment — if one
 * exists — must use one of them.
 */
const interestingValuesFor = (wire: PredicateWire, field: string): DocumentValue[] => {
  const out = new Set<DocumentValue>();
  for (const c of wire.clauses) {
    if (c.field !== field) {
      continue;
    }
    if (c.op === "in") {
      for (const m of c.value as ReadonlyArray<DocumentValue>) {
        out.add(m);
      }
      continue;
    }
    const v = c.value as DocumentValue;
    out.add(v);
    if (typeof v === "number") {
      out.add(v - 1);
      out.add(v + 1);
    }
  }
  return [...out];
};

/**
 * Enumerate the model space of `wire` over its own clause-derived
 * values (each field also allowed to be absent) and return true if any
 * doc matches. A sound model search: a returned `true` exhibits a real
 * model; the soundness assertion only relies on "validator-unsat ⟹ no
 * model in this (sub)space."
 */
const hasModelInClauseSpace = (wire: PredicateWire): boolean => {
  const fields = [...new Set(wire.clauses.map((c) => c.field))];
  // Each field: a candidate value, or `undefined` ⇒ key absent.
  const optionsPerField = fields.map((f) => [undefined, ...interestingValuesFor(wire, f)]);
  const total = optionsPerField.reduce((acc, opts) => acc * opts.length, 1);
  // Bounded by construction (≤4 clauses ⇒ tiny product); guard anyway.
  if (total > 20000) {
    throw new Error(`model space too large to enumerate: ${total}`);
  }
  for (let i = 0; i < total; i++) {
    const doc: Record<string, DocumentValue> = {};
    let rem = i;
    for (let f = 0; f < fields.length; f++) {
      const opts = optionsPerField[f]!;
      const choice = opts[rem % opts.length];
      rem = Math.floor(rem / opts.length);
      if (choice !== undefined) {
        doc[fields[f]!] = choice;
      }
    }
    if (matchesWire(wire, doc as JSONObject)) {
      return true;
    }
  }
  return false;
};

describe("assertWireSatisfiable (via validateWire) — soundness", () => {
  test.prop({ wire: opWireArb })(
    "UnsatisfiablePredicate verdict ⟹ no document in the clause-derived space matches",
    ({ wire }) => {
      let threwUnsat = false;
      try {
        validateWire(wire);
      } catch (error) {
        expect(error).toBeInstanceOf(BaerlyError);
        if ((error as BaerlyError).code === "UnsatisfiablePredicate") {
          threwUnsat = true;
        } else {
          // InvalidConfig etc. — structural rejection, not our claim.
          return;
        }
      }
      if (threwUnsat) {
        expect(hasModelInClauseSpace(wire)).toBe(false);
      }
    },
  );
});

// Witness: a wire with at most one clause per field. When accepted, a
// model is constructible per-field with no intra-field interaction.
const distinctFieldWireArb: fc.Arbitrary<PredicateWire> = fc
  .uniqueArray(opClauseArb, { maxLength: 4, selector: (c) => c.field })
  .map((clauses) => ({ clauses }));

/** Construct a field value that satisfies a single clause. */
const witnessValueFor = (clause: PredicateClause): DocumentValue => {
  switch (clause.op) {
    case "eq": {
      return clause.value as DocumentValue;
    }
    case "in": {
      return (clause.value as ReadonlyArray<DocumentValue>)[0]!;
    }
    case "gt": {
      return (clause.value as number) + 1;
    }
    case "gte": {
      return clause.value as number;
    }
    case "lt": {
      return (clause.value as number) - 1;
    }
    case "lte": {
      return clause.value as number;
    }
  }
};

describe("assertWireSatisfiable (via validateWire) — witness", () => {
  test.prop({ wire: distinctFieldWireArb })(
    "an accepted single-clause-per-field wire has a constructible model",
    ({ wire }) => {
      try {
        validateWire(wire);
      } catch (error) {
        expect(error).toBeInstanceOf(BaerlyError);
        return; // rejected — nothing to witness.
      }
      const doc: Record<string, DocumentValue> = {};
      for (const clause of wire.clauses) {
        doc[clause.field] = witnessValueFor(clause);
      }
      expect(matchesWire(wire, doc as JSONObject)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Helper: build a PredicateWire from a flat list of clauses
// ---------------------------------------------------------------------------
const wire = (...clauses: PredicateClause[]): PredicateWire => ({ clauses });

const ok = (w: PredicateWire): void => {
  expect(() => validateWire(w)).not.toThrow();
};

const unsat = (w: PredicateWire): void => {
  expect(() => validateWire(w)).toThrow(
    expect.objectContaining({ code: "UnsatisfiablePredicate" }),
  );
};

/**
 * Assert that validateWire throws UnsatisfiablePredicate whose message
 * includes the given field name rendered by formatPath. This kills
 * `ArrayDeclaration → []` mutants that turn `formatPath([field])` into
 * `formatPath([])` (which prints `<root>` instead of the field name).
 */
const unsatWithField = (w: PredicateWire, field: string): void => {
  let caught: unknown;
  try {
    validateWire(w);
    throw new Error("Expected UnsatisfiablePredicate but validateWire did not throw");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BaerlyError);
  expect((caught as BaerlyError).code).toBe("UnsatisfiablePredicate");
  expect((caught as BaerlyError).message).toContain(JSON.stringify(field));
};

/**
 * Assert that validateWire throws UnsatisfiablePredicate whose message
 * contains all provided substrings. Used to kill StringLiteral mutations
 * that blank out descriptive text like "gte"/"gt"/"lte"/"lt" in error messages.
 */
const unsatWithMessageContaining = (w: PredicateWire, ...substrings: string[]): void => {
  let caught: unknown;
  try {
    validateWire(w);
    throw new Error("Expected UnsatisfiablePredicate but validateWire did not throw");
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(BaerlyError);
  expect((caught as BaerlyError).code).toBe("UnsatisfiablePredicate");
  for (const s of substrings) {
    expect((caught as BaerlyError).message).toContain(s);
  }
};

// ---------------------------------------------------------------------------
// applyClause — gte / lt / lte dispatch coverage
// Exercises the cases omitted by the single-clause property tests:
//   • gte: two gte clauses on same field (tightenLower called twice, inclusive=true)
//   • lt:  two lt  clauses on same field (tightenUpper called twice, inclusive=false)
//   • lte: two lte clauses on same field (tightenUpper called twice, inclusive=true)
// ---------------------------------------------------------------------------
describe("applyClause dispatch — gte / lt / lte reach tightenLower / tightenUpper", () => {
  test("gte+gte: tightest lower bound wins — gte:5 AND gte:3 → lower bound is 5", () => {
    // gte:5 AND gte:3 — both inclusive; tightest is 5
    // eq:4 should be unsatisfiable (below gte:5)
    unsat(
      wire(
        { op: "gte", field: "x", value: 5 },
        { op: "gte", field: "x", value: 3 },
        { op: "eq", field: "x", value: 4 },
      ),
    );
  });

  test("gte+gte: a value at the tighter bound is satisfiable", () => {
    ok(
      wire(
        { op: "gte", field: "x", value: 5 },
        { op: "gte", field: "x", value: 3 },
        { op: "eq", field: "x", value: 5 },
      ),
    );
  });

  test("lt+lt: tightest upper bound wins — lt:3 AND lt:5 → upper bound is lt:3", () => {
    // lt:3 AND lt:5 — both exclusive; tightest is lt:3
    // eq:3 should be unsatisfiable (excluded by lt:3)
    unsat(
      wire(
        { op: "lt", field: "x", value: 3 },
        { op: "lt", field: "x", value: 5 },
        { op: "eq", field: "x", value: 3 },
      ),
    );
  });

  test("lt+lt: a value strictly below tighter bound is satisfiable", () => {
    ok(
      wire(
        { op: "lt", field: "x", value: 3 },
        { op: "lt", field: "x", value: 5 },
        { op: "eq", field: "x", value: 2 },
      ),
    );
  });

  test("lte+lte: tightest upper bound wins — lte:3 AND lte:5 → upper bound is lte:3", () => {
    // lte:3 AND lte:5 — both inclusive; tightest is lte:3
    // eq:4 should be unsatisfiable (above lte:3)
    unsat(
      wire(
        { op: "lte", field: "x", value: 3 },
        { op: "lte", field: "x", value: 5 },
        { op: "eq", field: "x", value: 4 },
      ),
    );
  });

  test("lte+lte: a value at the tighter bound is satisfiable", () => {
    ok(
      wire(
        { op: "lte", field: "x", value: 3 },
        { op: "lte", field: "x", value: 5 },
        { op: "eq", field: "x", value: 3 },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// tightenLower — boundary precision
// Line 104: if (c < 0 || (c === 0 && inclusive === false && group.lo.inclusive === true))
//   → update lo only when new bound is strictly greater, OR equal with new being exclusive
//     and existing being inclusive (makes the interval strictly tighter).
// ---------------------------------------------------------------------------
describe("tightenLower — boundary logic (line 104)", () => {
  // c < 0 case: new value > existing lo.value → tighten
  test("gt:3 AND gt:5: lower bound tightens from 3 to 5 — eq:4 unsatisfiable", () => {
    // After tighten: lo = gt:5. eq:4 < gt:5 → unsat.
    unsat(
      wire(
        { op: "gt", field: "x", value: 3 },
        { op: "gt", field: "x", value: 5 },
        { op: "eq", field: "x", value: 4 },
      ),
    );
  });

  test("gt:5 AND gt:3: lower bound stays at 5 — eq:4 unsatisfiable", () => {
    // Order reversed — gt:5 first, then gt:3 (c > 0, no tighten). lo stays gt:5.
    unsat(
      wire(
        { op: "gt", field: "x", value: 5 },
        { op: "gt", field: "x", value: 3 },
        { op: "eq", field: "x", value: 4 },
      ),
    );
  });

  // c === 0, inclusive=false (new: gt), group.lo.inclusive=true (existing: gte) → tighten to gt
  test("gte:5 then gt:5: exclusive beats inclusive at same value — eq:5 unsatisfiable", () => {
    // gte:5 (inclusive=true), then gt:5 (inclusive=false, c=0) → tighten to gt:5.
    // eq:5 is at boundary of gt:5 → unsat.
    unsat(
      wire(
        { op: "gte", field: "x", value: 5 },
        { op: "gt", field: "x", value: 5 },
        { op: "eq", field: "x", value: 5 },
      ),
    );
  });

  test("gte:5 then gt:5: value above boundary still satisfiable", () => {
    ok(
      wire(
        { op: "gte", field: "x", value: 5 },
        { op: "gt", field: "x", value: 5 },
        { op: "eq", field: "x", value: 6 },
      ),
    );
  });

  // c === 0, inclusive=true (new: gte), group.lo.inclusive=false (existing: gt) → do NOT tighten
  test("gt:5 then gte:5: inclusive does NOT beat exclusive — eq:5 still unsatisfiable", () => {
    // gt:5 (inclusive=false) first, then gte:5 (inclusive=true, c=0) → no tighten, lo stays gt:5.
    // eq:5 is at boundary of gt:5 → unsat.
    unsat(
      wire(
        { op: "gt", field: "x", value: 5 },
        { op: "gte", field: "x", value: 5 },
        { op: "eq", field: "x", value: 5 },
      ),
    );
  });

  // c === 0, both inclusive (gte+gte at same value) → no tighten needed, stays same
  test("gte:5 AND gte:5: idempotent — eq:5 satisfiable, eq:4 not", () => {
    ok(
      wire(
        { op: "gte", field: "x", value: 5 },
        { op: "gte", field: "x", value: 5 },
        { op: "eq", field: "x", value: 5 },
      ),
    );
    unsat(
      wire(
        { op: "gte", field: "x", value: 5 },
        { op: "gte", field: "x", value: 5 },
        { op: "eq", field: "x", value: 4 },
      ),
    );
  });

  // c === 0, both exclusive (gt+gt at same value) → no tighten needed, stays same
  test("gt:5 AND gt:5: idempotent — eq:5 unsatisfiable, eq:6 satisfiable", () => {
    unsat(
      wire(
        { op: "gt", field: "x", value: 5 },
        { op: "gt", field: "x", value: 5 },
        { op: "eq", field: "x", value: 5 },
      ),
    );
    ok(
      wire(
        { op: "gt", field: "x", value: 5 },
        { op: "gt", field: "x", value: 5 },
        { op: "eq", field: "x", value: 6 },
      ),
    );
  });

  // c > 0, new=exclusive (gt): gte:5 then gt:3 — new bound is WEAKER; must NOT tighten.
  // This kills the LogicalOperator mutant `c === 0 || inclusive === false` on line 104.
  // With the mutant: c > 0, inclusive=false → (0||true) = true → incorrectly update lo to gt:3.
  // eq:4 would then be satisfiable (4 > gt:3), but correct answer is UNSAT (4 < gte:5).
  test("gte:5 AND gt:3: weaker exclusive bound does NOT replace stronger inclusive — eq:4 unsatisfiable", () => {
    unsat(
      wire(
        { op: "gte", field: "x", value: 5 },
        { op: "gt", field: "x", value: 3 },
        { op: "eq", field: "x", value: 4 },
      ),
    );
  });

  test("gte:5 AND gt:3: value at exact inclusive boundary still satisfiable", () => {
    ok(
      wire(
        { op: "gte", field: "x", value: 5 },
        { op: "gt", field: "x", value: 3 },
        { op: "eq", field: "x", value: 5 },
      ),
    );
  });

  // c > 0, new=exclusive (gt): gt:5 then gt:3 — new is weaker exclusive, stays at gt:5
  test("gt:5 AND gt:3: weaker exclusive bound does NOT replace stronger — eq:4 unsatisfiable", () => {
    unsat(
      wire(
        { op: "gt", field: "x", value: 5 },
        { op: "gt", field: "x", value: 3 },
        { op: "eq", field: "x", value: 4 },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// tightenLower — type-incompatible lower bounds (line 93) — field name in error
// ---------------------------------------------------------------------------
describe("tightenLower — type-incompatible lower bounds (line 93)", () => {
  test("gt:5 AND gt:'a': type mismatch on lower bounds → UnsatisfiablePredicate with field name", () => {
    unsatWithField(
      wire({ op: "gt", field: "myField", value: 5 }, { op: "gt", field: "myField", value: "a" }),
      "myField",
    );
  });

  test("gte:1 AND gte:'b': type mismatch on lower bounds → UnsatisfiablePredicate", () => {
    unsatWithField(
      wire({ op: "gte", field: "myField", value: 1 }, { op: "gte", field: "myField", value: "b" }),
      "myField",
    );
  });
});

// ---------------------------------------------------------------------------
// tightenUpper — boundary precision
// Line 126: if (c > 0 || (c === 0 && inclusive === false && group.hi.inclusive === true))
//   → update hi only when new bound is strictly less, OR equal with new being exclusive
//     and existing being inclusive.
// ---------------------------------------------------------------------------
describe("tightenUpper — boundary logic (line 126)", () => {
  // c > 0 case: new value < existing hi.value → tighten
  test("lt:5 AND lt:3: upper bound tightens from 5 to 3 — eq:4 unsatisfiable", () => {
    unsat(
      wire(
        { op: "lt", field: "x", value: 5 },
        { op: "lt", field: "x", value: 3 },
        { op: "eq", field: "x", value: 4 },
      ),
    );
  });

  test("lt:3 AND lt:5: upper bound stays at 3 — eq:4 unsatisfiable", () => {
    unsat(
      wire(
        { op: "lt", field: "x", value: 3 },
        { op: "lt", field: "x", value: 5 },
        { op: "eq", field: "x", value: 4 },
      ),
    );
  });

  // c === 0, inclusive=false (new: lt), group.hi.inclusive=true (existing: lte) → tighten to lt
  test("lte:5 then lt:5: exclusive beats inclusive at same value — eq:5 unsatisfiable", () => {
    unsat(
      wire(
        { op: "lte", field: "x", value: 5 },
        { op: "lt", field: "x", value: 5 },
        { op: "eq", field: "x", value: 5 },
      ),
    );
  });

  test("lte:5 then lt:5: value below boundary still satisfiable", () => {
    ok(
      wire(
        { op: "lte", field: "x", value: 5 },
        { op: "lt", field: "x", value: 5 },
        { op: "eq", field: "x", value: 4 },
      ),
    );
  });

  // c === 0, inclusive=true (new: lte), group.hi.inclusive=false (existing: lt) → do NOT tighten
  test("lt:5 then lte:5: inclusive does NOT beat exclusive — eq:5 still unsatisfiable", () => {
    unsat(
      wire(
        { op: "lt", field: "x", value: 5 },
        { op: "lte", field: "x", value: 5 },
        { op: "eq", field: "x", value: 5 },
      ),
    );
  });

  // c === 0, both inclusive (lte+lte at same value) → no tighten needed
  test("lte:5 AND lte:5: idempotent — eq:5 satisfiable, eq:6 not", () => {
    ok(
      wire(
        { op: "lte", field: "x", value: 5 },
        { op: "lte", field: "x", value: 5 },
        { op: "eq", field: "x", value: 5 },
      ),
    );
    unsat(
      wire(
        { op: "lte", field: "x", value: 5 },
        { op: "lte", field: "x", value: 5 },
        { op: "eq", field: "x", value: 6 },
      ),
    );
  });

  // c === 0, both exclusive (lt+lt at same value) → no tighten needed
  test("lt:5 AND lt:5: idempotent — eq:5 unsatisfiable, eq:4 satisfiable", () => {
    unsat(
      wire(
        { op: "lt", field: "x", value: 5 },
        { op: "lt", field: "x", value: 5 },
        { op: "eq", field: "x", value: 5 },
      ),
    );
    ok(
      wire(
        { op: "lt", field: "x", value: 5 },
        { op: "lt", field: "x", value: 5 },
        { op: "eq", field: "x", value: 4 },
      ),
    );
  });

  // c < 0, new=exclusive (lt): lte:3 then lt:5 — new bound is WEAKER; must NOT tighten.
  // This kills the LogicalOperator mutant `c === 0 || inclusive === false` on line 126.
  // With the mutant: c < 0, inclusive=false → (0||true) = true → incorrectly update hi to lt:5.
  // eq:4 should be UNSAT (4 > lte:3 is fine but 4 < lte:3 → lte:3 means hi=3, eq:4 > 3 → unsat).
  // Wait: lte:3 then lt:5. c = compareScalar(3, 5) = 3-5 = -2 < 0. hi = lte:3, then lt:5.
  // c < 0 means hi(3) < new(5), so hi is already tighter. Normal code: c < 0 → no update.
  // BUT the condition is `c > 0` for tightenUpper: c > 0 means old > new (new is smaller = tighter).
  // c < 0 means old < new (new is LARGER = WEAKER). So c < 0 → do NOT tighten. Good.
  // The mutant `c === 0 || inclusive === false` would fire when c < 0 (well, no — wait):
  // The full condition is: `c > 0 || (c === 0 && inclusive === false && group.hi.inclusive === true)`
  // Mutant: `c > 0 || (c === 0 || inclusive === false) && group.hi.inclusive === true`
  // Actually the mutation is `c === 0 && inclusive → c === 0 || inclusive` between just those two.
  // So: `c > 0 || ((c === 0 || inclusive === false) && group.hi.inclusive === true)`
  // When c < 0 (old=3, new=5, 3-5=-2 < 0): mutant = `false || ((false || false) && true)` = false. No change.
  // Hmm, the mutation is on the && between c===0 and inclusive===false:
  // Original: c > 0 || (c === 0 && inclusive === false && group.hi.inclusive === true)
  // Mutant:   c > 0 || (c === 0 || inclusive === false) && ...
  // This means: fire when c > 0 OR (c === 0 OR inclusive === false) AND old is inclusive.
  // When c < 0 AND inclusive = false AND old is inclusive: mutant fires!
  // Example: lte:3 (old=inclusive) then lt:5 (new=exclusive but weaker). c = 3-5 = -2 < 0.
  // Correct: don't update (hi stays lte:3). Mutant: (c===0||false)&&true = false → still no update. Wait.
  // Actually: old.value=3, new.value=5. c = compareScalar(3, 5) = -2. So c > 0 is false.
  // Mutant part: (c===0 || inclusive===false) = (false || true) = true. AND old.inclusive=true. → true.
  // So mutant DOES fire: updates hi to {5, false}. Now lte:3 becomes lt:5.
  // eq:4 with lt:5: 4 < 5 → SAT. But with original lte:3: eq:4 > 3 → UNSAT.
  test("lte:3 AND lt:5: weaker exclusive bound does NOT replace tighter inclusive — eq:4 unsatisfiable", () => {
    unsat(
      wire(
        { op: "lte", field: "x", value: 3 },
        { op: "lt", field: "x", value: 5 },
        { op: "eq", field: "x", value: 4 },
      ),
    );
  });

  test("lte:3 AND lt:5: value at exact inclusive boundary still satisfiable", () => {
    ok(
      wire(
        { op: "lte", field: "x", value: 3 },
        { op: "lt", field: "x", value: 5 },
        { op: "eq", field: "x", value: 3 },
      ),
    );
  });

  // c < 0, new=exclusive (lt): lt:3 then lt:5 — new is weaker, stays at lt:3
  test("lt:3 AND lt:5: weaker exclusive bound does NOT replace stronger — eq:2 satisfiable, eq:3 not", () => {
    ok(
      wire(
        { op: "lt", field: "x", value: 3 },
        { op: "lt", field: "x", value: 5 },
        { op: "eq", field: "x", value: 2 },
      ),
    );
    unsat(
      wire(
        { op: "lt", field: "x", value: 3 },
        { op: "lt", field: "x", value: 5 },
        { op: "eq", field: "x", value: 3 },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// tightenUpper — type-incompatible upper bounds (line 119) — field name in error
// ---------------------------------------------------------------------------
describe("tightenUpper — type-incompatible upper bounds (line 119)", () => {
  test("lt:5 AND lt:'a': type mismatch on upper bounds → UnsatisfiablePredicate with field name", () => {
    unsatWithField(
      wire({ op: "lt", field: "myField", value: 5 }, { op: "lt", field: "myField", value: "a" }),
      "myField",
    );
  });

  test("lte:1 AND lte:'b': type mismatch on upper bounds → UnsatisfiablePredicate", () => {
    unsatWithField(
      wire({ op: "lte", field: "myField", value: 1 }, { op: "lte", field: "myField", value: "b" }),
      "myField",
    );
  });
});

// ---------------------------------------------------------------------------
// intersectInSets — empty input (line 134)
// Called directly via multiple `in` clauses on the same field.
// ---------------------------------------------------------------------------
describe("intersectInSets — empty-sets input", () => {
  test("a single in() clause with one element is satisfiable", () => {
    ok(wire({ op: "in", field: "x", value: [1] }));
  });

  test("two in() clauses with no common element → UnsatisfiablePredicate", () => {
    unsat(wire({ op: "in", field: "x", value: [1, 2] }, { op: "in", field: "x", value: [3, 4] }));
  });

  test("two in() clauses with one common element → satisfiable", () => {
    ok(wire({ op: "in", field: "x", value: [1, 2] }, { op: "in", field: "x", value: [2, 3] }));
  });

  test("three in() clauses intersecting to empty → UnsatisfiablePredicate", () => {
    unsat(
      wire(
        { op: "in", field: "x", value: [1, 2, 3] },
        { op: "in", field: "x", value: [2, 3, 4] },
        { op: "in", field: "x", value: [4, 5, 6] },
      ),
    );
  });

  test("three in() clauses with shared element → satisfiable", () => {
    ok(
      wire(
        { op: "in", field: "x", value: [1, 2, 3] },
        { op: "in", field: "x", value: [2, 3, 4] },
        { op: "in", field: "x", value: [3, 5, 6] },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// assertWireSatisfiable — range interval emptiness (line 181)
// if (c > 0 || (c === 0 && (!group.lo.inclusive || !group.hi.inclusive)))
//   empty interval when lo > hi OR lo == hi with either side strict
// ---------------------------------------------------------------------------
describe("range interval emptiness (line 181)", () => {
  // c > 0: lo > hi → empty regardless of inclusivity
  test("gt:5 AND lt:3: inverted interval → UnsatisfiablePredicate", () => {
    unsat(wire({ op: "gt", field: "x", value: 5 }, { op: "lt", field: "x", value: 3 }));
  });

  test("gt:5 AND lte:3: inverted interval → UnsatisfiablePredicate", () => {
    unsat(wire({ op: "gt", field: "x", value: 5 }, { op: "lte", field: "x", value: 3 }));
  });

  test("gte:5 AND lt:3: inverted interval → UnsatisfiablePredicate", () => {
    unsat(wire({ op: "gte", field: "x", value: 5 }, { op: "lt", field: "x", value: 3 }));
  });

  test("gte:5 AND lte:3: inverted interval → UnsatisfiablePredicate", () => {
    unsat(wire({ op: "gte", field: "x", value: 5 }, { op: "lte", field: "x", value: 3 }));
  });

  // c === 0, lo strict: gt:5 AND lt:5 → empty (point excluded on both sides)
  test("gt:5 AND lt:5: degenerate empty interval (both strict) → UnsatisfiablePredicate", () => {
    unsat(wire({ op: "gt", field: "x", value: 5 }, { op: "lt", field: "x", value: 5 }));
  });

  // c === 0, lo strict: gt:5 AND lte:5 → empty (lo is strict so 5 excluded)
  test("gt:5 AND lte:5: degenerate empty interval (lo strict) → UnsatisfiablePredicate", () => {
    unsat(wire({ op: "gt", field: "x", value: 5 }, { op: "lte", field: "x", value: 5 }));
  });

  // c === 0, hi strict: gte:5 AND lt:5 → empty (hi is strict so 5 excluded)
  test("gte:5 AND lt:5: degenerate empty interval (hi strict) → UnsatisfiablePredicate", () => {
    unsat(wire({ op: "gte", field: "x", value: 5 }, { op: "lt", field: "x", value: 5 }));
  });

  // c === 0, both inclusive: gte:5 AND lte:5 → satisfiable (single point {x:5})
  test("gte:5 AND lte:5: single-point interval (both inclusive) → satisfiable", () => {
    ok(wire({ op: "gte", field: "x", value: 5 }, { op: "lte", field: "x", value: 5 }));
  });

  // Normal open interval
  test("gt:3 AND lt:10: open interval → satisfiable", () => {
    ok(wire({ op: "gt", field: "x", value: 3 }, { op: "lt", field: "x", value: 10 }));
  });

  test("gte:3 AND lte:10: closed interval → satisfiable", () => {
    ok(wire({ op: "gte", field: "x", value: 3 }, { op: "lte", field: "x", value: 10 }));
  });

  // Adjacent strict values
  test("gt:4 AND lt:6: interior point exists → satisfiable (eq:5)", () => {
    ok(
      wire(
        { op: "gt", field: "x", value: 4 },
        { op: "lt", field: "x", value: 6 },
        { op: "eq", field: "x", value: 5 },
      ),
    );
  });

  test("gt:4 AND lt:5: no integer in interval → but assertWireSatisfiable only checks bounds, not domain", () => {
    // (4, 5) is non-empty over reals — assertWireSatisfiable checks lo < hi with strictness,
    // not integer-domain emptiness. This should be accepted (lo=4, hi=5, c < 0 → not empty).
    ok(wire({ op: "gt", field: "x", value: 4 }, { op: "lt", field: "x", value: 5 }));
  });

  // Check that error messages include the actual field name (kills ArrayDeclaration → [] mutants
  // that replace `formatPath([field])` with `formatPath([])` which produces "<root>" instead).
  test("empty interval error message includes the field name", () => {
    unsatWithField(
      wire(
        { op: "gt", field: "rangeField", value: 5 },
        { op: "lt", field: "rangeField", value: 5 },
      ),
      "rangeField",
    );
  });

  test("inverted interval error message includes the field name", () => {
    unsatWithField(
      wire(
        { op: "gt", field: "rangeField", value: 10 },
        { op: "lt", field: "rangeField", value: 3 },
      ),
      "rangeField",
    );
  });

  // Error message includes bound operator names (kills StringLiteral mutations on line 191:
  // "gte"/"gt" for lo side and "lte"/"lt" for hi side)
  test("interval error with gte lo and lte hi: message mentions 'gte' and 'lte'", () => {
    // gte:5 AND lte:3 — inverted interval; lo is inclusive (gte), hi is inclusive (lte)
    unsatWithMessageContaining(
      wire({ op: "gte", field: "x", value: 5 }, { op: "lte", field: "x", value: 3 }),
      "gte",
      "lte",
    );
  });

  test("interval error with gt lo and lt hi: message mentions 'gt' and 'lt'", () => {
    // gt:5 AND lt:3 — inverted interval; lo is exclusive (gt), hi is exclusive (lt)
    unsatWithMessageContaining(
      wire({ op: "gt", field: "x", value: 5 }, { op: "lt", field: "x", value: 3 }),
      "gt",
      "lt",
    );
  });

  test("interval error with gte lo and lt hi: message mentions 'gte' and 'lt'", () => {
    unsatWithMessageContaining(
      wire({ op: "gte", field: "x", value: 5 }, { op: "lt", field: "x", value: 5 }),
      "gte",
      "lt",
    );
  });

  test("interval error with gt lo and lte hi: message mentions 'gt' and 'lte'", () => {
    unsatWithMessageContaining(
      wire({ op: "gt", field: "x", value: 5 }, { op: "lte", field: "x", value: 5 }),
      "gt",
      "lte",
    );
  });
});

// ---------------------------------------------------------------------------
// assertWireSatisfiable — eq vs lower bound (line 198)
// if (c < 0 || (c === 0 && !group.lo.inclusive))
//   c < 0: eq < lo → unsatisfiable
//   c === 0, lo strict: eq == lo but lo is exclusive → unsatisfiable
// ---------------------------------------------------------------------------
describe("eq vs lower bound (line 198)", () => {
  // c < 0: eq strictly below lo
  test("gt:5, eq:4: eq < lo → UnsatisfiablePredicate", () => {
    unsat(wire({ op: "gt", field: "x", value: 5 }, { op: "eq", field: "x", value: 4 }));
  });

  test("gte:5, eq:4: eq < lo (even inclusive) → UnsatisfiablePredicate", () => {
    unsat(wire({ op: "gte", field: "x", value: 5 }, { op: "eq", field: "x", value: 4 }));
  });

  // c === 0, lo exclusive (gt): eq at boundary → unsatisfiable
  test("gt:5, eq:5: eq at exclusive lo → UnsatisfiablePredicate", () => {
    unsat(wire({ op: "gt", field: "x", value: 5 }, { op: "eq", field: "x", value: 5 }));
  });

  // c === 0, lo inclusive (gte): eq at boundary → satisfiable
  test("gte:5, eq:5: eq at inclusive lo → satisfiable", () => {
    ok(wire({ op: "gte", field: "x", value: 5 }, { op: "eq", field: "x", value: 5 }));
  });

  // c > 0: eq above lo → satisfiable (no violation on lower bound alone)
  test("gt:5, eq:6: eq above lo → satisfiable", () => {
    ok(wire({ op: "gt", field: "x", value: 5 }, { op: "eq", field: "x", value: 6 }));
  });

  test("gte:5, eq:6: eq above inclusive lo → satisfiable", () => {
    ok(wire({ op: "gte", field: "x", value: 5 }, { op: "eq", field: "x", value: 6 }));
  });

  // Boundary at exactly lo+1
  test("gt:5, eq:6 (adjacent): satisfiable", () => {
    ok(wire({ op: "gt", field: "x", value: 5 }, { op: "eq", field: "x", value: 6 }));
  });

  // Type-incompatible eq vs lower bound: eq is number, lo is string (or vice versa).
  // Kills ArrayDeclaration → [] on formatPath([field]) at line 201 (type-incompatible error path).
  test("gt:'a', eq:5: type-incompatible eq vs lower bound → UnsatisfiablePredicate with field name", () => {
    unsatWithField(
      wire(
        { op: "gt", field: "typeField", value: "a" },
        { op: "eq", field: "typeField", value: 5 },
      ),
      "typeField",
    );
  });

  // Error message includes field name (kills ArrayDeclaration → [] on formatPath([field]) at line 201)
  test("eq below lo: error message includes field name", () => {
    unsatWithField(
      wire({ op: "gt", field: "loField", value: 5 }, { op: "eq", field: "loField", value: 4 }),
      "loField",
    );
  });

  test("eq at exclusive lo: error message includes field name", () => {
    unsatWithField(
      wire({ op: "gt", field: "loField", value: 5 }, { op: "eq", field: "loField", value: 5 }),
      "loField",
    );
  });

  // Error message includes bound operator name (kills StringLiteral mutations on "gte"/"gt" at line 208)
  test("eq below inclusive lo: error message mentions 'gte'", () => {
    unsatWithMessageContaining(
      wire({ op: "gte", field: "x", value: 5 }, { op: "eq", field: "x", value: 4 }),
      "gte",
    );
  });

  test("eq at or below exclusive lo: error message mentions 'gt'", () => {
    unsatWithMessageContaining(
      wire({ op: "gt", field: "x", value: 5 }, { op: "eq", field: "x", value: 4 }),
      "gt",
    );
  });
});

// ---------------------------------------------------------------------------
// assertWireSatisfiable — eq vs upper bound (line 213)
// if (c > 0 || (c === 0 && !group.hi.inclusive))
//   c > 0: eq > hi → unsatisfiable
//   c === 0, hi strict: eq == hi but hi is exclusive → unsatisfiable
// ---------------------------------------------------------------------------
describe("eq vs upper bound (line 213)", () => {
  // c > 0: eq strictly above hi
  test("lt:5, eq:6: eq > hi → UnsatisfiablePredicate", () => {
    unsat(wire({ op: "lt", field: "x", value: 5 }, { op: "eq", field: "x", value: 6 }));
  });

  test("lte:5, eq:6: eq > hi (even inclusive) → UnsatisfiablePredicate", () => {
    unsat(wire({ op: "lte", field: "x", value: 5 }, { op: "eq", field: "x", value: 6 }));
  });

  // c === 0, hi exclusive (lt): eq at boundary → unsatisfiable
  test("lt:5, eq:5: eq at exclusive hi → UnsatisfiablePredicate", () => {
    unsat(wire({ op: "lt", field: "x", value: 5 }, { op: "eq", field: "x", value: 5 }));
  });

  // c === 0, hi inclusive (lte): eq at boundary → satisfiable
  test("lte:5, eq:5: eq at inclusive hi → satisfiable", () => {
    ok(wire({ op: "lte", field: "x", value: 5 }, { op: "eq", field: "x", value: 5 }));
  });

  // c < 0: eq below hi → satisfiable (no violation on upper bound alone)
  test("lt:5, eq:4: eq below hi → satisfiable", () => {
    ok(wire({ op: "lt", field: "x", value: 5 }, { op: "eq", field: "x", value: 4 }));
  });

  test("lte:5, eq:4: eq below inclusive hi → satisfiable", () => {
    ok(wire({ op: "lte", field: "x", value: 5 }, { op: "eq", field: "x", value: 4 }));
  });

  // Boundary at exactly hi-1
  test("lt:5, eq:4 (adjacent): satisfiable", () => {
    ok(wire({ op: "lt", field: "x", value: 5 }, { op: "eq", field: "x", value: 4 }));
  });

  // Type-incompatible eq vs upper bound: eq is number, hi is string (or vice versa).
  // Kills ArrayDeclaration → [] on formatPath([field]) at line 216 (type-incompatible error path).
  test("lt:'a', eq:5: type-incompatible eq vs upper bound → UnsatisfiablePredicate with field name", () => {
    unsatWithField(
      wire(
        { op: "lt", field: "typeField", value: "a" },
        { op: "eq", field: "typeField", value: 5 },
      ),
      "typeField",
    );
  });

  // Error message includes field name (kills ArrayDeclaration → [] on formatPath([field]) at lines 209/216)
  test("eq above hi: error message includes field name", () => {
    unsatWithField(
      wire({ op: "lt", field: "hiField", value: 5 }, { op: "eq", field: "hiField", value: 6 }),
      "hiField",
    );
  });

  test("eq at exclusive hi: error message includes field name", () => {
    unsatWithField(
      wire({ op: "lt", field: "hiField", value: 5 }, { op: "eq", field: "hiField", value: 5 }),
      "hiField",
    );
  });

  // Error message includes bound operator name (kills StringLiteral mutations on "lte"/"lt" at line 223)
  test("eq above inclusive hi: error message mentions 'lte'", () => {
    unsatWithMessageContaining(
      wire({ op: "lte", field: "x", value: 5 }, { op: "eq", field: "x", value: 6 }),
      "lte",
    );
  });

  test("eq at or above exclusive hi: error message mentions 'lt'", () => {
    unsatWithMessageContaining(
      wire({ op: "lt", field: "x", value: 5 }, { op: "eq", field: "x", value: 6 }),
      "lt",
    );
  });
});

// ---------------------------------------------------------------------------
// assertWireSatisfiable — multiple eq clauses (line 163)
// group.eqs.length > 1
// ---------------------------------------------------------------------------
describe("multiple eq clauses on same field (line 163)", () => {
  test("eq:5 AND eq:5: same value → satisfiable", () => {
    ok(wire({ op: "eq", field: "x", value: 5 }, { op: "eq", field: "x", value: 5 }));
  });

  test("eq:5 AND eq:6: conflicting values → InvalidConfig", () => {
    expect(() =>
      validateWire(wire({ op: "eq", field: "x", value: 5 }, { op: "eq", field: "x", value: 6 })),
    ).toThrow(expect.objectContaining({ code: "InvalidConfig" }));
  });

  test("eq:'a' AND eq:'b': conflicting string eq → InvalidConfig", () => {
    expect(() =>
      validateWire(
        wire({ op: "eq", field: "x", value: "a" }, { op: "eq", field: "x", value: "b" }),
      ),
    ).toThrow(expect.objectContaining({ code: "InvalidConfig" }));
  });

  test("three eq on same field — first two agree but third disagrees → InvalidConfig", () => {
    expect(() =>
      validateWire(
        wire(
          { op: "eq", field: "x", value: 5 },
          { op: "eq", field: "x", value: 5 },
          { op: "eq", field: "x", value: 6 },
        ),
      ),
    ).toThrow(expect.objectContaining({ code: "InvalidConfig" }));
  });

  test("eq:5 in two fields — independent, both fine → satisfiable", () => {
    ok(wire({ op: "eq", field: "x", value: 5 }, { op: "eq", field: "y", value: 5 }));
  });
});

// ---------------------------------------------------------------------------
// assertWireSatisfiable — eq in in() sets (line 220)
// ---------------------------------------------------------------------------
describe("eq vs in() membership (line 220)", () => {
  test("eq:2 AND in:[1,2,3]: eq present in set → satisfiable", () => {
    ok(wire({ op: "eq", field: "x", value: 2 }, { op: "in", field: "x", value: [1, 2, 3] }));
  });

  test("eq:5 AND in:[1,2,3]: eq absent from set → UnsatisfiablePredicate", () => {
    unsat(wire({ op: "eq", field: "x", value: 5 }, { op: "in", field: "x", value: [1, 2, 3] }));
  });

  test("eq:2 AND in:[1,2] AND in:[2,3]: eq in both sets → satisfiable", () => {
    ok(
      wire(
        { op: "eq", field: "x", value: 2 },
        { op: "in", field: "x", value: [1, 2] },
        { op: "in", field: "x", value: [2, 3] },
      ),
    );
  });

  test("eq:1 AND in:[1,2] AND in:[2,3]: eq in first but not second → UnsatisfiablePredicate", () => {
    unsat(
      wire(
        { op: "eq", field: "x", value: 1 },
        { op: "in", field: "x", value: [1, 2] },
        { op: "in", field: "x", value: [2, 3] },
      ),
    );
  });

  // Error message includes field name (kills ArrayDeclaration → [] on line 232)
  test("eq not in set: error message includes field name", () => {
    unsatWithField(
      wire(
        { op: "eq", field: "setField", value: 5 },
        { op: "in", field: "setField", value: [1, 2, 3] },
      ),
      "setField",
    );
  });
});

// ---------------------------------------------------------------------------
// assertWireSatisfiable — in() set intersection error field name (line 244)
// ---------------------------------------------------------------------------
describe("in() intersection empty — error includes field name (line 244)", () => {
  test("two disjoint in() sets: error message includes field name", () => {
    unsatWithField(
      wire(
        { op: "in", field: "inField", value: [1, 2] },
        { op: "in", field: "inField", value: [3, 4] },
      ),
      "inField",
    );
  });

  test("three in() sets with empty intersection: error message includes field name", () => {
    unsatWithField(
      wire(
        { op: "in", field: "inField", value: [1, 2, 3] },
        { op: "in", field: "inField", value: [2, 3, 4] },
        { op: "in", field: "inField", value: [5, 6, 7] },
      ),
      "inField",
    );
  });
});

// ---------------------------------------------------------------------------
// Property: tightenLower / tightenUpper composition invariant
//
// For any pair of integer lower bounds lo1, lo2 and upper bounds hi1, hi2,
// the interval [max(lo1,lo2), min(hi1,hi2)] is empty iff assertWireSatisfiable
// rejects a wire with those four clauses (using gt/lt for simplicity so
// both bounds are exclusive and the interval is (lo, hi) in the reals).
//
// This kills families of boundary-relational mutants on lines 104, 126, 181.
// ---------------------------------------------------------------------------
describe("property: tightened interval satisfiability agrees with set-theoretic check", () => {
  test.prop({
    lo1: fc.integer({ min: -5, max: 5 }),
    lo2: fc.integer({ min: -5, max: 5 }),
    hi1: fc.integer({ min: -5, max: 5 }),
    hi2: fc.integer({ min: -5, max: 5 }),
  })(
    "gt:lo1 + gt:lo2 + lt:hi1 + lt:hi2: satisfiable iff max(lo1,lo2) < min(hi1,hi2)",
    ({ lo1, lo2, hi1, hi2 }) => {
      const w = wire(
        { op: "gt", field: "x", value: lo1 },
        { op: "gt", field: "x", value: lo2 },
        { op: "lt", field: "x", value: hi1 },
        { op: "lt", field: "x", value: hi2 },
      );
      const effectiveLo = Math.max(lo1, lo2);
      const effectiveHi = Math.min(hi1, hi2);
      // (effectiveLo, effectiveHi) is non-empty iff effectiveLo < effectiveHi
      const expectedSatisfiable = effectiveLo < effectiveHi;
      if (expectedSatisfiable) {
        ok(w);
      } else {
        unsat(w);
      }
    },
  );

  test.prop({
    lo1: fc.integer({ min: -5, max: 5 }),
    lo2: fc.integer({ min: -5, max: 5 }),
    hi1: fc.integer({ min: -5, max: 5 }),
    hi2: fc.integer({ min: -5, max: 5 }),
  })(
    "gte:lo1 + gte:lo2 + lte:hi1 + lte:hi2: satisfiable iff max(lo1,lo2) <= min(hi1,hi2)",
    ({ lo1, lo2, hi1, hi2 }) => {
      const w = wire(
        { op: "gte", field: "x", value: lo1 },
        { op: "gte", field: "x", value: lo2 },
        { op: "lte", field: "x", value: hi1 },
        { op: "lte", field: "x", value: hi2 },
      );
      const effectiveLo = Math.max(lo1, lo2);
      const effectiveHi = Math.min(hi1, hi2);
      // [effectiveLo, effectiveHi] is non-empty iff effectiveLo <= effectiveHi
      const expectedSatisfiable = effectiveLo <= effectiveHi;
      if (expectedSatisfiable) {
        ok(w);
      } else {
        unsat(w);
      }
    },
  );

  test.prop({
    lo: fc.integer({ min: -5, max: 5 }),
    hi: fc.integer({ min: -5, max: 5 }),
    loInclusive: fc.boolean(),
    hiInclusive: fc.boolean(),
  })(
    "single lo+hi with mixed inclusivity: satisfiable iff interval non-empty",
    ({ lo, hi, loInclusive, hiInclusive }) => {
      const w = wire(
        { op: loInclusive ? "gte" : "gt", field: "x", value: lo },
        { op: hiInclusive ? "lte" : "lt", field: "x", value: hi },
      );
      // interval non-empty iff lo < hi OR (lo == hi && both inclusive)
      const c = lo - hi; // compareScalar for numbers
      const nonEmpty = c < 0 || (c === 0 && loInclusive && hiInclusive);
      if (nonEmpty) {
        ok(w);
      } else {
        unsat(w);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Property: tightenLower correctness — the effective lower bound after two
// gt/gte clauses equals the tighter one. Verified by checking eq at
// max(lo1, lo2) boundary with proper inclusive/exclusive semantics.
// ---------------------------------------------------------------------------
describe("property: tightenLower picks the effective tighter bound", () => {
  test.prop({
    lo1: fc.integer({ min: -5, max: 5 }),
    lo2: fc.integer({ min: -5, max: 5 }),
    lo1Inc: fc.boolean(),
    lo2Inc: fc.boolean(),
  })(
    "two lower bounds: eq at max(lo1,lo2) excluded iff effective bound is exclusive there",
    ({ lo1, lo2, lo1Inc, lo2Inc }) => {
      const opA = lo1Inc ? "gte" : "gt";
      const opB = lo2Inc ? "gte" : "gt";
      const w = wire(
        { op: opA, field: "x", value: lo1 },
        { op: opB, field: "x", value: lo2 },
        { op: "eq", field: "x", value: Math.max(lo1, lo2) },
      );
      // At the effective lower bound:
      //   - if lo1 > lo2: effective = lo1, inclusive = lo1Inc
      //   - if lo2 > lo1: effective = lo2, inclusive = lo2Inc
      //   - if lo1 === lo2: tightenLower tightens to exclusive if either is exclusive
      //     so effective inclusive = lo1Inc && lo2Inc
      let effectiveInclusive: boolean;
      if (lo1 > lo2) {
        effectiveInclusive = lo1Inc;
      } else if (lo2 > lo1) {
        effectiveInclusive = lo2Inc;
      } else {
        effectiveInclusive = lo1Inc && lo2Inc;
      }
      // eq at the effective bound: satisfiable iff effectiveInclusive
      if (effectiveInclusive) {
        ok(w);
      } else {
        unsat(w);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Property: tightenUpper correctness
// ---------------------------------------------------------------------------
describe("property: tightenUpper picks the effective tighter bound", () => {
  test.prop({
    hi1: fc.integer({ min: -5, max: 5 }),
    hi2: fc.integer({ min: -5, max: 5 }),
    hi1Inc: fc.boolean(),
    hi2Inc: fc.boolean(),
  })(
    "two upper bounds: eq at min(hi1,hi2) excluded iff effective bound is exclusive there",
    ({ hi1, hi2, hi1Inc, hi2Inc }) => {
      const opA = hi1Inc ? "lte" : "lt";
      const opB = hi2Inc ? "lte" : "lt";
      const w = wire(
        { op: opA, field: "x", value: hi1 },
        { op: opB, field: "x", value: hi2 },
        { op: "eq", field: "x", value: Math.min(hi1, hi2) },
      );
      // Effective upper bound after tightenUpper:
      //   - if hi1 < hi2: effective = hi1, inclusive = hi1Inc
      //   - if hi2 < hi1: effective = hi2, inclusive = hi2Inc
      //   - if hi1 === hi2: tightenUpper tightens to exclusive if either is exclusive
      //     effective inclusive = hi1Inc && hi2Inc
      let effectiveInclusive: boolean;
      if (hi1 < hi2) {
        effectiveInclusive = hi1Inc;
      } else if (hi2 < hi1) {
        effectiveInclusive = hi2Inc;
      } else {
        effectiveInclusive = hi1Inc && hi2Inc;
      }
      if (effectiveInclusive) {
        ok(w);
      } else {
        unsat(w);
      }
    },
  );
});
