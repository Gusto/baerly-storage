/**
 * Per-field satisfiability check for a {@link PredicateWire}. Groups
 * clauses by field, then runs the same logic the pre-redesign
 * `assertOpObjectSatisfiable` ran on a single op-object — but
 * generalised across N clauses on the same field (the wire merger
 * concatenates lists without coalescing).
 *
 * Triggers:
 *  - Two `eq` clauses on the same field with different values →
 *    `InvalidConfig` (the same conflict that pre-redesign
 *    `mergePredicates` threw on shared primitive keys).
 *  - Range bounds with `lo > hi` (or `lo == hi` with strict on
 *    either side) → `UnsatisfiablePredicate`.
 *  - `eq` value outside the residual range interval or absent from
 *    every `in` set on the same field → `UnsatisfiablePredicate`.
 *  - `in` sets that intersect to empty across multiple clauses →
 *    `UnsatisfiablePredicate`.
 *
 * Used by both `./validate.ts` (wire-arrival check) and
 * `./merge.ts` (post-merge re-check, kept in lockstep).
 */

import { BaerlyError } from "../errors.ts";
import type { DocumentValue } from "../json.ts";

import {
  compareScalar,
  deepEqualDocumentValue,
  formatPath,
  sameComparableType,
} from "./_internals.ts";
import type { PredicateClause, PredicateWire } from "./wire.ts";

interface FieldGroup {
  readonly eqs: DocumentValue[];
  readonly ins: ReadonlyArray<DocumentValue>[];
  lo?: { value: DocumentValue; inclusive: boolean };
  hi?: { value: DocumentValue; inclusive: boolean };
}

const groupByField = (wire: PredicateWire): Map<string, FieldGroup> => {
  const out = new Map<string, FieldGroup>();
  for (const clause of wire.clauses) {
    let group = out.get(clause.field);
    if (group === undefined) {
      group = { eqs: [], ins: [] };
      out.set(clause.field, group);
    }
    applyClause(group, clause.field, clause);
  }
  return out;
};

const applyClause = (group: FieldGroup, field: string, clause: PredicateClause): void => {
  switch (clause.op) {
    case "eq": {
      group.eqs.push(clause.value as DocumentValue);
      return;
    }
    case "in": {
      group.ins.push(clause.value as ReadonlyArray<DocumentValue>);
      return;
    }
    case "gt": {
      tightenLower(group, field, clause.value as DocumentValue, false);
      return;
    }
    case "gte": {
      tightenLower(group, field, clause.value as DocumentValue, true);
      return;
    }
    case "lt": {
      tightenUpper(group, field, clause.value as DocumentValue, false);
      return;
    }
    case "lte": {
      tightenUpper(group, field, clause.value as DocumentValue, true);
      return;
    }
  }
};

const tightenLower = (
  group: FieldGroup,
  field: string,
  value: DocumentValue,
  inclusive: boolean,
): void => {
  if (group.lo === undefined) {
    group.lo = { value, inclusive };
    return;
  }
  if (!sameComparableType(group.lo.value, value)) {
    // Type-incompatible bounds on the same field — the user wrote
    // (say) `q.gt("x", 1).gt("x", "a")`. Range matching is type-
    // strict at evaluation time so this is always-miss; surface
    // eagerly as `UnsatisfiablePredicate`.
    throw new BaerlyError(
      "UnsatisfiablePredicate",
      `Predicate on field ${formatPath([field])} has type-incompatible lower bounds (${JSON.stringify(group.lo.value)} vs ${JSON.stringify(value)}).`,
    );
  }
  const c = compareScalar(group.lo.value, value);
  // Stryker disable next-line ConditionalExpression: two sub-expression-to-true mutants are
  // equivalent. (1) `inclusive === false → true`: fires when c=0, existing=inclusive,
  // new=inclusive — tighten updates lo to {value, inclusive=true}, identical to the existing
  // {same value, inclusive=true}; no observable change. (2) `group.lo.inclusive === true → true`:
  // fires when c=0, new=exclusive, existing=exclusive — tighten updates lo to {value, false},
  // identical to existing {same value, false}; no observable change.
  if (c < 0 || (c === 0 && inclusive === false && group.lo.inclusive === true)) {
    group.lo = { value, inclusive };
  }
};

