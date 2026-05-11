/**
 * Runtime predicate AST + evaluator for the table API.
 *
 * The `Predicate<T>` declared in `../db.ts` (Phase 2) is the on-the-wire
 * shape. It is **also** the AST — there is no separate compile step.
 * This module:
 *
 *   1. Validates a predicate object at construction time, rejecting
 *      any key beginning with `$` (no `$or` / `$gt` / `$in` / `$regex`
 *      on day one), `null` / `undefined` values, and array values.
 *   2. Evaluates a parsed predicate against a `JSONObject` document
 *      via {@link matches}.
 *   3. AND-merges two predicates via {@link mergePredicates} so callers
 *      can implement cumulative `.where({a:1}).where({b:2})` chaining.
 *
 * All validator rejections throw `MPS3Error{code:"InvalidConfig"}`
 * with a message that names the offending operator or key.
 */

import type { Predicate } from "../db";
import { MPS3Error } from "../errors";
import type { JSONArrayless, JSONArraylessObject, JSONObject, JSONValue } from "../json";

/**
 * Validate a predicate object's shape. Throws
 * `MPS3Error{code:"InvalidConfig"}` on the first offending key.
 *
 * Recursive: a nested object value is validated as a sub-predicate,
 * which means `$`-prefixed keys are banned at any depth (not just at
 * the top level).
 *
 * Returns the predicate unchanged on success — callers can use the
 * return value to thread the validated AST forward.
 *
 * @example
 * ```ts
 * validatePredicate({ status: "open" }); // ok
 * validatePredicate({ "assignee.team": "platform" }); // ok
 * validatePredicate({ $or: "x" }); // throws MPS3Error{InvalidConfig}
 * ```
 */
export const validatePredicate = <T extends JSONArraylessObject = JSONArraylessObject>(
  predicate: Predicate<T>,
): Predicate<T> => {
  validateNode(predicate as JSONArraylessObject, []);
  return predicate;
};

const validateNode = (node: JSONArraylessObject, path: ReadonlyArray<string>): void => {
  for (const key of Object.keys(node)) {
    if (key.startsWith("$")) {
      throw new MPS3Error(
        "InvalidConfig",
        `Unsupported predicate operator ${JSON.stringify(key)} at ${formatPath(path)} — day-one policy is equality + dotted-path only (no $or / $gt / $in / $regex).`,
      );
    }
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new MPS3Error(
        "InvalidConfig",
        `Reserved key ${JSON.stringify(key)} not allowed in a predicate at ${formatPath(path)}.`,
      );
    }
    const value: unknown = (node as Record<string, unknown>)[key];
    if (value === null || value === undefined) {
      throw new MPS3Error(
        "InvalidConfig",
        `Predicate value at ${formatPath([...path, key])} is ${value === null ? "null" : "undefined"} — terminal values must be string / number / boolean / nested object.`,
      );
    }
    if (Array.isArray(value)) {
      throw new MPS3Error(
        "InvalidConfig",
        `Predicate value at ${formatPath([...path, key])} is an array — day-one policy bans array values (no $in: [...]). Match nested objects with a sub-predicate instead.`,
      );
    }
    const t = typeof value;
    if (t === "object") {
      validateNode(value as JSONArraylessObject, [...path, key]);
      continue;
    }
    if (t !== "string" && t !== "number" && t !== "boolean") {
      throw new MPS3Error(
        "InvalidConfig",
        `Predicate value at ${formatPath([...path, key])} has unsupported type ${JSON.stringify(t)} — must be string / number / boolean / nested object.`,
      );
    }
    if (t === "number" && !Number.isFinite(value as number)) {
      // NaN / Infinity round-trip through JSON.parse as null, so they
      // can never match a document; reject at validation time rather
      // than silently produce an always-false predicate.
      throw new MPS3Error(
        "InvalidConfig",
        `Predicate value at ${formatPath([...path, key])} is ${String(value)} — finite numbers only (NaN / Infinity do not round-trip through JSON).`,
      );
    }
  }
};

const formatPath = (path: ReadonlyArray<string>): string =>
  path.length === 0 ? "<root>" : path.map((p) => JSON.stringify(p)).join(".");

