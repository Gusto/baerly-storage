/**
 * Round-trip equivalence: the SQL `WHERE` clause the translator emits
 * must select exactly the rows the in-memory `matches()` evaluator
 * accepts. Because we don't ship a real SQL engine to the unit pool,
 * we run a hand-rolled mini-interpreter that parses the exact grammar
 * the translator emits — and nothing else. If the translator drifts
 * (emits a new operator shape), the interpreter throws and the test
 * fails loudly. That mismatch IS the regression guard.
 *
 * Grammar the interpreter must handle (no more, no less):
 *
 *   clause       := "1 = 0"
 *                 | flatEq
 *                 | jsonPgEq
 *                 | jsonSqliteEq
 *                 | jsonRootPgEq
 *                 | jsonRootSlEq
 *   flatEq       := identifier "=" literal
 *   jsonPgEq     := identifier ("->" stringLit)* "->>" stringLit "=" literal
 *   jsonSqliteEq := "json_extract(" identifier ", " stringLit ") = " literal
 *   jsonRootPgEq := identifier "::text = " stringLit
 *   jsonRootSlEq := identifier " = " stringLit
 *   identifier   := "..." (doubled "" for embedded ")
 *   stringLit    := '...' (doubled '' for embedded ')
 *   literal      := stringLit | "true" | "false" | "1" | "0" | <number>
 */

import { describe, expect, test } from "vitest";
import { matches, type JSONArraylessObject } from "@baerly/protocol";
import { inferPlanForCollection } from "./plan.ts";
import type { ExportPlan, ExportRow } from "./types.ts";
import { translatePredicateToSql } from "./where.ts";

// ---------------------------------------------------------------
// Mini SQL parser / evaluator
// ---------------------------------------------------------------

/** Parse a single-quoted SQL string literal starting at `i`. Returns the
 *  decoded value and the index just past the closing quote. Throws
 *  loudly on malformed input — that's a translator-drift signal. */
const parseStringLit = (sql: string, i: number): [string, number] => {
  if (sql[i] !== "'") {
    throw new Error(`expected ' at ${i} in ${JSON.stringify(sql)}`);
  }
  let j = i + 1;
  let out = "";
  while (j < sql.length) {
    const ch = sql[j]!;
    if (ch === "'") {
      if (sql[j + 1] === "'") {
        out += "'";
        j += 2;
        continue;
      }
      return [out, j + 1];
    }
    out += ch;
    j++;
  }
  throw new Error(`unterminated string literal in ${JSON.stringify(sql)}`);
};

/** Parse a double-quoted SQL identifier starting at `i`. */
const parseIdent = (sql: string, i: number): [string, number] => {
  if (sql[i] !== '"') {
    throw new Error(`expected " at ${i} in ${JSON.stringify(sql)}`);
  }
  let j = i + 1;
  let out = "";
  while (j < sql.length) {
    const ch = sql[j]!;
    if (ch === '"') {
      if (sql[j + 1] === '"') {
        out += '"';
        j += 2;
        continue;
      }
      return [out, j + 1];
    }
    out += ch;
    j++;
  }
  throw new Error(`unterminated identifier in ${JSON.stringify(sql)}`);
};

/** Decoded right-hand-side literal. */
type Literal =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean };

const parseLiteral = (sql: string, i: number): [Literal, number] => {
  if (sql[i] === "'") {
    const [s, next] = parseStringLit(sql, i);
    return [{ kind: "string", value: s }, next];
  }
  // Read everything to end-of-clause.
  const tail = sql.slice(i);
  if (tail === "true") {
    return [{ kind: "boolean", value: true }, sql.length];
  }
  if (tail === "false") {
    return [{ kind: "boolean", value: false }, sql.length];
  }
  // SQLite stores booleans as 1 / 0 but the translator emits "1" / "0"
  // only for booleans. We can't distinguish "boolean 1" from "integer 1"
  // from the SQL alone — but for our purposes both compare to the row's
  // value via the kind-aware equality below. Treat as number.
  const n = Number(tail);
  if (!Number.isNaN(n) && tail.length > 0) {
    return [{ kind: "number", value: n }, sql.length];
  }
  throw new Error(`unparseable literal ${JSON.stringify(tail)}`);
};

/** Look up a (possibly nested) path in a row body. Returns undefined
 *  when traversal hits a missing key. */