const tightenUpper = (
  group: FieldGroup,
  field: string,
  value: DocumentValue,
  inclusive: boolean,
): void => {
  if (group.hi === undefined) {
    group.hi = { value, inclusive };
    return;
  }
  if (!sameComparableType(group.hi.value, value)) {
    throw new BaerlyError(
      "UnsatisfiablePredicate",
      `Predicate on field ${formatPath([field])} has type-incompatible upper bounds (${JSON.stringify(group.hi.value)} vs ${JSON.stringify(value)}).`,
    );
  }
  const c = compareScalar(group.hi.value, value);
  // Stryker disable next-line ConditionalExpression: two sub-expression-to-true mutants are
  // equivalent. (1) `inclusive === false → true`: fires when c=0, existing=inclusive,
  // new=inclusive — tighten updates hi to {value, inclusive=true}, same as existing; no change.
  // (2) `group.hi.inclusive === true → true`: fires when c=0, new=exclusive, existing=exclusive —
  // tighten updates hi to {value, false}, same as existing; no observable change.
  if (c > 0 || (c === 0 && inclusive === false && group.hi.inclusive === true)) {
    group.hi = { value, inclusive };
  }
};

const intersectInSets = (
  sets: ReadonlyArray<ReadonlyArray<DocumentValue>>,
): ReadonlyArray<DocumentValue> => {
  // Stryker disable ConditionalExpression,BlockStatement,ArrayDeclaration: dead-code guard
  // — callers only invoke intersectInSets when group.ins.length > 1 (i.e., sets.length >= 2),
  // so sets.length === 0 is unreachable in production. Any mutation here is an equivalent mutant.
  if (sets.length === 0) {
    return [];
  }
  // Stryker restore ConditionalExpression,BlockStatement,ArrayDeclaration
  let acc: ReadonlyArray<DocumentValue> = sets[0]!;
  for (let i = 1; i < sets.length; i++) {
    const next: DocumentValue[] = [];
    for (const a of acc) {
      for (const b of sets[i]!) {
        if (deepEqualDocumentValue(a, b)) {
          next.push(a);
          break;
        }
      }
    }
    acc = next;
  }
  return acc;
};

/**
 * Check that every per-field clause group on `wire` is jointly
 * satisfiable. Throws `BaerlyError{code:"UnsatisfiablePredicate"}`
 * (or `"InvalidConfig"` for conflicting `eq` clauses) on the
 * first contradiction. Returns `void` on success.
 */
