/**
 * Wire-predicate → SQL `WHERE` clause translation.
 *
 * Pure function. The translator consumes a validated
 * {@link PredicateWire} — the same shape the read path uses — and
 * an {@link ExportPlan} (from `./plan.ts`), and emits a SQL fragment
 * matched against the plan's columns.
 *
 * Three classes of clause:
 *
 *   1. Flat column, top-level field → direct comparator
 *      (`"status" = 'open'`, `"priority" > 5`).
 *   2. JSON-encoded column → JSON-path operators (Postgres `->`/`->>`
 *      chains; SQLite/D1 `json_extract(…, '$.…')`).
 *   3. Unmatchable clause (dotted path against a flat column, or a
 *      field naming an unknown column) → `1 = 0` plus a hint the CLI
 *      surfaces as a `-- TODO(baerly export):` comment above the
 *      emitted statement.
 *
 * Dynamic predicates are invisible at runtime — we see the
 * materialised wire, not the source expression. Callers that know
 * they constructed the wire dynamically can pass
 * `options.dynamicHint` to surface an operator-supplied note.
 */

import {
  BaerlyError,
  type DocumentValue,
  type PredicateClause,
  type PredicateWire,
  validateWire,
} from "@baerly/protocol";
import { quoteValue } from "./sql-escape.ts";
import type { ColumnPlan, ExportPlan, SqlTarget } from "./types.ts";

export interface WhereTranslation {
  /** SQL fragment without the leading `WHERE`. Empty when no predicate. */
  readonly sql: string;
  /**
   * Hand-edit hints for the operator. One entry per non-matchable
   * clause (§3.6) or per dynamically-constructed sub-clause flagged
   * by the caller. The CLI surfaces these as `-- TODO(baerly export): …`
   * comments above the emitted statement.
   */
  readonly hints: readonly string[];
}

/**
 * Translate a validated {@link PredicateWire} into a SQL WHERE-clause
 * fragment matched against the plan's columns. The first argument
 * must already have been validated by {@link validateWire} — the
 * function re-validates defensively but the caller's invariant
 * matters for error-message provenance.
 *
 * Pure function. No I/O. Same wire + plan + target → same SQL string.
 *
 * @throws BaerlyError code="InvalidConfig" — wire fails
 *   {@link validateWire}; same shape `Query<T>.where` already
 *   surfaces.
 */
export const translatePredicateWireToSql = (
  wire: PredicateWire,
  plan: ExportPlan,
  options?: { readonly dynamicHint?: string },
): WhereTranslation => {
  validateWire(wire);
  const hints: string[] = [];
  if (options?.dynamicHint !== undefined && options.dynamicHint.length > 0) {
    hints.push(
      `caller-flagged dynamic predicate: ${options.dynamicHint}. Review the emitted SQL for completeness.`,
    );
  }
  const clauses: string[] = [];
  for (const clause of wire.clauses) {
    clauses.push(...clauseForWire(clause, plan, hints));
  }
  return {
    sql: clauses.length === 0 ? "" : clauses.join(" AND "),
    hints,
  };
};

const clauseForWire = (clause: PredicateClause, plan: ExportPlan, hints: string[]): string[] => {
  const segments = clause.field.includes(".") ? clause.field.split(".") : [clause.field];
  const head = segments[0];
  if (head === undefined || head.length === 0) {
    throw new BaerlyError(
      "InvalidConfig",
      "translatePredicateWireToSql: empty field path encountered (defensive)",
    );
  }
  const col = plan.columns.find((c) => c.source === head);
  if (col === undefined) {
    hints.push(
      `predicate field ${JSON.stringify(clause.field)} references a key never observed in the snapshot; this clause cannot match.`,
    );
    return ["1 = 0"];
  }
  // §3.2 — flat column, top-level field → direct comparator.
  if (!col.jsonEncoded && segments.length === 1) {
    return [flatColumnClause(col.identifier, clause, plan.target)];
  }
  // §3.6 — flat column, dotted path → unmatchable.
  if (!col.jsonEncoded && segments.length > 1) {
    hints.push(
      `predicate path ${JSON.stringify(clause.field)} addresses a flat column; this clause cannot match. Hand-edit if intended.`,
    );
    return ["1 = 0"];
  }
  // §3.3 — JSON column, top-level field.
  if (col.jsonEncoded && segments.length === 1) {
    return [jsonColumnRootClause(col, clause, plan.target)];
  }
  // §3.4 / §3.5 — JSON column, dotted path.
  return [jsonPathClause(col, segments.slice(1), clause, plan.target)];
};

