/**
 * Runtime predicate AST + evaluator for the table API.
 *
 * The `Predicate<T>` declared in `../db.ts` is the on-the-wire
 * shape. It is **also** the AST — there is no separate compile step.
 * This module:
 *
 *   1. Validates a predicate object at construction time. Equality
 *      values (string / number / boolean / nested sub-predicate
 *      object) are accepted directly. Operator-shaped values —
 *      objects whose keys all start with `$` — are routed into
 *      operator-mode validation, supporting the vocabulary
 *      `$eq | $gt | $gte | $lt | $lte | $in`.
 *   2. Evaluates a parsed predicate against a `JSONObject` document
 *      via {@link matches}.
 *   3. AND-merges two predicates via {@link mergePredicates} so callers
 *      can implement cumulative `.where({a:1}).where({b:2})` chaining,
 *      with op-aware intersection on operator-shaped values.
 *
 * Operator-object detection rule (used in both `validateNode` and
 * `matchesValue`): a value-object is an op-object iff **every key
 * at that level starts with `$`**. Mixed objects (some `$`, some
 * non-`$`) reject as `InvalidConfig` via the outer `$`-key check
 * in predicate-mode validation.
 *
 * Validation rejections throw `BaerlyError{code:"InvalidConfig"}`
 * with a path-formatted message; emptiness-by-construction throws
 * `BaerlyError{code:"UnsatisfiablePredicate"}`.
 */

import type { Predicate } from "../db.ts";
import { BaerlyError } from "../errors.ts";
import type { JSONArrayless, JSONArraylessObject, JSONObject, JSONValue } from "../json.ts";

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
export type PredicateOp<V extends JSONArrayless> = {
  readonly $eq?: V;
  readonly $gt?: V;
  readonly $gte?: V;
  readonly $lt?: V;
  readonly $lte?: V;
  readonly $in?: readonly V[];
};

const OP_KEYS = ["$eq", "$gt", "$gte", "$lt", "$lte", "$in"] as const;
const RANGE_OPS = ["$gt", "$gte", "$lt", "$lte"] as const;
type RangeOp = (typeof RANGE_OPS)[number];

/**
 * Validate a predicate object's shape. Throws
 * `BaerlyError{code:"InvalidConfig"}` on a structurally bad node,
 * or `BaerlyError{code:"UnsatisfiablePredicate"}` when an operator
 * sub-tree contradicts itself.
 *
 * Recursive: a nested object value is validated as either a
 * sub-predicate (recursive equality on every key) or — if every
 * key at that level starts with `$` — an operator object.
 *
 * Returns the predicate unchanged on success — callers can use the
 * return value to thread the validated AST forward.
 *
 * @example
 * ```ts
 * validatePredicate({ status: "open" }); // ok
 * validatePredicate({ "assignee.team": "platform" }); // ok
 * validatePredicate({ priority: { $in: ["p1", "p2"] } }); // ok
 * validatePredicate({ count: { $gte: 1, $lt: 10 } }); // ok
 * validatePredicate({ $or: "x" }); // throws BaerlyError{InvalidConfig}
 * validatePredicate({ priority: { $in: [] } }); // throws BaerlyError{UnsatisfiablePredicate}
 * ```
 */
export const validatePredicate = <T extends JSONArraylessObject = JSONArraylessObject>(
  predicate: Predicate<T>,
): Predicate<T> => {
  // Root is always predicate-mode: top-level keys are field names,
  // never operators. `{ $gt: 1 }` at root rejects via the in-loop
  // `$`-key check below.
  validateNode(predicate as JSONArraylessObject, [], /* allowOpMode */ false);
  return predicate;
};

