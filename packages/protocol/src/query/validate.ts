/**
 * Wire predicate validator. Walks a {@link PredicateWire} and throws
 * on a structurally bad clause (`BaerlyError{code:"InvalidConfig"}`)
 * or a per-field clause group that contradicts itself
 * (`BaerlyError{code:"UnsatisfiablePredicate"}`).
 *
 * The object-form normaliser at `./normalize.ts` enforces shape on
 * the way in (rejecting `$`-keys / non-scalars / null / undefined);
 * the callback builder at `./builder.ts` enforces shape via the
 * type system. This validator is the wire-arrival check: it runs
 * over already-normalised clauses, defending against raw-`fetch`
 * callers who bypass the typed seam and submit arbitrary JSON.
 *
 * Companion modules: `./matches.ts` (evaluator), `./merge.ts`
 * (AND-merge). Shared helpers live in `./_internals.ts`.
 */

import { BaerlyError } from "../errors.ts";

import { assertWireSatisfiable } from "./satisfiable.ts";
import type { PredicateClause, PredicateOpName, PredicateWire } from "./wire.ts";

const OP_NAMES: ReadonlyArray<PredicateOpName> = ["eq", "gt", "gte", "lt", "lte", "in"];
const RANGE_OPS: ReadonlyArray<PredicateOpName> = ["gt", "gte", "lt", "lte"];

/**
 * Validate a normalised predicate wire. Throws
 * `BaerlyError{code:"InvalidConfig"}` on a structurally bad clause,
 * or `BaerlyError{code:"UnsatisfiablePredicate"}` when a clause
 * group on one field contradicts itself.
 *
 * Returns the wire unchanged on success — callers can thread the
 * validated wire forward.
 *
 * @example
 * ```ts
 * validateWire({ clauses: [{ op: "eq", field: "status", value: "open" }] }); // ok
 * validateWire({ clauses: [{ op: "in", field: "priority", value: [] }] }); // throws UnsatisfiablePredicate
 * validateWire({ clauses: [{ op: "eq", field: "_id", value: "x" }] }); // throws InvalidConfig (top-level _id)
 * ```
 */