/**
 * Evaluate a validated predicate against a `JSONObject` document.
 *
 * Returns `true` iff every key in the predicate satisfies its
 * value-spec. Dotted-path keys (`"assignee.team"`) traverse nested
 * objects. Object values in the predicate are interpreted as
 * sub-predicates — the document's value at that path must be an
 * object and must structurally satisfy every key in the sub-tree
 * (open-world: extra keys in the document are ignored).
 *
 * Pre-condition: `predicate` must have been returned by
 * {@link validatePredicate}. Passing an un-validated predicate is a
 * caller bug; behaviour is undefined.
 *
 * @example
 * ```ts
 * matches({ status: "open" }, { status: "open", priority: "p1" }); // true
 * matches({ "assignee.team": "platform" }, { assignee: { team: "platform" } }); // true
 * matches({ assignee: { team: "platform" } }, { assignee: { team: "platform", oncall: "a" } }); // true
 * matches({ status: "open" }, { status: "closed" }); // false
 * matches({ "a.b": "c" }, { a: "literal" }); // false (path traversal stops at non-object)
 * ```
 */
export const matches = <T extends JSONArraylessObject = JSONArraylessObject>(
  predicate: Predicate<T>,
  doc: JSONObject,
): boolean => {
  for (const key of Object.keys(predicate)) {
    const expected: unknown = (predicate as Record<string, unknown>)[key];
    const actual = lookupPath(doc, key);
    if (!matchesValue(expected as JSONArrayless, actual)) return false;
  }
  return true;
};

const lookupPath = (doc: JSONObject, key: string): JSONValue | undefined => {
  // Fast path: no dot → top-level lookup. Avoids allocating a split
  // array for the common case.
  if (!key.includes(".")) return doc[key];

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

const matchesValue = (expected: JSONArrayless, actual: JSONValue | undefined): boolean => {
  if (typeof expected === "object") {
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
    for (const subKey of Object.keys(expected)) {
      const subExpected = (expected as Record<string, JSONArrayless>)[subKey];
      if (subExpected === undefined) continue; // tsc satisfaction; validator forbids undefined
      const subActual = (actual as JSONObject)[subKey];
      if (!matchesValue(subExpected, subActual)) return false;
    }
    return true;
  }
  // Primitive: strict equality. JSON's primitives are value-equal
  // under `===` (string / number / boolean), so no further work.
  return expected === actual;
};

/**
 * AND-merge two validated predicates. The result accepts a document
 * iff both `a` and `b` would accept it.
 *
 * Field-level union: keys unique to one side carry over verbatim;
 * keys shared between both sides must be deep-equal at the
 * `JSONArrayless` level. A genuine conflict (e.g. `a = {x: 1}` and
 * `b = {x: 2}`) is unsatisfiable; rather than silently produce an
 * always-false predicate we throw
 * `MPS3Error{code:"InvalidConfig"}` with a message that names the
 * key and both values.
 *
 * @example
 * ```ts
 * mergePredicates({ status: "open" }, { priority: "p1" });
 * //   → { status: "open", priority: "p1" }
 *
 * mergePredicates({ status: "open" }, { status: "open" });
 * //   → { status: "open" } (shared key, same value — fine)
 *
 * mergePredicates({ status: "open" }, { status: "closed" });
 * //   throws MPS3Error{InvalidConfig}: conflicting values for "status"
 * ```
 */
export const mergePredicates = <T extends JSONArraylessObject = JSONArraylessObject>(
  a: Predicate<T>,
  b: Predicate<T>,
): Predicate<T> => {
  const out: Record<string, JSONArrayless> = { ...(a as Record<string, JSONArrayless>) };
  for (const key of Object.keys(b)) {
    const bVal = (b as Record<string, JSONArrayless>)[key];
    if (bVal === undefined) continue; // tsc satisfaction; validator forbids undefined
    if (key in out) {
      const aVal = out[key];
      if (aVal === undefined || !deepEqualJSONArrayless(aVal, bVal)) {
        throw new MPS3Error(
          "InvalidConfig",
          `mergePredicates: conflicting values for key ${JSON.stringify(key)} (a=${JSON.stringify(aVal)}, b=${JSON.stringify(bVal)}). Cumulative .where() chains must agree on shared keys.`,
        );
      }
      // values equal — no-op
      continue;
    }
    out[key] = bVal;
  }
  return out as Predicate<T>;
};

const deepEqualJSONArrayless = (a: JSONArrayless, b: JSONArrayless): boolean => {
  if (a === b) return true; // primitives + object identity
  if (typeof a !== "object" || typeof b !== "object") return false;
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!(key in b)) return false;
    const aSub = (a as Record<string, JSONArrayless>)[key];
    const bSub = (b as Record<string, JSONArrayless>)[key];
    if (aSub === undefined || bSub === undefined) return false;
    if (!deepEqualJSONArrayless(aSub, bSub)) return false;
  }
  return true;
};