const validateNode = (
  node: JSONArraylessObject,
  path: ReadonlyArray<string>,
  allowOpMode: boolean,
): void => {
  // Operator-object detection rule (locked, CONTRACTS.md §10): a
  // value-object is an op-object iff EVERY key at that level starts
  // with `$`. Mixed keys → InvalidConfig via the outer `$`-key check
  // below. An empty object `{}` falls through to the loop and
  // validates as a match-all sub-predicate (no-op).
  //
  // `allowOpMode === false` is set at the root predicate (top-level
  // keys are field names, never operators — `{$gt: 1}` at root is
  // still nonsense) and at members of `$in` / `$eq` (operator
  // objects only appear as field-value containers, one level deep).
  const allKeys = Object.keys(node);
  if (allowOpMode && allKeys.length > 0 && allKeys.every((k) => k.startsWith("$"))) {
    validateOpNode(node, path);
    return;
  }
  for (const key of allKeys) {
    if (key.startsWith("$")) {
      throw new BaerlyError(
        "InvalidConfig",
        `Unsupported predicate operator ${JSON.stringify(key)} at ${formatPath(path)} — mixing operator and non-operator keys is not allowed (an operator object must have every key starting with $).`,
      );
    }
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new BaerlyError(
        "InvalidConfig",
        `Reserved key ${JSON.stringify(key)} not allowed in a predicate at ${formatPath(path)}.`,
      );
    }
    const value: unknown = (node as Record<string, unknown>)[key];
    if (value === null || value === undefined) {
      throw new BaerlyError(
        "InvalidConfig",
        `Predicate value at ${formatPath([...path, key])} is ${value === null ? "null" : "undefined"} — terminal values must be string / number / boolean / nested object.`,
      );
    }
    if (Array.isArray(value)) {
      throw new BaerlyError(
        "InvalidConfig",
        `Predicate value at ${formatPath([...path, key])} is an array — match nested objects with a sub-predicate or use { $in: [...] } for set membership.`,
      );
    }
    const t = typeof value;
    if (t === "object") {
      // Field-value of a predicate-mode parent: may be either an
      // operator object or a sub-predicate. `allowOpMode = true`.
      validateNode(value as JSONArraylessObject, [...path, key], /* allowOpMode */ true);
      continue;
    }
    if (t !== "string" && t !== "number" && t !== "boolean") {
      throw new BaerlyError(
        "InvalidConfig",
        `Predicate value at ${formatPath([...path, key])} has unsupported type ${JSON.stringify(t)} — must be string / number / boolean / nested object.`,
      );
    }
    if (t === "number" && !Number.isFinite(value as number)) {
      // NaN / Infinity round-trip through JSON.parse as null, so they
      // can never match a document; reject at validation time rather
      // than silently produce an always-false predicate.
      throw new BaerlyError(
        "InvalidConfig",
        `Predicate value at ${formatPath([...path, key])} is ${String(value)} — finite numbers only (NaN / Infinity do not round-trip through JSON).`,
      );
    }
  }
};

const validateOpNode = (node: JSONArraylessObject, path: ReadonlyArray<string>): void => {
  const keys = Object.keys(node);
  // Empty op-object would be caught by the caller's "all keys start
  // with $" pre-condition (length > 0), but defensive: callers in
  // future paths might invoke this directly.
  if (keys.length === 0) {
    throw new BaerlyError(
      "InvalidConfig",
      `Empty operator object at ${formatPath(path)} — declare at least one of ${OP_KEYS.join(" / ")}.`,
    );
  }
  for (const key of keys) {
    if (!(OP_KEYS as readonly string[]).includes(key)) {
      throw new BaerlyError(
        "InvalidConfig",
        `Unsupported predicate operator ${JSON.stringify(key)} at ${formatPath(path)} — supported: ${OP_KEYS.join(" / ")}.`,
      );
    }
  }
  if ("$in" in node) {
    const arr: unknown = (node as Record<string, unknown>).$in;
    if (!Array.isArray(arr)) {
      throw new BaerlyError(
        "InvalidConfig",
        `Predicate $in at ${formatPath(path)} must be an array.`,
      );
    }
    if (arr.length === 0) {
      throw new BaerlyError(
        "UnsatisfiablePredicate",
        `Predicate $in at ${formatPath(path)} is empty — no document can match.`,
      );
    }
    for (let i = 0; i < arr.length; i++) {
      validateOpMemberValue(arr[i], [...path, "$in", String(i)]);
    }
  }
  for (const op of RANGE_OPS) {
    if (op in node) {
      validateRangeBound((node as Record<string, unknown>)[op], [...path, op]);
    }
  }
  if ("$eq" in node) {
    validateOpMemberValue((node as Record<string, unknown>).$eq, [...path, "$eq"]);
  }
  assertOpObjectSatisfiable(node as JSONArraylessObject, path);
};

