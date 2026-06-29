/**
 * Callback-form predicate DSL. `q.eq("status", "open").gt("priority",
 * 5)` builds a {@link PredicateWire} via methods on the
 * {@link PredicateBuilder} handle. Each method appends one
 * {@link PredicateClause} to a private list and returns the same
 * handle for chaining.
 *
 * Why a builder, not imported helpers? The methods that exist on
 * the type ARE the supported vocabulary — there is no
 * "what we don't support" page to maintain. The agent cannot call
 * `q.regex(...)` because there is no `regex` method; the compiler
 * surfaces the error before the request is sent.
 *
 * Companion modules: `./normalize.ts` (object → wire),
 * `./wire.ts` (wire types).
 */

import type { DocumentData, DocumentValue } from "../json.ts";
import type { Path, PathValue, Predicate } from "../collection-api.ts";

import type { PredicateClause, PredicateWire } from "./wire.ts";

/**
 * Callback-form predicate builder. Methods append clauses and
 * return the same builder for chaining; chained calls AND-merge.
 *
 * The methods on this interface ARE the supported operator surface.
 * Vocabulary additions (`or`, `not`, `regex`, `ne`, `exists`, ...)
 * are intentionally absent — calling them is a TS2339 compile
 * error, not a runtime rejection. The algebra is conjunction-only in
 * perpetuity — see the API surface lock in
 * docs/contributing/conventions/change-discipline.md.
 *
 * @template T - the document shape the predicate is keyed against.
 */
export interface PredicateBuilder<T extends DocumentData = DocumentData> {
  /**
   * Strict equality on `field`. Use this for the in-callback
   * equality clauses that the object-form would also support;
   * mixing `q.eq(...)` with range / `in` clauses in one call is
   * the canonical "mixed equality + range" pattern.
   */
  eq<K extends Path<T>>(field: K, value: PathValue<T, K>): PredicateBuilder<T>;

  /**
   * Strict greater. `value` must be `string` or `number`; the
   * intersection at the type level rejects `boolean` / `null`
   * fields at the call site (`q.gt("done", true)` is a TS error
   * on a `done: boolean` field).
   */
  gt<K extends Path<T>>(field: K, value: PathValue<T, K> & (string | number)): PredicateBuilder<T>;

  /** Inclusive greater. See {@link gt} for the value-type constraint. */
  gte<K extends Path<T>>(field: K, value: PathValue<T, K> & (string | number)): PredicateBuilder<T>;

  /** Strict less. See {@link gt} for the value-type constraint. */
  lt<K extends Path<T>>(field: K, value: PathValue<T, K> & (string | number)): PredicateBuilder<T>;

  /** Inclusive less. See {@link gt} for the value-type constraint. */
  lte<K extends Path<T>>(field: K, value: PathValue<T, K> & (string | number)): PredicateBuilder<T>;

  /**
   * Set membership. Empty array is `UnsatisfiablePredicate` at
   * normalise time — the validator emits the error eagerly so the
   * caller sees it at the `.where(...)` call site, not later.
   */
  in<K extends Path<T>>(field: K, values: ReadonlyArray<PathValue<T, K>>): PredicateBuilder<T>;
}

/**
 * Argument shape accepted by `.where(...)`. Either the object-literal
 * equality form ({@link Predicate}) or a callback that drives a
 * {@link PredicateBuilder} and returns it (the chain terminator).
 */
export type PredicateArg<T extends DocumentData> =
  | Predicate<T>
  | ((q: PredicateBuilder<T>) => PredicateBuilder<T>);

/**
 * Build a fresh `PredicateBuilder<T>` along with the clause-list
 * cell it appends to. Internal — `./normalize.ts` drives this.
 *
 * @internal
 */
export const makeBuilder = <T extends DocumentData>(): {
  builder: PredicateBuilder<T>;
  clauses: PredicateClause[];
} => {
  const clauses: PredicateClause[] = [];
  const push = (clause: PredicateClause): PredicateBuilder<T> => {
    clauses.push(clause);
    return builder;
  };
  const builder: PredicateBuilder<T> = {
    eq: (field, value) => push({ op: "eq", field: String(field), value: value as DocumentValue }),
    gt: (field, value) => push({ op: "gt", field: String(field), value: value as DocumentValue }),
    gte: (field, value) => push({ op: "gte", field: String(field), value: value as DocumentValue }),
    lt: (field, value) => push({ op: "lt", field: String(field), value: value as DocumentValue }),
    lte: (field, value) => push({ op: "lte", field: String(field), value: value as DocumentValue }),
    in: (field, values) =>
      push({
        op: "in",
        field: String(field),
        value: [...(values as ReadonlyArray<DocumentValue>)],
      }),
  };
  return { builder, clauses };
};

/**
 * Tighter wire-form type after running through the builder helper —
 * not part of the public surface; `./normalize.ts` returns a plain
 * {@link PredicateWire}.
 *
 * @internal
 */
export const wireFromBuilder = <T extends DocumentData>(
  cb: (q: PredicateBuilder<T>) => PredicateBuilder<T>,
): PredicateWire => {
  const { builder, clauses } = makeBuilder<T>();
  cb(builder);
  return { clauses };
};