const flatColumnClause = (
  identifier: string,
  clause: PredicateClause,
  target: SqlTarget,
): string => {
  switch (clause.op) {
    case "eq": {
      return `${identifier} = ${quoteLeaf(clause.value as DocumentValue, target)}`;
    }
    case "gt": {
      return `${identifier} > ${quoteLeaf(clause.value as DocumentValue, target)}`;
    }
    case "gte": {
      return `${identifier} >= ${quoteLeaf(clause.value as DocumentValue, target)}`;
    }
    case "lt": {
      return `${identifier} < ${quoteLeaf(clause.value as DocumentValue, target)}`;
    }
    case "lte": {
      return `${identifier} <= ${quoteLeaf(clause.value as DocumentValue, target)}`;
    }
    case "in": {
      return `${identifier} IN (${(clause.value as ReadonlyArray<DocumentValue>)
        .map((v) => quoteLeaf(v, target))
        .join(", ")})`;
    }
  }
};

const jsonColumnRootClause = (
  col: ColumnPlan,
  clause: PredicateClause,
  target: SqlTarget,
): string => {
  // The root JSON column stores the value as JSON-encoded text;
  // we compare against the JSON encoding of the predicate value.
  // Range and `in` ops on a JSON-encoded root column compare the
  // JSON text lexicographically, which is rarely what the caller
  // wanted — for those, the operator is expected to promote the
  // field into a flat column or hand-edit the emitted SQL.
  if (clause.op === "eq") {
    const literal = JSON.stringify(clause.value);
    if (target === "postgres") {
      return `${col.identifier}::text = ${quoteValue(literal, target)}`;
    }
    return `${col.identifier} = ${quoteValue(literal, target)}`;
  }
  if (clause.op === "in") {
    const literals = (clause.value as ReadonlyArray<DocumentValue>).map((v) =>
      quoteValue(JSON.stringify(v), target),
    );
    if (target === "postgres") {
      return `${col.identifier}::text IN (${literals.join(", ")})`;
    }
    return `${col.identifier} IN (${literals.join(", ")})`;
  }
  // Range against JSON-encoded root: fall back to a lex compare on
  // the JSON serialisation. Surface a comment via the SQL itself;
  // the operator can hand-edit.
  const comparator = rangeComparator(clause.op);
  const literal = JSON.stringify(clause.value);
  if (target === "postgres") {
    return `${col.identifier}::text ${comparator} ${quoteValue(literal, target)}`;
  }
  return `${col.identifier} ${comparator} ${quoteValue(literal, target)}`;
};

const jsonPathClause = (
  col: ColumnPlan,
  tail: readonly string[],
  clause: PredicateClause,
  target: SqlTarget,
): string => {
  const accessor = jsonPathAccessor(col.identifier, tail, target);
  switch (clause.op) {
    case "eq": {
      return `${accessor} = ${quoteLeaf(clause.value as DocumentValue, target)}`;
    }
    case "gt": {
      return `${accessor} > ${quoteLeaf(clause.value as DocumentValue, target)}`;
    }
    case "gte": {
      return `${accessor} >= ${quoteLeaf(clause.value as DocumentValue, target)}`;
    }
    case "lt": {
      return `${accessor} < ${quoteLeaf(clause.value as DocumentValue, target)}`;
    }
    case "lte": {
      return `${accessor} <= ${quoteLeaf(clause.value as DocumentValue, target)}`;
    }
    case "in": {
      return `${accessor} IN (${(clause.value as ReadonlyArray<DocumentValue>)
        .map((v) => quoteLeaf(v, target))
        .join(", ")})`;
    }
  }
};

const rangeComparator = (op: PredicateClause["op"]): string => {
  if (op === "gt") {
    return ">";
  }
  if (op === "gte") {
    return ">=";
  }
  if (op === "lt") {
    return "<";
  }
  return "<=";
};

const jsonPathAccessor = (
  identifier: string,
  tail: readonly string[],
  target: SqlTarget,
): string => {
  if (target === "postgres") {
    let expr = identifier;
    for (let i = 0; i < tail.length; i++) {
      const seg = tail[i]!;
      const isLast = i === tail.length - 1;
      const key = `'${seg.replace(/'/g, "''")}'`;
      expr = `${expr}${isLast ? "->>" : "->"}${key}`;
    }
    return expr;
  }
  const jsonPath = `'$.${tail.map((s) => s.replace(/'/g, "''")).join(".")}'`;
  return `json_extract(${identifier}, ${jsonPath})`;
};

/**
 * Quote a leaf primitive for use as the right-hand side of a
 * comparison. Booleans branch on target. Nested objects must never
 * reach here — wire `eq` clauses on nested objects can only come
 * from the callback form `q.eq("nested", { ... })`, which the
 * export translator does not support today.
 */
const quoteLeaf = (value: DocumentValue, target: SqlTarget): string => {
  if (typeof value === "object") {
    throw new BaerlyError(
      "InvalidConfig",
      "translatePredicateWireToSql: nested object reached leaf quoter — callback-form q.eq(field, object) is not supported for SQL export. Hand-edit the emitted SQL.",
    );
  }
  return quoteValue(value, target);
};