/**
 * Validate a value used as an `$eq` value or `$in` member. Permits
 * string / finite-number / boolean / nested-object (recursed as a
 * sub-predicate so nested `$`-objects on a `$in` member are rejected
 * — operator objects are only valid as field-value containers).
 * Bans null / undefined / arrays / non-finite numbers.
 */
const validateOpMemberValue = (value: unknown, path: ReadonlyArray<string>): void => {
  if (value === null || value === undefined) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate value at ${formatPath(path)} is ${value === null ? "null" : "undefined"} — operator members must be string / number / boolean / nested object.`,
    );
  }
  if (Array.isArray(value)) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate value at ${formatPath(path)} is an array — operator members must be string / number / boolean / nested object.`,
    );
  }
  const t = typeof value;
  if (t === "object") {
    // Recurse via validateNode in predicate-mode — a nested
    // sub-predicate object is OK; a nested operator object as a
    // member of $in / $eq is not (operator objects only appear as
    // field-value containers, and even there only one level deep).
    validateNode(value as JSONArraylessObject, path, /* allowOpMode */ false);
    return;
  }
  if (t !== "string" && t !== "number" && t !== "boolean") {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate value at ${formatPath(path)} has unsupported type ${JSON.stringify(t)} — must be string / number / boolean / nested object.`,
    );
  }
  if (t === "number" && !Number.isFinite(value as number)) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate value at ${formatPath(path)} is ${String(value)} — finite numbers only (NaN / Infinity do not round-trip through JSON).`,
    );
  }
};

/**
 * Validate a value used as a range op bound (`$gt`/`$gte`/`$lt`/
 * `$lte`). Permits string or finite-number only. Booleans, null,
 * undefined, arrays, nested objects, NaN, Infinity all reject —
 * ordering is not meaningful for those types.
 */
const validateRangeBound = (value: unknown, path: ReadonlyArray<string>): void => {
  if (value === null || value === undefined) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate range bound at ${formatPath(path)} is ${value === null ? "null" : "undefined"} — range bounds must be string or finite number.`,
    );
  }
  if (Array.isArray(value)) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate range bound at ${formatPath(path)} is an array — range bounds must be string or finite number.`,
    );
  }
  const t = typeof value;
  if (t === "boolean") {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate range bound at ${formatPath(path)} is a boolean — range bounds must be string or finite number (booleans are not ordered).`,
    );
  }
  if (t === "object") {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate range bound at ${formatPath(path)} is a nested object — range bounds must be string or finite number.`,
    );
  }
  if (t !== "string" && t !== "number") {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate range bound at ${formatPath(path)} has unsupported type ${JSON.stringify(t)} — must be string or finite number.`,
    );
  }
  if (t === "number" && !Number.isFinite(value as number)) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate range bound at ${formatPath(path)} is ${String(value)} — finite numbers only (NaN / Infinity do not round-trip through JSON).`,
    );
  }
};

/**
 * Asserts an operator object's clauses are jointly satisfiable.
 * Triggers `UnsatisfiablePredicate` on:
 *  - `lo > hi` (or `lo == hi` with strict on either side).
 *  - `$eq:X` outside the residual interval.
 *  - `$eq:X` not present in `$in` set.
 *
 * Pre-condition: every leaf already passed `validateOpMemberValue`
 * or `validateRangeBound`, so types are well-formed.
 */
