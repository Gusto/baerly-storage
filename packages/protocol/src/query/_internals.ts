/**
 * Shared helpers for the predicate algebras in `./validate.ts`,
 * `./matches.ts`, and `./merge.ts`. These exist as a single module
 * because more than one of those files uses them and duplicating
 * the implementations would drift over time.
 *
 * Everything in here except {@link PredicateOp} and
 * {@link deepEqualDocumentValue} is internal to the protocol
 * package — the test files import from the split modules, not from
 * here.
 */

import type { DocumentValue, DocumentData } from "../json.ts";
import { BaerlyError } from "../errors.ts";

/**
 * Operator-shaped value for a predicate field. An "operator object"
 * is one whose keys all start with `$`. Today's supported vocabulary
 * (T1):
 *
 * - `$eq` — strict equality (string / number / boolean / nested
 *   sub-predicate object).
 * - `$gt` / `$gte` / `$lt` / `$lte` — scalar range. Bounds must be
 *   `string` or finite `number`. Matching is type-strict: a numeric
 *   bound against a string actual is always-miss, never a throw.
 * - `$in` — set membership. Members may be primitives or nested
 *   sub-predicate objects. `$in: []` is rejected at validation
 *   (unsatisfiable).
 *
 * Multiple operators on the same field AND together
 * (`{ count: { $gte: 1, $lt: 10 } }`). Validation rejects empty
 * operator objects, unknown ops (e.g. `$regex`), `lo > hi`
 * intervals, and `$eq` outside an interval / `$in` set on the same
 * op-object.
 */
export type PredicateOp<V extends DocumentValue> = {
  readonly $eq?: V;
  readonly $gt?: V;
  readonly $gte?: V;
  readonly $lt?: V;
  readonly $lte?: V;
  readonly $in?: readonly V[];
};

/** @internal Same primitive type for comparison purposes. */
export const sameComparableType = (a: DocumentValue, b: DocumentValue): boolean =>
  (typeof a === "string" && typeof b === "string") ||
  (typeof a === "number" && typeof b === "number");

/**
 * @internal Returns negative / zero / positive for a<b / a==b / a>b.
 */
export const compareScalar = (a: DocumentValue, b: DocumentValue): number => {
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "string" && typeof b === "string") {
    if (a < b) {
      return -1;
    }
    if (a > b) {
      return 1;
    }
    return 0;
  }
  return 0;
};

/** @internal Render a predicate path for use in error messages. */
export const formatPath = (path: ReadonlyArray<string>): string =>
  path.length === 0 ? "<root>" : path.map((p) => JSON.stringify(p)).join(".");

/**
 * @internal Asserts an operator object's clauses are jointly
 * satisfiable. Triggers `UnsatisfiablePredicate` on:
 *  - `lo > hi` (or `lo == hi` with strict on either side).
 *  - `$eq:X` outside the residual interval.
 *  - `$eq:X` not present in `$in` set.
 *
 * Pre-condition: every leaf already passed `validateOpMemberValue`
 * or `validateRangeBound`, so types are well-formed.
 *
 * Used by both `./validate.ts` (construction-time check) and
 * `./merge.ts` (post-merge re-check, kept in lockstep with the
 * validator).
 */
