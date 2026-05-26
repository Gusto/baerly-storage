/**
 * AND-merge two validated wire predicates. Powers chained
 * `Query<T>.where(...).where(...)`: each new clause set AND's with
 * the existing wire by clause-list concatenation; the per-field
 * satisfiability check runs across the combined list.
 *
 * Companion modules: `./validate.ts`, `./matches.ts`, `./wire.ts`.
 */

import { assertWireSatisfiable } from "./satisfiable.ts";
import type { PredicateWire } from "./wire.ts";

/**
 * AND-merge two validated wire predicates. The result accepts a
 * document iff both `a` and `b` would accept it.
 *
 * Wire-level: clause lists concatenate. The per-field satisfiability
 * check runs across the combined list, surfacing
 * `BaerlyError{code:"UnsatisfiablePredicate"}` on empty residual
 * intervals / empty `in()` intersections / `eq` outside the merged
 * interval, and `BaerlyError{code:"InvalidConfig"}` on conflicting
 * `eq` clauses for the same field (mirrors the pre-redesign
 * conflict-on-shared-keys semantics).
 *
 * @example
 * ```ts
 * mergePredicateWires(
 *   { clauses: [{ op: "eq", field: "status", value: "open" }] },
 *   { clauses: [{ op: "eq", field: "priority", value: "p1" }] },
 * );
 * //   → { clauses: [
 * //         { op: "eq", field: "status", value: "open" },
 * //         { op: "eq", field: "priority", value: "p1" },
 * //       ] }
 *
 * mergePredicateWires(
 *   { clauses: [{ op: "eq", field: "status", value: "open" }] },
 *   { clauses: [{ op: "eq", field: "status", value: "closed" }] },
 * );
 * //   throws BaerlyError{InvalidConfig}: conflicting equality clauses on "status"
 *
 * mergePredicateWires(
 *   { clauses: [{ op: "gt", field: "x", value: 10 }] },
 *   { clauses: [{ op: "lt", field: "x", value: 5 }] },
 * );
 * //   throws BaerlyError{UnsatisfiablePredicate}: empty interval
 * ```
 */
export const mergePredicateWires = (a: PredicateWire, b: PredicateWire): PredicateWire => {
  const merged: PredicateWire = { clauses: [...a.clauses, ...b.clauses] };
  assertWireSatisfiable(merged);
  return merged;
};