const assertOpObjectSatisfiable = (
  node: JSONArraylessObject,
  path: ReadonlyArray<string>,
): void => {
  const eq =
    "$eq" in node ? ((node as Record<string, JSONArrayless>).$eq as JSONArrayless) : undefined;
  const gt =
    "$gt" in node ? ((node as Record<string, JSONArrayless>).$gt as JSONArrayless) : undefined;
  const gte =
    "$gte" in node ? ((node as Record<string, JSONArrayless>).$gte as JSONArrayless) : undefined;
  const lt =
    "$lt" in node ? ((node as Record<string, JSONArrayless>).$lt as JSONArrayless) : undefined;
  const lte =
    "$lte" in node ? ((node as Record<string, JSONArrayless>).$lte as JSONArrayless) : undefined;
  const inArr =
    "$in" in node
      ? ((node as unknown as Record<string, ReadonlyArray<JSONArrayless>>)
          .$in as ReadonlyArray<JSONArrayless>)
      : undefined;

  // Lower bound: pick the stricter of $gt/$gte. Strict ($gt) wins
  // on equal numeric/string value.
  let lo: { value: JSONArrayless; inclusive: boolean } | undefined;
  if (gt !== undefined) lo = { value: gt, inclusive: false };
  if (gte !== undefined) {
    if (lo === undefined) lo = { value: gte, inclusive: true };
    else if (sameComparableType(lo.value, gte)) {
      const c = compareScalar(lo.value, gte);
      if (c < 0) lo = { value: gte, inclusive: true };
      // tie: strict $gt already in `lo`; keep it.
    }
  }
  // Upper bound: pick the stricter of $lt/$lte. Strict ($lt) wins
  // on tie.
  let hi: { value: JSONArrayless; inclusive: boolean } | undefined;
  if (lt !== undefined) hi = { value: lt, inclusive: false };
  if (lte !== undefined) {
    if (hi === undefined) hi = { value: lte, inclusive: true };
    else if (sameComparableType(hi.value, lte)) {
      const c = compareScalar(hi.value, lte);
      if (c > 0) hi = { value: lte, inclusive: true };
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
        if (deepEqualJSONArrayless(eq, m)) {
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

const sameComparableType = (a: JSONArrayless, b: JSONArrayless): boolean =>
  (typeof a === "string" && typeof b === "string") ||
  (typeof a === "number" && typeof b === "number");

/** Returns negative / zero / positive for a<b / a==b / a>b. */
const compareScalar = (a: JSONArrayless, b: JSONArrayless): number => {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  }
  return 0;
};

const formatPath = (path: ReadonlyArray<string>): string =>
  path.length === 0 ? "<root>" : path.map((p) => JSON.stringify(p)).join(".");

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
 * {@link validatePredicate}. Passing an un-validated predicate is a
 * caller bug; behaviour is undefined.
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
    const expectedKeys = Object.keys(expected);
    // Operator-object detection rule: every key at this level
    // starts with `$`. Empty `{}` is a match-all sub-predicate.
    if (expectedKeys.length > 0 && expectedKeys.every((k) => k.startsWith("$"))) {
      return matchesOp(expected as PredicateOp<JSONArrayless>, actual);
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
 *   `deepEqualJSONArrayless` for object members.
 * - Empty `$in: []` can never reach `matchesOp` (validator
 *   rejects).
 */
const matchesOp = (op: PredicateOp<JSONArrayless>, actual: JSONValue | undefined): boolean => {
  if (op.$eq !== undefined && !matchesValue(op.$eq, actual)) return false;
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
    if (!hit) return false;
  }
  if (op.$gt !== undefined && !compareGT(actual, op.$gt, false)) return false;
  if (op.$gte !== undefined && !compareGT(actual, op.$gte, true)) return false;
  if (op.$lt !== undefined && !compareLT(actual, op.$lt, false)) return false;
  if (op.$lte !== undefined && !compareLT(actual, op.$lte, true)) return false;
  return true;
};

const compareGT = (
  actual: JSONValue | undefined,
  bound: JSONArrayless,
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
  bound: JSONArrayless,
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

/**
 * AND-merge two validated predicates. The result accepts a document
 * iff both `a` and `b` would accept it.
 *
 * Field-level union: keys unique to one side carry over verbatim.
 * Shared keys merge per the operator-aware rules in
 * CONTRACTS.md §10:
 *
 * - Both primitive / non-op: must `deepEqualJSONArrayless` — a
 *   genuine conflict throws `BaerlyError{code:"InvalidConfig"}`.
 * - Both operator-objects: shallow op-level merge —
 *   - `$gt`/`$gte`: keep higher bound; tie favours `$gt` (strict).
 *   - `$lt`/`$lte`: keep lower bound; tie favours `$lt`.
 *   - `$in`: array intersection. Empty → `UnsatisfiablePredicate`.
 *   - `$eq` on both sides with different values →
 *     `UnsatisfiablePredicate`.
 *   - After merge: re-checks satisfiability; `$eq` inside the
 *     residual interval / `$in` set collapses to `{$eq: v}` alone.
 * - One primitive + one op-object: rewrite the primitive as
 *   `{ $eq: primitive }`, then merge as above. **Behaviour shift
 *   vs. pre-T1**: chained `.where({x:1}).where({x:{$in:[1,2]}})`
 *   previously threw `InvalidConfig`; now collapses to `{x:1}`.
 *
 * @example
 * ```ts
 * mergePredicates({ status: "open" }, { priority: "p1" });
 * //   → { status: "open", priority: "p1" }
 *
 * mergePredicates({ count: { $gt: 5 } }, { count: { $gt: 10 } });
 * //   → { count: { $gt: 10 } }
 *
 * mergePredicates({ status: "open" }, { status: "closed" });
 * //   throws BaerlyError{InvalidConfig}: conflicting values for "status"
 *
 * mergePredicates({ x: { $gt: 10 } }, { x: { $lt: 5 } });
 * //   throws BaerlyError{UnsatisfiablePredicate}: empty interval
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
    if (!(key in out)) {
      out[key] = bVal;
      continue;
    }
    const aVal = out[key];
    if (aVal === undefined) continue;
    const aOp = isOpObject(aVal);
    const bOp = isOpObject(bVal);
    if (!aOp && !bOp) {
      if (!deepEqualJSONArrayless(aVal, bVal)) {
        throw new BaerlyError(
          "InvalidConfig",
          `mergePredicates: conflicting values for key ${JSON.stringify(key)} (a=${JSON.stringify(aVal)}, b=${JSON.stringify(bVal)}). Cumulative .where() chains must agree on shared keys.`,
        );
      }
      // values equal — no-op
      continue;
    }
    // Promote a primitive into `{ $eq: primitive }` so we can run
    // the op-aware merge uniformly. The promotion is invisible:
    // `mergeOpObjects` collapses `$eq` alone when no other op
    // constrains it.
    const opA: PredicateOp<JSONArrayless> = aOp
      ? (aVal as PredicateOp<JSONArrayless>)
      : { $eq: aVal };
    const opB: PredicateOp<JSONArrayless> = bOp
      ? (bVal as PredicateOp<JSONArrayless>)
      : { $eq: bVal };
    out[key] = mergeOpObjects(opA, opB, key) as unknown as JSONArrayless;
  }
  return out as Predicate<T>;
};

const isOpObject = (v: JSONArrayless): boolean => {
  if (typeof v !== "object") return false;
  const k = Object.keys(v);
  return k.length > 0 && k.every((x) => x.startsWith("$"));
};

const mergeOpObjects = (
  a: PredicateOp<JSONArrayless>,
  b: PredicateOp<JSONArrayless>,
  field: string,
): JSONArraylessObject => {
  const candidate: Record<string, JSONArrayless> = {};
  // $eq agreement.
  if (a.$eq !== undefined && b.$eq !== undefined) {
    if (!deepEqualJSONArrayless(a.$eq, b.$eq)) {
      throw new BaerlyError(
        "UnsatisfiablePredicate",
        `mergePredicates: conflicting $eq values for key ${JSON.stringify(field)} (a=${JSON.stringify(a.$eq)}, b=${JSON.stringify(b.$eq)}).`,
      );
    }
    candidate.$eq = a.$eq;
  } else if (a.$eq !== undefined) {
    candidate.$eq = a.$eq;
  } else if (b.$eq !== undefined) {
    candidate.$eq = b.$eq;
  }
  // $in intersection.
  if (a.$in !== undefined && b.$in !== undefined) {
    const isect: JSONArrayless[] = [];
    for (const m of a.$in) {
      for (const n of b.$in) {
        if (deepEqualJSONArrayless(m, n)) {
          isect.push(m);
          break;
        }
      }
    }
    if (isect.length === 0) {
      throw new BaerlyError(
        "UnsatisfiablePredicate",
        `mergePredicates: $in intersection is empty for key ${JSON.stringify(field)}.`,
      );
    }
    candidate.$in = isect as unknown as JSONArrayless;
  } else if (a.$in !== undefined) {
    candidate.$in = a.$in as unknown as JSONArrayless;
  } else if (b.$in !== undefined) {
    candidate.$in = b.$in as unknown as JSONArrayless;
  }
  // Lower bound: stricter wins. Strict ($gt) beats inclusive
  // ($gte) on tie.
  const lo = pickStricter("lower", a, b);
  if (lo !== undefined) {
    if (lo.strict) candidate.$gt = lo.value;
    else candidate.$gte = lo.value;
  }
  // Upper bound: stricter wins.
  const hi = pickStricter("upper", a, b);
  if (hi !== undefined) {
    if (hi.strict) candidate.$lt = hi.value;
    else candidate.$lte = hi.value;
  }

  // Re-run satisfiability against the candidate. Reuses the
  // construction-time check so merge and validation stay in
  // lockstep.
  assertOpObjectSatisfiable(candidate as JSONArraylessObject, [field]);

  // If $eq survives alongside any range / $in clause, collapse to
  // `{ $eq: v }` alone — the satisfiability check already proved
  // $eq lies inside the interval / set.
  if (
    candidate.$eq !== undefined &&
    ("$in" in candidate ||
      "$gt" in candidate ||
      "$gte" in candidate ||
      "$lt" in candidate ||
      "$lte" in candidate)
  ) {
    return { $eq: candidate.$eq };
  }
  return candidate;
};

/**
 * Pick the stricter (higher for "lower", lower for "upper") of the
 * two declared bounds across `a` and `b`. Strict (`$gt` / `$lt`)
 * wins on equal scalar value. Returns `undefined` when neither
 * side declares the bound, or when types are incomparable (e.g.
 * `$gt: 1` on one side and `$gt: "x"` on the other — defensive,
 * shouldn't happen in well-formed input).
 */
const pickStricter = (
  side: "lower" | "upper",
  a: PredicateOp<JSONArrayless>,
  b: PredicateOp<JSONArrayless>,
): { value: JSONArrayless; strict: boolean } | undefined => {
  const strictOp: RangeOp = side === "lower" ? "$gt" : "$lt";
  const inclOp: RangeOp = side === "lower" ? "$gte" : "$lte";
  const collect = (
    op: PredicateOp<JSONArrayless>,
  ): Array<{ value: JSONArrayless; strict: boolean }> => {
    const out: Array<{ value: JSONArrayless; strict: boolean }> = [];
    const s = (op as Record<string, JSONArrayless>)[strictOp];
    const i = (op as Record<string, JSONArrayless>)[inclOp];
    if (s !== undefined) out.push({ value: s, strict: true });
    if (i !== undefined) out.push({ value: i, strict: false });
    return out;
  };
  const candidates = [...collect(a), ...collect(b)];
  if (candidates.length === 0) return undefined;
  let best = candidates[0]!;
  for (let i = 1; i < candidates.length; i++) {
    const cur = candidates[i]!;
    if (!sameComparableType(best.value, cur.value)) return undefined;
    const c = compareScalar(best.value, cur.value);
    if (side === "lower") {
      if (c < 0) best = cur;
      else if (c === 0 && cur.strict && !best.strict) best = cur;
    } else {
      if (c > 0) best = cur;
      else if (c === 0 && cur.strict && !best.strict) best = cur;
    }
  }
  return best;
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
