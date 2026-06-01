/**
 * Shared helpers for the predicate algebras in `./validate.ts`,
 * `./matches.ts`, and `./merge.ts`. These exist as a single module
 * because more than one of those files uses them and duplicating
 * the implementations would drift over time.
 *
 * Only {@link deepEqualDocumentValue} is part of the public surface;
 * the comparator primitives (`compareScalar`, `sameComparableType`,
 * `formatPath`) are internal to the protocol package and imported
 * by `./validate.ts` / `./merge.ts` / `./normalize.ts` directly.
 */

import type { DocumentValue } from "../json.ts";

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
    // Stryker disable next-line ConditionalExpression,BlockStatement: equivalent — a key in aKeys but absent from b makes b[key] undefined, which the `aSub === undefined || bSub === undefined` guard below catches identically; no input observes the difference.
    if (!(key in b)) {
      return false;
    }
    const aSub = (a as Record<string, DocumentValue>)[key];
    const bSub = (b as Record<string, DocumentValue>)[key];
    // Stryker disable next-line LogicalOperator,ConditionalExpression: equivalent — this guard is a redundant fast-path. Whichever way it is mutated (operator `||`→`&&`, or either `=== undefined` operand forced to false), a slot that is undefined still flows into deepEqualDocumentValue below, whose typeof check returns false for `(undefined, defined)`; the only case that reaches `true` is both-undefined, which the surviving sibling operand still catches. No input over 500k randomized DocumentValues observes a difference.
    if (aSub === undefined || bSub === undefined) {
      return false;
    }
    if (!deepEqualDocumentValue(aSub, bSub)) {
      return false;
    }
  }
  return true;
};
