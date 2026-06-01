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