const lookupPath = (body: Record<string, unknown>, path: readonly string[]): unknown => {
  let cursor: unknown = body;
  for (const seg of path) {
    if (cursor === null || cursor === undefined || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
};

/** Compare a row value to a parsed literal under the target's value
 *  encoding (passed via `options`; the target dialect itself is not
 *  read here — the caller has already baked dialect-specific encoding
 *  rules into the flags). Returns false on every kind mismatch. */
const matchLiteral = (
  actual: unknown,
  literal: Literal,
  options?: { booleanAsInt?: boolean; jsonEncoded?: boolean },
): boolean => {
  if (options?.jsonEncoded === true) {
    // We're comparing against a JSON-encoded literal (§3.3). The row
    // value, when present, is whatever shape it has; the SQL has the
    // JSON-encoded form. Compare by JSON-stringifying the actual.
    if (actual === undefined || actual === null) {
      return false;
    }
    if (literal.kind !== "string") {
      return false;
    }
    return JSON.stringify(actual) === literal.value;
  }
  if (literal.kind === "string") {
    return typeof actual === "string" && actual === literal.value;
  }
  if (literal.kind === "boolean") {
    return typeof actual === "boolean" && actual === literal.value;
  }
  // number
  if (options?.booleanAsInt === true) {
    // SQLite / D1 encode booleans as 1 / 0. The translator emits "1"
    // for true and "0" for false; we accept either a boolean row
    // value (matching the encoded int) or an actual integer.
    if (typeof actual === "boolean") {
      return (actual ? 1 : 0) === literal.value;
    }
  }
  return typeof actual === "number" && actual === literal.value;
};

/** Evaluate one parsed clause against one row body. */
const evalClause = (clause: string, body: Record<string, unknown>, plan: ExportPlan): boolean => {
  if (clause === "1 = 0") {
    return false;
  }
  // Three top-level shapes share a leading identifier OR the literal
  // `json_extract(`. Dispatch on the first character.
  if (clause.startsWith("json_extract(")) {
    // json_extract("col", '$.a.b.c') = <literal>
    const after = "json_extract(".length;
    const [col, j1] = parseIdent(clause, after);
    if (clause.slice(j1, j1 + 2) !== ", ") {
      throw new Error(`bad json_extract: ${clause}`);
    }
    const [path, j2] = parseStringLit(clause, j1 + 2);
    if (clause.slice(j2, j2 + 4) !== ") = ") {
      throw new Error(`bad json_extract: ${clause}`);
    }
    const [lit] = parseLiteral(clause, j2 + 4);
    if (!path.startsWith("$.")) {
      throw new Error(`bad json_extract path: ${path}`);
    }
    const segments = path.slice(2).split(".");
    const actual = lookupPath(body, [col, ...segments]);
    const colPlan = plan.columns.find((c) => c.source === col);
    return matchLiteral(actual, lit, {
      booleanAsInt: plan.target !== "postgres",
      jsonEncoded: colPlan?.jsonEncoded === true && segments.length === 0,
    });
  }
  // All other clauses start with an identifier.
  if (clause[0] !== '"') {
    throw new Error(`unrecognised clause shape: ${clause}`);
  }
  const [col, j1] = parseIdent(clause, 0);

  // Postgres root JSON: "col"::text = '...'
  if (clause.slice(j1, j1 + 9) === "::text = ") {
    const [lit] = parseLiteral(clause, j1 + 9);
    const actual = body[col];
    return matchLiteral(actual, lit, { jsonEncoded: true });
  }

  // Postgres JSON path: "col"->'k1'->'k2'->>'kN' = <literal>
  if (clause.slice(j1, j1 + 2) === "->") {
    // Walk -> / ->> tokens.
    let cursor = j1;
    const segments: string[] = [];
    let isLastTextual = false;
    while (clause.slice(cursor, cursor + 2) === "->") {
      const op = clause.slice(cursor, cursor + 3) === "->>" ? "->>" : "->";
      cursor += op.length;
      const [seg, next] = parseStringLit(clause, cursor);
      segments.push(seg);
      cursor = next;
      isLastTextual = op === "->>";
    }
    if (!isLastTextual) {
      throw new Error(`postgres JSON path must end with ->>: ${clause}`);
    }
    if (clause.slice(cursor, cursor + 3) !== " = ") {
      throw new Error(`bad postgres JSON path tail: ${clause}`);
    }
    const [lit] = parseLiteral(clause, cursor + 3);
    const actual = lookupPath(body, [col, ...segments]);
    return matchLiteral(actual, lit);
  }

  // Flat equality: "col" = <literal> (no JSON ops).
  if (clause.slice(j1, j1 + 3) !== " = ") {
    throw new Error(`unrecognised clause tail: ${clause.slice(j1)} in ${clause}`);
  }
  const [lit] = parseLiteral(clause, j1 + 3);
  const actual = body[col];
  const colPlan = plan.columns.find((c) => c.source === col);
  return matchLiteral(actual, lit, {
    booleanAsInt: plan.target !== "postgres",
    // SQLite top-level JSON-encoded comparison reaches here too:
    //   "col" = '"value"' — same shape as a flat string equality but
    //   the comparison must be against JSON.stringify(actual).
    jsonEncoded: colPlan?.jsonEncoded === true,
  });
};

const evaluateSql = (
  whereSql: string,
  body: Record<string, unknown>,
  plan: ExportPlan,
): boolean => {
  if (whereSql === "") {
    return true;
  }
  const clauses = whereSql.split(" AND ");
  for (const clause of clauses) {
    if (!evalClause(clause, body, plan)) {
      return false;
    }
  }
  return true;
};

// ---------------------------------------------------------------
// Fixture-driven equivalence
// ---------------------------------------------------------------

const mapOf = (rec: Record<string, JSONArraylessObject>): ReadonlyMap<string, ExportRow> => {
  const m = new Map<string, ExportRow>();
  for (const [k, v] of Object.entries(rec)) {
    m.set(k, v);
  }
  return m;
};

interface Fixture {
  readonly name: string;
  readonly rows: ReadonlyMap<string, ExportRow>;
  readonly cases: ReadonlyArray<{
    readonly predicate: JSONArraylessObject;
    readonly expect: readonly string[];
  }>;
}

const FIXTURES: readonly Fixture[] = [
  {
    name: "flat string column",
    rows: mapOf({
      a: { status: "open" } as JSONArraylessObject,
      b: { status: "closed" } as JSONArraylessObject,
      c: { status: "open" } as JSONArraylessObject,
    }),
    cases: [
      { predicate: {}, expect: ["a", "b", "c"] },
      { predicate: { status: "open" }, expect: ["a", "c"] },
      { predicate: { status: "closed" }, expect: ["b"] },
      { predicate: { status: "missing" }, expect: [] },
      { predicate: { ghost: "x" }, expect: [] },
    ],
  },
  {
    name: "JSON column — dotted path + sub-predicate equivalence",
    rows: mapOf({
      a: { assignee: { team: "platform" } } as JSONArraylessObject,
      b: { assignee: { team: "ops" } } as JSONArraylessObject,
      c: { assignee: { team: "platform", oncall: "alice" } } as JSONArraylessObject,
    }),
    cases: [
      { predicate: { "assignee.team": "platform" }, expect: ["a", "c"] },
      { predicate: { assignee: { team: "platform" } }, expect: ["a", "c"] },
      {
        predicate: { assignee: { team: "platform", oncall: "alice" } },
        expect: ["c"],
      },
      { predicate: { "assignee.team": "ops" }, expect: ["b"] },
    ],
  },
  {
    name: "multi-key flat predicates",
    rows: mapOf({
      a: { status: "open", priority: 1 } as JSONArraylessObject,
      b: { status: "open", priority: 2 } as JSONArraylessObject,
      c: { status: "closed", priority: 1 } as JSONArraylessObject,
    }),
    cases: [
      { predicate: { status: "open", priority: 1 }, expect: ["a"] },
      { predicate: { status: "open" }, expect: ["a", "b"] },
      { predicate: { priority: 1 }, expect: ["a", "c"] },
    ],
  },
  {
    name: "flat boolean column",
    rows: mapOf({
      a: { deleted: false } as JSONArraylessObject,
      b: { deleted: true } as JSONArraylessObject,
    }),
    cases: [
      { predicate: { deleted: true }, expect: ["b"] },
      { predicate: { deleted: false }, expect: ["a"] },
    ],
  },
  {
    name: "two-level JSON path",
    rows: mapOf({
      a: { meta: { inner: { kind: "alpha" } } } as JSONArraylessObject,
      b: { meta: { inner: { kind: "beta" } } } as JSONArraylessObject,
    }),
    cases: [
      { predicate: { "meta.inner.kind": "alpha" }, expect: ["a"] },
      { predicate: { meta: { inner: { kind: "beta" } } }, expect: ["b"] },
    ],
  },
];

describe.each(["postgres", "sqlite", "d1"] as const)(
  "translator equivalence with matches() — target=%s",
  (target) => {
    for (const fixture of FIXTURES) {
      const plan = inferPlanForCollection({ rows: fixture.rows, target, table: "t" });
      for (const { predicate, expect: expectedIds } of fixture.cases) {
        test(`${fixture.name} | predicate ${JSON.stringify(predicate)} → [${expectedIds.join(",")}]`, () => {
          // 1. matches() reference set.
          const matchedByMatches: string[] = [];
          for (const [id, body] of fixture.rows) {
            // The in-memory matcher needs a JSONObject; include _id for
            // completeness (the SQL evaluator's body map mirrors the
            // same shape — `_id` lives on the row separately, but
            // matches() doesn't care).
            if (matches(predicate, body as JSONArraylessObject)) {
              matchedByMatches.push(id);
            }
          }
          expect(matchedByMatches.toSorted()).toEqual([...expectedIds].toSorted());

          // 2. Translator + mini-evaluator set.
          const { sql } = translatePredicateToSql(predicate, plan);
          const matchedBySql: string[] = [];
          for (const [id, body] of fixture.rows) {
            if (evaluateSql(sql, body as unknown as Record<string, unknown>, plan)) {
              matchedBySql.push(id);
            }
          }
          expect(matchedBySql.toSorted()).toEqual([...expectedIds].toSorted());
        });
      }
    }
  },
);
