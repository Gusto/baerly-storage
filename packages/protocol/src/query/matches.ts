/**
 * Wire predicate evaluator. Walks a validated {@link PredicateWire}
 * against a `JSONObject` document and returns `true` iff every
 * clause holds. Multiple clauses across all fields AND together.
 *
 * Pre-condition: `wire` must have been returned by
 * {@link validateWire} (see `./validate.ts`). Passing an
 * un-validated wire is a caller bug; behaviour is undefined.
 *
 * Companion modules: `./validate.ts` (construction-time check),
 * `./merge.ts` (AND-merge), `./wire.ts` (types).
 */

import type { DocumentValue, JSONObject, JSONValue } from "../json.ts";

import type { PredicateClause, PredicateWire } from "./wire.ts";

/**
 * Evaluate a validated wire-form predicate against a `JSONObject`
 * document. Returns `true` iff every clause holds.
 *
 * @example
 * ```ts
 * matchesWire(
 *   { clauses: [{ op: "eq", field: "status", value: "open" }] },
 *   { status: "open", priority: "p1" },
 * ); // true
 *
 * matchesWire(
 *   { clauses: [{ op: "in", field: "priority", value: ["p1", "p2"] }] },
 *   { priority: "p3" },
 * ); // false
 *
 * matchesWire(
 *   {
 *     clauses: [
 *       { op: "gte", field: "count", value: 1 },
 *       { op: "lt", field: "count", value: 10 },
 *     ],
 *   },
 *   { count: 5 },
 * ); // true
 * ```
 */
export const matchesWire = (wire: PredicateWire, doc: JSONObject): boolean => {
  for (const clause of wire.clauses) {
    const actual = lookupPath(doc, clause.field);
    if (!matchesClause(clause, actual)) {
      return false;
    }
  }
  return true;
};

const lookupPath = (doc: JSONObject, field: string): JSONValue | undefined => {
  // Fast path: no dot → top-level lookup. Avoids allocating a split
  // array for the common case.
  if (!field.includes(".")) {
    return doc[field];
  }
  const segments = field.split(".");
  let cursor: JSONValue | undefined = doc;
  for (const segment of segments) {
    if (
      cursor === undefined ||
      cursor === null ||
      typeof cursor !== "object" ||
      Array.isArray(cursor)
    ) {
      // Traversal hit a primitive, null, missing key, or array
      // before consuming the path. Predicate cannot match.
      return undefined;
    }
    cursor = (cursor as JSONObject)[segment];
  }
  return cursor;
};

const matchesClause = (clause: PredicateClause, actual: JSONValue | undefined): boolean => {
  switch (clause.op) {
    case "eq": {
      return matchesEq(clause.value as DocumentValue, actual);
    }
    case "in": {
      return matchesIn(clause.value as ReadonlyArray<DocumentValue>, actual);
    }
    case "gt": {
      return compareGT(actual, clause.value as DocumentValue, false);
    }
    case "gte": {
      return compareGT(actual, clause.value as DocumentValue, true);
    }
    case "lt": {
      return compareLT(actual, clause.value as DocumentValue, false);
    }
    case "lte": {
      return compareLT(actual, clause.value as DocumentValue, true);
    }
  }
};

const matchesEq = (expected: DocumentValue, actual: JSONValue | undefined): boolean => {
  if (typeof expected === "object") {
    // Nested object equality is a sub-predicate match — open-world:
    // doc may carry extra keys. The object-form normaliser flattens
    // nested sub-predicates to dotted-path clauses on the way in, so
    // the only callers reaching this branch are callback-form
    // `q.eq("nested", { ... })`.
    if (
      actual === undefined ||
      actual === null ||
      typeof actual !== "object" ||
      Array.isArray(actual)
    ) {
      return false;
    }
    for (const subKey of Object.keys(expected)) {
      const subExpected = (expected as Record<string, DocumentValue>)[subKey];
      if (subExpected === undefined) {
        continue;
      }
      const subActual = (actual as JSONObject)[subKey];
      if (!matchesEq(subExpected, subActual)) {
        return false;
      }
    }
    return true;
  }
  return expected === actual;
};

const matchesIn = (
  members: ReadonlyArray<DocumentValue>,
  actual: JSONValue | undefined,
): boolean => {
  for (const m of members) {
    if (typeof m === "object") {
      if (matchesEq(m, actual)) {
        return true;
      }
    } else if (m === actual) {
      return true;
    }
  }
  return false;
};

const compareGT = (
  actual: JSONValue | undefined,
  bound: DocumentValue,
  inclusive: boolean,
): boolean => {
  if (typeof bound === "string") {
    return typeof actual === "string" && (inclusive ? actual >= bound : actual > bound);
  }
  if (typeof bound === "number") {
    return typeof actual === "number" && (inclusive ? actual >= bound : actual > bound);
  }
  // Validator forbids boolean / null / object range bounds; defensive miss.
  return false;
};

const compareLT = (
  actual: JSONValue | undefined,
  bound: DocumentValue,
  inclusive: boolean,
): boolean => {
  if (typeof bound === "string") {
    return typeof actual === "string" && (inclusive ? actual <= bound : actual < bound);
  }
  if (typeof bound === "number") {
    return typeof actual === "number" && (inclusive ? actual <= bound : actual < bound);
  }
  return false;
};