export const validateWire = (wire: PredicateWire): PredicateWire => {
  if (
    wire === null ||
    typeof wire !== "object" ||
    !Array.isArray((wire as { clauses?: unknown }).clauses)
  ) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate wire must be an object with a "clauses" array.`,
    );
  }
  for (let i = 0; i < wire.clauses.length; i++) {
    validateClause(wire.clauses[i]!, i);
  }
  assertWireSatisfiable(wire);
  return wire;
};

const validateClause = (clause: PredicateClause, index: number): void => {
  if (clause === null || typeof clause !== "object") {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate clause at index ${index} must be an object — got ${JSON.stringify(clause)}.`,
    );
  }
  const { op, field, value } = clause;
  if (typeof op !== "string" || !(OP_NAMES as ReadonlyArray<string>).includes(op)) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate clause at index ${index} has unsupported op ${JSON.stringify(op)} — supported: ${OP_NAMES.join(" / ")}.`,
    );
  }
  if (typeof field !== "string" || field.length === 0) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate clause at index ${index} has empty / non-string field.`,
    );
  }
  // Reject `_id` AND any nested `_id.<path>` — `Path<T>` excludes both
  // (`"_id" | \`_id.${string}\``), so a raw-wire caller (the threat this
  // validator names) must not slip a dotted `_id.x` past a check that
  // only matched the exact root field.
  if (field === "_id" || field.startsWith("_id.")) {
    throw new BaerlyError(
      "InvalidConfig",
      'Predicates may not key on "_id"; use .get(id) / .update(id, patch) / .replace(id, doc) / .delete(id) instead.',
    );
  }
  if (op === "in") {
    if (!Array.isArray(value)) {
      throw new BaerlyError(
        "InvalidConfig",
        `Predicate clause at index ${index} (op="in", field=${JSON.stringify(field)}) must carry an array value.`,
      );
    }
    if (value.length === 0) {
      throw new BaerlyError(
        "UnsatisfiablePredicate",
        `Predicate clause at index ${index} (op="in", field=${JSON.stringify(field)}) has empty value array — no document can match.`,
      );
    }
    for (let i = 0; i < value.length; i++) {
      validateMemberValue(value[i], field, index, i);
    }
    return;
  }
  if (Array.isArray(value)) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate clause at index ${index} (op=${JSON.stringify(op)}, field=${JSON.stringify(field)}) must carry a primitive value, got an array — only op="in" accepts arrays.`,
    );
  }
  if ((RANGE_OPS as ReadonlyArray<string>).includes(op)) {
    validateRangeBound(value, field, index);
    return;
  }
  validateScalar(value, field, index);
};

const validateMemberValue = (
  value: unknown,
  field: string,
  clauseIndex: number,
  memberIndex: number,
): void => {
  if (value === null || value === undefined) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate clause at index ${clauseIndex} (op="in", field=${JSON.stringify(field)}) member ${memberIndex} is ${value === null ? "null" : "undefined"} — members must be string / number / boolean / nested object.`,
    );
  }
  if (Array.isArray(value)) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate clause at index ${clauseIndex} (op="in", field=${JSON.stringify(field)}) member ${memberIndex} is an array — members must be string / number / boolean / nested object.`,
    );
  }
  const t = typeof value;
  if (t === "object") {
    return;
  }
  if (t !== "string" && t !== "number" && t !== "boolean") {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate clause at index ${clauseIndex} (op="in", field=${JSON.stringify(field)}) member ${memberIndex} has unsupported type ${JSON.stringify(t)} — must be string / number / boolean / nested object.`,
    );
  }
  if (t === "number" && !Number.isFinite(value as number)) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate clause at index ${clauseIndex} (op="in", field=${JSON.stringify(field)}) member ${memberIndex} is ${String(value)} — finite numbers only (NaN / Infinity do not round-trip through JSON).`,
    );
  }
};

const validateScalar = (value: unknown, field: string, clauseIndex: number): void => {
  if (value === null || value === undefined) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate clause at index ${clauseIndex} (field=${JSON.stringify(field)}) value is ${value === null ? "null" : "undefined"} — terminal values must be string / number / boolean / nested object.`,
    );
  }
  const t = typeof value;
  if (t === "object") {
    // Equality clauses against nested objects survive only via callback
    // form (the normaliser flattens object-form sub-predicates to
    // dotted-path eq clauses). Keep the structural recursion light —
    // values are sealed from the typed seam.
    return;
  }
  if (t !== "string" && t !== "number" && t !== "boolean") {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate clause at index ${clauseIndex} (field=${JSON.stringify(field)}) value has unsupported type ${JSON.stringify(t)} — must be string / number / boolean / nested object.`,
    );
  }
  if (t === "number" && !Number.isFinite(value as number)) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate clause at index ${clauseIndex} (field=${JSON.stringify(field)}) value is ${String(value)} — finite numbers only (NaN / Infinity do not round-trip through JSON).`,
    );
  }
};

const validateRangeBound = (value: unknown, field: string, clauseIndex: number): void => {
  if (value === null || value === undefined) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate range bound at clause ${clauseIndex} (field=${JSON.stringify(field)}) is ${value === null ? "null" : "undefined"} — range bounds must be string or finite number.`,
    );
  }
  const t = typeof value;
  if (t === "boolean") {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate range bound at clause ${clauseIndex} (field=${JSON.stringify(field)}) is a boolean — range bounds must be string or finite number (booleans are not ordered).`,
    );
  }
  if (t === "object") {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate range bound at clause ${clauseIndex} (field=${JSON.stringify(field)}) is a nested object — range bounds must be string or finite number.`,
    );
  }
  if (t !== "string" && t !== "number") {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate range bound at clause ${clauseIndex} (field=${JSON.stringify(field)}) has unsupported type ${JSON.stringify(t)} — must be string or finite number.`,
    );
  }
  if (t === "number" && !Number.isFinite(value as number)) {
    throw new BaerlyError(
      "InvalidConfig",
      `Predicate range bound at clause ${clauseIndex} (field=${JSON.stringify(field)}) is ${String(value)} — finite numbers only (NaN / Infinity do not round-trip through JSON).`,
    );
  }
};
