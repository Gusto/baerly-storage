/**
 * Predicate validator. Walks a `Predicate<T>` and throws on a
 * structurally bad node (`BaerlyError{code:"InvalidConfig"}`) or an
 * operator sub-tree that contradicts itself
 * (`BaerlyError{code:"UnsatisfiablePredicate"}`).
 *
 * The `Predicate<T>` declared in `../table-api.ts` is the on-the-
 * wire shape AND the AST — there is no separate compile step.
 *
 * Operator-object detection rule (used in both `validateNode` and
 * the matcher in `./matches.ts`): a value-object is an op-object
 * iff **every key at that level starts with `$`**. Mixed objects
 * (some `$`, some non-`$`) reject as `InvalidConfig` via the outer
 * `$`-key check in predicate-mode validation.
 *
 * Companion modules: `./matches.ts` (evaluator), `./merge.ts`
 * (AND-merge). Shared helpers (`assertOpObjectSatisfiable`,
 * `sameComparableType`, etc.) live in `./_internals.ts`.
 */

import type { Predicate } from "../table-api.ts";
import { BaerlyError } from "../errors.ts";
import type { DocumentData } from "../json.ts";

import { assertOpObjectSatisfiable, formatPath } from "./_internals.ts";

const OP_KEYS = ["$eq", "$gt", "$gte", "$lt", "$lte", "$in"] as const;
const RANGE_OPS = ["$gt", "$gte", "$lt", "$lte"] as const;

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
export const validatePredicate = <T extends DocumentData = DocumentData>(
  predicate: Predicate<T>,
): Predicate<T> => {
  // Root is always predicate-mode: top-level keys are field names,
  // never operators. `{ $gt: 1 }` at root rejects via the in-loop
  // `$`-key check below.
  validateNode(predicate as DocumentData, [], /* allowOpMode */ false);
  return predicate;
};

const validateNode = (
  node: DocumentData,
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
      validateNode(value as DocumentData, [...path, key], /* allowOpMode */ true);
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

const validateOpNode = (node: DocumentData, path: ReadonlyArray<string>): void => {
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
    const arr: unknown = (node as Record<string, unknown>)["$in"];
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
    validateOpMemberValue((node as Record<string, unknown>)["$eq"], [...path, "$eq"]);
  }
  assertOpObjectSatisfiable(node as DocumentData, path);
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
    validateNode(value as DocumentData, path, /* allowOpMode */ false);
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