export const assertOpObjectSatisfiable = (
  node: DocumentData,
  path: ReadonlyArray<string>,
): void => {
  const eq =
    "$eq" in node ? ((node as Record<string, DocumentValue>)["$eq"] as DocumentValue) : undefined;
  const gt =
    "$gt" in node ? ((node as Record<string, DocumentValue>)["$gt"] as DocumentValue) : undefined;
  const gte =
    "$gte" in node ? ((node as Record<string, DocumentValue>)["$gte"] as DocumentValue) : undefined;
  const lt =
    "$lt" in node ? ((node as Record<string, DocumentValue>)["$lt"] as DocumentValue) : undefined;
  const lte =
    "$lte" in node ? ((node as Record<string, DocumentValue>)["$lte"] as DocumentValue) : undefined;
  const inArr =
    "$in" in node
      ? ((node as unknown as Record<string, ReadonlyArray<DocumentValue>>)[
          "$in"
        ] as ReadonlyArray<DocumentValue>)
      : undefined;

  // Lower bound: pick the stricter of $gt/$gte. Strict ($gt) wins
  // on equal numeric/string value.
  let lo: { value: DocumentValue; inclusive: boolean } | undefined;
  if (gt !== undefined) {
    lo = { value: gt, inclusive: false };
  }
  if (gte !== undefined) {
    if (lo === undefined) {
      lo = { value: gte, inclusive: true };
    } else if (sameComparableType(lo.value, gte)) {
      const c = compareScalar(lo.value, gte);
      if (c < 0) {
        lo = { value: gte, inclusive: true };
      }
      // tie: strict $gt already in `lo`; keep it.
    }
  }
  // Upper bound: pick the stricter of $lt/$lte. Strict ($lt) wins
  // on tie.
  let hi: { value: DocumentValue; inclusive: boolean } | undefined;
  if (lt !== undefined) {
    hi = { value: lt, inclusive: false };
  }
  if (lte !== undefined) {
    if (hi === undefined) {
      hi = { value: lte, inclusive: true };
    } else if (sameComparableType(hi.value, lte)) {
      const c = compareScalar(hi.value, lte);
      if (c > 0) {
        hi = { value: lte, inclusive: true };
      }
    }
  }

  if (lo !== undefined && hi !== undefined && sameComparableType(lo.value, hi.value)) {
    const c = compareScalar(lo.value, hi.value);
    if (c > 0 || (c === 0 && (!lo.inclusive || !hi.inclusive))) {
      throw new BaerlyError(
        "UnsatisfiablePredicate",
        `Predicate at ${formatPath(path)} has empty interval (lo=${JSON.stringify(lo.value)} ${lo.inclusive ? "$gte" : "$gt"}, hi=${JSON.stringify(hi.value)} ${hi.inclusive ? "$lte" : "$lt"}).`,
      );
    }
  }

  if (eq !== undefined) {
    // Type-incompatibility between $eq and any range bound is
    // provably unsatisfiable: range ops always-miss against
    // type-mismatched actuals, so the conjunction $eq:X ∧ $gt:Y
    // (with `typeof X !== typeof Y`, or X non-comparable) admits no
    // value. Detect this BEFORE the same-type comparison below;
    // otherwise the collapse step drops the range and the predicate
    // silently widens.
    if (lo !== undefined && !sameComparableType(eq, lo.value)) {
      throw new BaerlyError(
        "UnsatisfiablePredicate",
        `Predicate at ${formatPath(path)} $eq=${JSON.stringify(eq)} (${typeof eq}) is type-incompatible with lower bound ${JSON.stringify(lo.value)} (${typeof lo.value}); range ops require matching primitive types.`,
      );
    }
    if (hi !== undefined && !sameComparableType(eq, hi.value)) {
      throw new BaerlyError(
        "UnsatisfiablePredicate",
        `Predicate at ${formatPath(path)} $eq=${JSON.stringify(eq)} (${typeof eq}) is type-incompatible with upper bound ${JSON.stringify(hi.value)} (${typeof hi.value}); range ops require matching primitive types.`,
      );
    }
    if (lo !== undefined && sameComparableType(eq, lo.value)) {
      const c = compareScalar(eq, lo.value);
      if (c < 0 || (c === 0 && !lo.inclusive)) {
        throw new BaerlyError(
          "UnsatisfiablePredicate",
          `Predicate at ${formatPath(path)} $eq=${JSON.stringify(eq)} excluded by lower bound ${JSON.stringify(lo.value)} (${lo.inclusive ? "$gte" : "$gt"}).`,
        );
      }
    }
    if (hi !== undefined && sameComparableType(eq, hi.value)) {
      const c = compareScalar(eq, hi.value);
      if (c > 0 || (c === 0 && !hi.inclusive)) {
        throw new BaerlyError(
          "UnsatisfiablePredicate",
          `Predicate at ${formatPath(path)} $eq=${JSON.stringify(eq)} excluded by upper bound ${JSON.stringify(hi.value)} (${hi.inclusive ? "$lte" : "$lt"}).`,
        );
      }
    }
    if (inArr !== undefined) {
      let found = false;
      for (const m of inArr) {
        if (deepEqualDocumentValue(eq, m)) {
          found = true;
          break;
        }
      }
      if (!found) {
        throw new BaerlyError(
          "UnsatisfiablePredicate",
          `Predicate at ${formatPath(path)} $eq=${JSON.stringify(eq)} not present in $in set.`,
        );
      }
    }
  }
};

/**
 * Recursive structural equality for `DocumentValue` values. Lifted to
 * `export` so the filtered-index implication checker (in
 * `@baerly/server`'s query planner) and other callers can reuse the
 * same comparison rule the validator + merger already trust. Two
 * values `a` and `b` are equal iff:
 *
 *  - they are reference-equal (covers primitives and object identity);
 *  - or they are both non-`null` objects with the same key set, and
 *    every value pair is recursively equal.
 *
 * Arrays are out-of-band for `DocumentValue`; this function rejects
 * them implicitly via the same key-set walk (an array reads as an
 * object with numeric-string keys plus a `length` exposure that
 * `Object.keys` happens to skip — defensive callers should still gate
 * with `Array.isArray` first).
 */
export const deepEqualDocumentValue = (a: DocumentValue, b: DocumentValue): boolean => {
  if (a === b) {
    return true;
  } // primitives + object identity
  if (typeof a !== "object" || typeof b !== "object") {
    return false;
  }
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const key of aKeys) {
    if (!(key in b)) {
      return false;
    }
    const aSub = (a as Record<string, DocumentValue>)[key];
    const bSub = (b as Record<string, DocumentValue>)[key];
    if (aSub === undefined || bSub === undefined) {
      return false;
    }
    if (!deepEqualDocumentValue(aSub, bSub)) {
      return false;
    }
  }
  return true;
};