export const assertWireSatisfiable = (wire: PredicateWire): void => {
  const groups = groupByField(wire);
  for (const [field, group] of groups) {
    // Multiple `eq` clauses on the same field must agree.
    // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — the inner
    // loop starts at i=1, so with 0 or 1 eqs the loop body never executes regardless of whether
    // we enter the outer if. `>= 1` enters with 1 eq (0 loop iterations); `true` enters with 0
    // eqs (0 loop iterations). Both are observationally identical to `> 1`.
    if (group.eqs.length > 1) {
      for (let i = 1; i < group.eqs.length; i++) {
        if (!deepEqualDocumentValue(group.eqs[0]!, group.eqs[i]!)) {
          throw new BaerlyError(
            "InvalidConfig",
            `Conflicting equality clauses on field ${formatPath([field])} (${JSON.stringify(group.eqs[0]!)} vs ${JSON.stringify(group.eqs[i]!)}). Predicate chains must agree on shared equality.`,
          );
        }
      }
    }
    const eq = group.eqs[0];
    // Range interval must be non-empty.
    if (
      group.lo !== undefined &&
      group.hi !== undefined &&
      sameComparableType(group.lo.value, group.hi.value)
    ) {
      const c = compareScalar(group.lo.value, group.hi.value);
      if (c > 0 || (c === 0 && (!group.lo.inclusive || !group.hi.inclusive))) {
        throw new BaerlyError(
          "UnsatisfiablePredicate",
          `Predicate on field ${formatPath([field])} has empty interval (lo=${JSON.stringify(group.lo.value)} ${group.lo.inclusive ? "gte" : "gt"}, hi=${JSON.stringify(group.hi.value)} ${group.hi.inclusive ? "lte" : "lt"}).`,
        );
      }
    }
    // `eq` outside the residual interval / membership set.
    if (eq !== undefined) {
      if (group.lo !== undefined) {
        if (!sameComparableType(eq, group.lo.value)) {
          throw new BaerlyError(
            "UnsatisfiablePredicate",
            `Predicate on field ${formatPath([field])} eq=${JSON.stringify(eq)} (${typeof eq}) is type-incompatible with lower bound ${JSON.stringify(group.lo.value)} (${typeof group.lo.value}); range ops require matching primitive types.`,
          );
        }
        const c = compareScalar(eq, group.lo.value);
        if (c < 0 || (c === 0 && !group.lo.inclusive)) {
          throw new BaerlyError(
            "UnsatisfiablePredicate",
            `Predicate on field ${formatPath([field])} eq=${JSON.stringify(eq)} excluded by lower bound ${JSON.stringify(group.lo.value)} (${group.lo.inclusive ? "gte" : "gt"}).`,
          );
        }
      }
      if (group.hi !== undefined) {
        if (!sameComparableType(eq, group.hi.value)) {
          throw new BaerlyError(
            "UnsatisfiablePredicate",
            `Predicate on field ${formatPath([field])} eq=${JSON.stringify(eq)} (${typeof eq}) is type-incompatible with upper bound ${JSON.stringify(group.hi.value)} (${typeof group.hi.value}); range ops require matching primitive types.`,
          );
        }
        const c = compareScalar(eq, group.hi.value);
        if (c > 0 || (c === 0 && !group.hi.inclusive)) {
          throw new BaerlyError(
            "UnsatisfiablePredicate",
            `Predicate on field ${formatPath([field])} eq=${JSON.stringify(eq)} excluded by upper bound ${JSON.stringify(group.hi.value)} (${group.hi.inclusive ? "lte" : "lt"}).`,
          );
        }
      }
      // Stryker disable next-line EqualityOperator,ConditionalExpression: equivalent — the for-of
      // loop over group.ins is a no-op when group.ins is empty, so `>= 0` (always true) and
      // `true` (always enter) produce identical behavior: zero iterations when ins is empty,
      // same iterations as `> 0` when ins is non-empty.
      if (group.ins.length > 0) {
        for (const set of group.ins) {
          let found = false;
          for (const m of set) {
            if (deepEqualDocumentValue(eq, m)) {
              found = true;
              break;
            }
          }
          if (!found) {
            throw new BaerlyError(
              "UnsatisfiablePredicate",
              `Predicate on field ${formatPath([field])} eq=${JSON.stringify(eq)} not present in in() set.`,
            );
          }
        }
      }
    }
    // Multiple `in` sets must intersect non-empty.
    // Stryker disable next-line EqualityOperator: equivalent — intersectInSets([single_set])
    // returns that set unchanged; since validateWire rejects empty in-arrays, the single set
    // is always non-empty, so isect.length === 0 is false and no throw occurs. `>= 1` (entering
    // with 1 in-set) behaves identically to `> 1` (skipping for 1 in-set).
    if (group.ins.length > 1) {
      const isect = intersectInSets(group.ins);
      if (isect.length === 0) {
        throw new BaerlyError(
          "UnsatisfiablePredicate",
          `Predicate on field ${formatPath([field])} has empty in() intersection across multiple clauses.`,
        );
      }
    }
  }
};
