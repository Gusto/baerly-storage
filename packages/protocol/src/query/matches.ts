/**
 * Predicate evaluator. Walks a validated `Predicate<T>` against a
 * `JSONObject` document and returns `true` iff every clause holds.
 *
 * Companion modules: `./validate.ts` (construction-time check),
 * `./merge.ts` (AND-merge). Shared types and helpers live in
 * `./_internals.ts`.
 */

import type { Predicate } from "../table-api.ts";
import type { DocumentData, DocumentValue, JSONObject, JSONValue } from "../json.ts";

import { type PredicateOp } from "./_internals.ts";

/**
 * Evaluate a validated predicate against a `JSONObject` document.
 *
 * Returns `true` iff every key in the predicate satisfies its
 * value-spec. Dotted-path keys (`"assignee.team"`) traverse nested
 * objects. Object values whose keys all start with `$` are
 * interpreted as operator objects ({@link PredicateOp}); other
 * object values are interpreted as sub-predicates (open-world:
 * extra keys in the document are ignored).
 *
 * Pre-condition: `predicate` must have been returned by
 * `validatePredicate` (see `./validate.ts`). Passing an
 * un-validated predicate is a caller bug; behaviour is undefined.
 *
 * @example
 * ```ts
 * matches({ status: "open" }, { status: "open", priority: "p1" }); // true
 * matches({ "assignee.team": "platform" }, { assignee: { team: "platform" } }); // true
 * matches({ assignee: { team: "platform" } }, { assignee: { team: "platform", oncall: "a" } }); // true
 * matches({ count: { $gte: 1, $lt: 10 } }, { count: 5 }); // true
 * matches({ priority: { $in: ["p1", "p2"] } }, { priority: "p3" }); // false
 * matches({ status: "open" }, { status: "closed" }); // false
 * matches({ "a.b": "c" }, { a: "literal" }); // false (path traversal stops at non-object)
 * ```
 */
export const matches = <T extends DocumentData = DocumentData>(
  predicate: Predicate<T>,
  doc: JSONObject,
): boolean => {
  for (const key of Object.keys(predicate)) {
    const expected: unknown = (predicate as Record<string, unknown>)[key];
    const actual = lookupPath(doc, key);
    if (!matchesValue(expected as DocumentValue, actual)) {
      return false;
    }
  }
  return true;
};

const lookupPath = (doc: JSONObject, key: string): JSONValue | undefined => {
  // Fast path: no dot → top-level lookup. Avoids allocating a split
  // array for the common case.
  if (!key.includes(".")) {
    return doc[key];
  }

  const segments = key.split(".");
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

const matchesValue = (expected: DocumentValue, actual: JSONValue | undefined): boolean => {
  if (typeof expected === "object") {
    const expectedKeys = Object.keys(expected);
    // Operator-object detection rule: every key at this level
    // starts with `$`. Empty `{}` is a match-all sub-predicate.
    if (expectedKeys.length > 0 && expectedKeys.every((k) => k.startsWith("$"))) {
      return matchesOp(expected as PredicateOp<DocumentValue>, actual);
    }
    if (
      actual === undefined ||
      actual === null ||
      typeof actual !== "object" ||
      Array.isArray(actual)
    ) {
      return false;
    }
    // Sub-predicate: recurse into every key in `expected`; doc may
    // carry extra keys (open-world).
    for (const subKey of expectedKeys) {
      const subExpected = (expected as Record<string, DocumentValue>)[subKey];
      if (subExpected === undefined) {
        continue;
      } // tsc satisfaction; validator forbids undefined
      const subActual = (actual as JSONObject)[subKey];
      if (!matchesValue(subExpected, subActual)) {
        return false;
      }
    }
    return true;
  }
  // Primitive: strict equality. JSON's primitives are value-equal
  // under `===` (string / number / boolean), so no further work.
  return expected === actual;
};

/**
 * Evaluate an operator object against a doc value. All declared ops
 * AND together — multiple ops on one field
 * (`{ $gte: 1, $lt: 10 }`) are a conjunction.
 *
 * Critical semantic notes:
 * - Boolean / null / missing / mismatched-type actuals against
 *   range ops are **always-miss**, never throw. Mirrors the
 *   equality matcher's type-mismatch behaviour
 *   (`matches({count: 7}, {count: "7"})` returns `false`).
 * - String comparison uses JS `<` / `>` (UTF-16 code-unit order).
 *   Matches the byte order the index encoder produces on stored
 *   ASCII strings; numeric ranges are unsafe under the byte-order
 *   index encoder (T3's footgun, not T1's matcher).
 * - `$in` membership: `===` for primitives,
 *   `deepEqualDocumentValue` for object members.
 * - Empty `$in: []` can never reach `matchesOp` (validator
 *   rejects).
 */
const matchesOp = (op: PredicateOp<DocumentValue>, actual: JSONValue | undefined): boolean => {
  if (op.$eq !== undefined && !matchesValue(op.$eq, actual)) {
    return false;
  }
  if (op.$in !== undefined) {
    let hit = false;
    for (const m of op.$in) {
      if (typeof m === "object") {
        if (matchesValue(m, actual)) {
          hit = true;
          break;
        }
      } else if (m === actual) {
        hit = true;
        break;
      }
    }
    if (!hit) {
      return false;
    }
  }
  if (op.$gt !== undefined && !compareGT(actual, op.$gt, false)) {
    return false;
  }
  if (op.$gte !== undefined && !compareGT(actual, op.$gte, true)) {
    return false;
  }
  if (op.$lt !== undefined && !compareLT(actual, op.$lt, false)) {
    return false;
  }
  if (op.$lte !== undefined && !compareLT(actual, op.$lte, true)) {
    return false;
  }
  return true;
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
