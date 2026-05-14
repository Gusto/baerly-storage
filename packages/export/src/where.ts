/**
 * Predicate AST → SQL `WHERE` clause translation.
 *
 * Pure function. The translator consumes a (validated) `Predicate<T>`
 * — the same AST `Table<T>.where(...)` already validates on the read
 * path — and an {@link ExportPlan} (from `./plan.ts`), and emits a
 * SQL fragment matched against the plan's columns.
 *
 * Three classes of clause:
 *
 *   1. Flat column, top-level predicate key → straight equality
 *      (`"status" = 'open'`).
 *   2. JSON-encoded column → JSON-path operators
 *      (Postgres `->`/`->>` chains; SQLite/D1 `json_extract(…, '$.…')`).
 *   3. Unmatchable clause (dotted path against a flat column, or a
 *      predicate key naming an unknown column) → `1 = 0` plus a
 *      `hints` entry the CLI surfaces as a `-- TODO(baerly export):`
 *      comment above the emitted statement.
 *
 * Spread / function-returned predicates are invisible at runtime —
 * we see the materialised value, not the source expression. Callers
 * that know they constructed a predicate dynamically can pass
 * `options.dynamicHint` to surface an operator-supplied note.
 *
 * Translation rules live in
 * `.claude/research/planning/tickets/72-export-predicate-ast-translation.md`
 * §3; the rule numbers are referenced inline below.
 */

import {
  BaerlyError,
  type JSONArrayless,
  type JSONArraylessObject,
  type Predicate,
  validatePredicate,
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
 * Translate a (validated) `Predicate<T>` into a SQL WHERE-clause
 * fragment matched against the plan's columns. The first argument
 * must already have been validated by
 * {@link validatePredicate} — the function re-validates defensively
 * but the caller's invariant matters for error-message provenance.
 *
 * Pure function. No I/O. Same predicate object + plan + target
 * → same SQL string.
 *
 * @throws BaerlyError code="InvalidConfig" — predicate fails
 *   {@link validatePredicate}; same shape `Query<T>.where` already
 *   surfaces.
 */
export const translatePredicateToSql = (
  predicate: Predicate<JSONArraylessObject>,
  plan: ExportPlan,
  options?: { readonly dynamicHint?: string },
): WhereTranslation => {
  validatePredicate(predicate);
  const hints: string[] = [];
  if (options?.dynamicHint !== undefined && options.dynamicHint.length > 0) {
    hints.push(
      `caller-flagged dynamic predicate: ${options.dynamicHint}. Review the emitted SQL for completeness.`,
    );
  }
  // T1 widened `Predicate<T>` to allow operator-shaped values
  // (`{$eq:…}`, `{$in:[…]}`, etc.). The export translator hasn't
  // been taught operators yet; an operator-shaped leaf falls through
  // the equality-walker and surfaces as a `1 = 0` clause + hint,
  // which is at-worst noisy but never silently wrong. Operator-aware
  // SQL translation is a separate follow-up.
  const clauses = walkPredicate(predicate as JSONArraylessObject, [], plan, hints);
  return {
    sql: clauses.length === 0 ? "" : clauses.join(" AND "),
    hints,
  };
};

const walkPredicate = (
  node: JSONArraylessObject,
  basePath: readonly string[],
  plan: ExportPlan,
  hints: string[],
): string[] => {
  const out: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    // Split dotted-path keys at the boundary; nested objects are
    // walked separately further down.
    const segments = key.includes(".") ? key.split(".") : [key];
    const fullPath = [...basePath, ...segments];
    if (typeof value === "object" && value !== null) {
      // Nested sub-predicate: recurse with the path extended.
      out.push(...walkPredicate(value as JSONArraylessObject, fullPath, plan, hints));
      continue;
    }
    out.push(...clauseForLeaf(fullPath, value, plan, hints));
  }
  return out;
};

