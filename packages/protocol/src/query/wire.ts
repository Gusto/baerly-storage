/**
 * Wire-format predicate types. A predicate normalises to a flat list
 * of {@link PredicateClause} records; the server, client, matcher,
 * merger, and validator all consume the wire form. Object-literal
 * (`Predicate<T>`) and callback (`PredicateBuilder<T>`) forms compile
 * to this shape via `./normalize.ts` / `./builder.ts`.
 */

import type { DocumentValue } from "../json.ts";

/**
 * Runtime mirror of {@link PredicateOpName}. The type derives from this
 * tuple so the value is the single source of truth: the spec generator
 * and the drift gate enumerate `PREDICATE_OPS`, and tsgo rejects any
 * member added to the type-union without a matching tuple entry.
 */
export const PREDICATE_OPS = ["eq", "gt", "gte", "lt", "lte", "in"] as const;

/**
 * Locked operator vocabulary. Methods on {@link PredicateBuilder}
 * map 1:1 to these names; the validator rejects any other.
 *
 * `eq` — strict equality.
 * `gt` / `gte` / `lt` / `lte` — scalar range. Bounds must be `string`
 *   or finite `number`. Type-mismatched actuals are always-miss.
 * `in` — set membership. Empty array → `UnsatisfiablePredicate`.
 */
export type PredicateOpName = (typeof PREDICATE_OPS)[number];

/**
 * One clause in a normalised predicate. `field` is a top-level key
 * or a dotted path. `value` is an array iff `op === "in"`.
 *
 * `op: "eq"` on a primitive `value` is plain equality. The
 * normaliser flattens nested literal sub-predicates
 * (`{ assignee: { team: "x" } }`) to dotted-path `eq` clauses
 * (`{op:"eq", field:"assignee.team", value:"x"}`), so an `eq`
 * value at the wire level is never a nested non-primitive object
 * — only callback-form `q.eq("nested", { ... })` could produce
 * one, and that requires the type system to allow it at the call
 * site.
 */
export interface PredicateClause {
  readonly op: PredicateOpName;
  readonly field: string;
  readonly value: DocumentValue | ReadonlyArray<DocumentValue>;
}

/**
 * Normalised predicate envelope. The wire form is a flat list of
 * clauses; multiple clauses across all fields AND together. The
 * empty wire `{ clauses: [] }` matches every document.
 *
 * Wire mirror on the HTTP surface: `?where=` carries the JSON
 * encoding of this object. See `packages/server/API.md` for the
 * literal example.
 */
export interface PredicateWire {
  readonly clauses: ReadonlyArray<PredicateClause>;
}

/** @internal Empty match-all wire — re-used to avoid re-allocating. */
export const EMPTY_PREDICATE_WIRE: PredicateWire = { clauses: [] };