const clauseForLeaf = (
  path: readonly string[],
  value: JSONArrayless,
  plan: ExportPlan,
  hints: string[],
): string[] => {
  const head = path[0];
  if (head === undefined) {
    throw new BaerlyError(
      "InvalidConfig",
      "translatePredicateToSql: empty path encountered (defensive)",
    );
  }
  const col = plan.columns.find((c) => c.source === head);
  if (col === undefined) {
    // §3.6 — unknown top-level key. Always-false clause + hint so
    // the operator can see a typo / drift before applying the SQL.
    hints.push(
      `predicate key ${JSON.stringify(path.join("."))} references a field never observed in the snapshot; this clause cannot match.`,
    );
    return ["1 = 0"];
  }
  // §3.2 — flat column, top-level path → direct equality.
  if (!col.jsonEncoded && path.length === 1) {
    return [`${col.identifier} = ${quoteLeaf(value, plan.target)}`];
  }
  // §3.6 — flat column, dotted path → unmatchable. Always-false +
  // hint that names the path so the operator can hand-edit.
  if (!col.jsonEncoded && path.length > 1) {
    hints.push(
      `predicate path ${JSON.stringify(path.join("."))} addresses a flat column; this clause cannot match. Hand-edit if intended.`,
    );
    return ["1 = 0"];
  }
  // §3.3 — JSON column, top-level path → compare to JSON-encoded
  // literal. Mirrors what `rows.ts` writes on insert for promoted
  // columns.
  if (col.jsonEncoded && path.length === 1) {
    const literal = JSON.stringify(value);
    if (plan.target === "postgres") {
      return [`${col.identifier}::text = ${quoteValue(literal, plan.target)}`];
    }
    return [`${col.identifier} = ${quoteValue(literal, plan.target)}`];
  }
  // §3.4 / §3.5 — JSON column, dotted path → JSON-path operator.
  return [emitJsonPathClause(col, path.slice(1), value, plan.target)];
};

/**
 * Emit a JSON-path equality clause against a JSON-encoded column.
 *
 * Postgres uses chained `->` (returns JSON) for intermediate keys
 * and `->>` (returns text) for the final key. SQLite / D1 use
 * `json_extract(col, '$.a.b.c')` with the path joined by dots.
 *
 * Single quotes inside JSON keys are doubled per SQL string literal
 * rules — the JSON-path key is itself an SQL string literal.
 */
const emitJsonPathClause = (
  col: ColumnPlan,
  tail: readonly string[],
  value: JSONArrayless,
  target: SqlTarget,
): string => {
  if (target === "postgres") {
    // The last segment uses `->>` (TEXT). Intermediates use `->` (JSON).
    let expr = col.identifier;
    for (let i = 0; i < tail.length; i++) {
      const seg = tail[i]!;
      const isLast = i === tail.length - 1;
      // Single-quoted SQL string for the JSON key.
      const key = `'${seg.replace(/'/g, "''")}'`;
      expr = `${expr}${isLast ? "->>" : "->"}${key}`;
    }
    return `${expr} = ${quoteLeaf(value, target)}`;
  }
  // sqlite / d1: json_extract("col", '$.a.b.c') = …
  const jsonPath = `'$.${tail.map((s) => s.replace(/'/g, "''")).join(".")}'`;
  return `json_extract(${col.identifier}, ${jsonPath}) = ${quoteLeaf(value, target)}`;
};

/**
 * Quote a leaf primitive for use as the right-hand side of a `=`
 * comparison. Booleans branch on target. Nested objects must never
 * reach here — `walkPredicate` recurses through them before calling
 * `clauseForLeaf`.
 */
const quoteLeaf = (value: JSONArrayless, target: SqlTarget): string => {
  if (typeof value === "object") {
    throw new BaerlyError(
      "InvalidConfig",
      "translatePredicateToSql: nested object reached leaf quoter (defensive)",
    );
  }
  return quoteValue(value, target);
};
