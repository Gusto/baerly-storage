/**
 * Filtered-index implication checker — decides whether every
 * document accepted by a query predicate is also accepted by a
 * filtered index's predicate. The query planner uses the result to
 * rank candidate indexes; see {@link "./query-planner.ts".planQuery}.
 *
 * Pure-function module: no I/O, no `Db` / `Storage` imports. Lives
 * in `@baerly/server` (not in `@baerly/protocol`) because the
 * planner is the only caller.
 *
 * Operates on the wire form: both inputs are {@link PredicateWire}s
 * with clauses already grouped by `(op, field, value)`. The
 * normaliser at `@baerly/protocol`'s `./query/normalize.ts` has
 * already flattened nested literal sub-predicates into dotted-path
 * `eq` clauses, so there is no recursion on nested objects here.
 */

import {
  deepEqualDocumentValue,
  type DocumentValue,
  type PredicateClause,
  type PredicateWire,
} from "@baerly/protocol";

/**
 * One side of a range bound extracted from a clause group. The
 * `inclusive` flag distinguishes `gte` / `lte` (inclusive) from
 * `gt` / `lt` (exclusive). Private to {@link predicateImplies}.
 */
interface RangeInfo {
  readonly value: DocumentValue;
  readonly inclusive: boolean;
}

/**
 * Normalised view of one field's clause group. A field may carry an
 * `eq` clause, range bounds (`lo` / `hi`), and/or an `in` clause.
 * Multiple clauses on one field AND together; the validator has
 * already proved the group is internally consistent. An "unknown
 * shape" sentinel surfaces when the planner can't safely reason
 * about the group (e.g. two `in` clauses on one field — the
 * intersection requires set arithmetic we don't do at plan time).
 * Private to {@link predicateImplies}.
 */
interface OperatorBundle {
  readonly eq?: DocumentValue;
  readonly lo?: RangeInfo;
  readonly hi?: RangeInfo;
  readonly in?: ReadonlyArray<DocumentValue>;
}

type DecodeResult = OperatorBundle | "unknown-shape";

/**
 * Group a wire's clauses by `field` so the per-field implication
 * check can reason over one bundle at a time. Inlined small helper
 * (not exported) so the planner module doesn't need to expose its
 * grouping helper as a cross-module contract.
 */
const groupByField = (wire: PredicateWire): Map<string, ReadonlyArray<PredicateClause>> => {
  const groups = new Map<string, PredicateClause[]>();
  for (const clause of wire.clauses) {
    const bucket = groups.get(clause.field);
    if (bucket === undefined) {
      groups.set(clause.field, [clause]);
    } else {
      bucket.push(clause);
    }
  }
  return groups;
};

/**
 * Collapse a per-field clause list into an {@link OperatorBundle}.
 * Returns `"unknown-shape"` when the group has more than one `in`
 * clause (set-intersection at plan time is out of scope) or
 * unrecognised ops slipping through (defensive — the validator
 * already locked the op vocabulary). Multiple `eq` clauses on one
 * field: the validator proves they all agree, so we pick the first.
 * Multiple range clauses on one field: take the strictest bound
 * (tightest `lo` = numerically largest; tightest `hi` = numerically
 * smallest).
 */
const decodeGroup = (clauses: ReadonlyArray<PredicateClause>): DecodeResult => {
  const bundle: {
    eq?: DocumentValue;
    lo?: RangeInfo;
    hi?: RangeInfo;
    in?: ReadonlyArray<DocumentValue>;
  } = {};
  for (const clause of clauses) {
    const v = clause.value;
    if (clause.op === "eq") {
      // Validator: every eq on a field carries the same value.
      bundle.eq = v as DocumentValue;
    } else if (clause.op === "gte") {
      const next: RangeInfo = { value: v as DocumentValue, inclusive: true };
      bundle.lo = tightestLo(bundle.lo, next);
    } else if (clause.op === "gt") {
      const next: RangeInfo = { value: v as DocumentValue, inclusive: false };
      bundle.lo = tightestLo(bundle.lo, next);
    } else if (clause.op === "lte") {
      const next: RangeInfo = { value: v as DocumentValue, inclusive: true };
      bundle.hi = tightestHi(bundle.hi, next);
    } else if (clause.op === "lt") {
      const next: RangeInfo = { value: v as DocumentValue, inclusive: false };
      bundle.hi = tightestHi(bundle.hi, next);
    } else if (clause.op === "in") {
      if (bundle.in !== undefined) {
        // Multiple `in` clauses on one field: the validator already
        // proved the intersection is non-empty, but reasoning about
        // the intersection's containment at plan time is out of
        // scope — bail out to "unknown-shape" so the caller refuses
        // implication conservatively.
        return "unknown-shape";
      }
      if (!Array.isArray(v)) {
        return "unknown-shape";
      }
      bundle.in = v as ReadonlyArray<DocumentValue>;
    } else {
      return "unknown-shape";
    }
  }
  return bundle;
};

const tightestLo = (existing: RangeInfo | undefined, next: RangeInfo): RangeInfo => {
  if (existing === undefined) {
    return next;
  }
  if (typeof existing.value !== typeof next.value) {
    // Mixed types — bail to existing; the validator already proves
    // the group is satisfiable, so this case is a defensive no-op.
    return existing;
  }
  if (next.value > existing.value) {
    return next;
  }
  if (next.value < existing.value) {
    return existing;
  }
  // Equal value — strictest inclusivity wins (exclusive > inclusive
  // for lo bounds).
  if (!next.inclusive && existing.inclusive) {
    return next;
  }
  return existing;
};

const tightestHi = (existing: RangeInfo | undefined, next: RangeInfo): RangeInfo => {
  if (existing === undefined) {
    return next;
  }
  if (typeof existing.value !== typeof next.value) {
    return existing;
  }
  if (next.value < existing.value) {
    return next;
  }
  if (next.value > existing.value) {
    return existing;
  }
  if (!next.inclusive && existing.inclusive) {
    return next;
  }
  return existing;
};

/**
 * Does the query's lower bound `loQ` (`undefined` if none) prove that
 * every matching doc satisfies the filter's lower bound `loF`?
 *
 * `loF.inclusive` true → need doc ≥ loF.value; `loF.inclusive` false →
 * need doc > loF.value. A stricter `loQ` (numerically larger or with
 * tighter inclusivity) always implies a looser `loF`.
 */
const lowerBoundImplies = (loF: RangeInfo, loQ: RangeInfo | undefined): boolean => {
  if (loQ === undefined) {
    return false;
  }
  // Mixed types: comparison is `false` either way; refuse implication.
  if (typeof loF.value !== typeof loQ.value) {
    return false;
  }
  if (loQ.value > loF.value) {
    return true;
  }
  if (loQ.value < loF.value) {
    return false;
  }
  // Equal values: implies iff loQ.inclusive ⇒ loF.inclusive, OR loQ is
  // strictly stricter than loF (loQ exclusive, loF inclusive). Concretely:
  //   loF inclusive + loQ inclusive    → doc ≥ Q == F ≥ F → ok
  //   loF inclusive + loQ exclusive    → doc > Q == F > F-ε → doc > F ≥ F → ok
  //   loF exclusive + loQ inclusive    → doc ≥ Q == F → doc could be == F → NOT > F → fail
  //   loF exclusive + loQ exclusive    → doc > Q == F → ok
  if (loF.inclusive) {
    return true;
  } // inclusive filter is the loosest case
  return !loQ.inclusive; // strict filter needs strict query at equal bound
};

/** Mirror of lowerBoundImplies for upper bounds. */
const upperBoundImplies = (hiF: RangeInfo, hiQ: RangeInfo | undefined): boolean => {
  if (hiQ === undefined) {
    return false;
  }
  if (typeof hiF.value !== typeof hiQ.value) {
    return false;
  }
  if (hiQ.value < hiF.value) {
    return true;
  }
  if (hiQ.value > hiF.value) {
    return false;
  }
  if (hiF.inclusive) {
    return true;
  }
  return !hiQ.inclusive;
};

// Derive the tightest lower-bound the query enforces, preferring (in
// order): an `eq` clamp, the smallest `in` value, an explicit `lo`.
// Returns `undefined` when the query gives the planner nothing to lean
// on — the implication check then fails fast.
const loFromQuery = (q: OperatorBundle): RangeInfo | undefined => {
  if (q.eq !== undefined) {
    return { value: q.eq, inclusive: true };
  }
  if (q.in !== undefined && q.in.length > 0) {
    return {
      value: q.in.reduce((acc, v) => (v < acc ? v : acc), q.in[0]!),
      inclusive: true,
    };
  }
  return q.lo;
};

// Mirror of {@link loFromQuery} for upper bounds.
const hiFromQuery = (q: OperatorBundle): RangeInfo | undefined => {
  if (q.eq !== undefined) {
    return { value: q.eq, inclusive: true };
  }
  if (q.in !== undefined && q.in.length > 0) {
    return {
      value: q.in.reduce((acc, v) => (v > acc ? v : acc), q.in[0]!),
      inclusive: true,
    };
  }
  return q.hi;
};

/**
 * Filtered-index implication checker — decides whether every document
 * accepted by `queryWire` is also accepted by `indexFilterWire`. When
 * `true`, a walk over an index declared with `predicate: indexFilterWire`
 * is **complete** for `queryWire`: no matching doc is missing
 * from the smaller key set, so the planner can prefer it.
 *
 * Implication on `eq`, `gt` / `gte`, `lt` / `lte`, and `in` is
 * sound and complete in pure operator form; combined shapes (e.g.
 * range-on-filter and `in`-on-query) follow the algebra in the body
 * JSDoc.
 *
 * Algorithm — group both wires by `field`, then for every field
 * present in `indexFilterWire`:
 *
 *  1. Decode the filter's clause group into an {@link OperatorBundle}.
 *     "unknown-shape" → refuse implication conservatively.
 *  2. The query MUST have at least one clause on that field —
 *     otherwise the query says nothing about that field and cannot
 *     possibly imply the filter's constraint.
 *  3. Decode the query's clause group on the same field.
 *  4. For each non-empty slot of the filter bundle, the query bundle
 *     must establish the constraint:
 *      - `eq` → query establishes equality (via its own `eq`).
 *      - `in` → query is contained in the set (via `eq` ∈ set or
 *        `in` ⊆ set).
 *      - `lo` / `hi` → query establishes the bound via `eq`, `in`
 *        (then min/max of the set), or its own `lo`/`hi` with the
 *        inclusivity rules in {@link lowerBoundImplies} /
 *        {@link upperBoundImplies}.
 *     Mixed types (e.g. number filter vs string query) refuse
 *     implication conservatively.
 *
 * Returns `true` iff every clause was satisfied. An empty
 * `indexFilterWire` is vacuously implied by any `queryWire`.
 *
 * Soundness contract — when this function returns `true`,
 * `matchesWire(queryWire, doc) ⇒ matchesWire(indexFilterWire, doc)` for
 * any document `doc`. Tests pin this property; see
 * `./query-planner-implies.test.ts`.
 */
export const predicateImplies = (
  indexFilterWire: PredicateWire,
  queryWire: PredicateWire,
): boolean => {
  const filterGroups = groupByField(indexFilterWire);
  const queryGroups = groupByField(queryWire);

  for (const [field, filterClauses] of filterGroups) {
    const filterBundle = decodeGroup(filterClauses);
    if (filterBundle === "unknown-shape") {
      return false;
    }

    const queryClauses = queryGroups.get(field);
    if (queryClauses === undefined) {
      return false;
    }
    const queryBundle = decodeGroup(queryClauses);
    if (queryBundle === "unknown-shape") {
      return false;
    }

    if (filterBundle.eq !== undefined) {
      // Filter pins an exact value. Query must establish equality.
      if (queryBundle.eq === undefined) {
        return false;
      }
      if (!deepEqualDocumentValue(queryBundle.eq, filterBundle.eq)) {
        return false;
      }
      continue;
    }
    if (filterBundle.in !== undefined) {
      const set = filterBundle.in;
      const contains = (v: DocumentValue): boolean => set.some((m) => deepEqualDocumentValue(m, v));
      if (queryBundle.eq !== undefined) {
        if (!contains(queryBundle.eq)) {
          return false;
        }
      } else if (queryBundle.in !== undefined) {
        for (const v of queryBundle.in) {
          if (!contains(v)) {
            return false;
          }
        }
      } else {
        return false; // range query against `in` filter — not a subset
      }
      // `in` filter clause forbids any extra range constraint on the
      // filter side (enforced upstream by `validateWire`); nothing
      // else to check.
      continue;
    }
    // Range filter (lo / hi). Both bounds (if set) must be implied.
    if (filterBundle.lo !== undefined) {
      if (!lowerBoundImplies(filterBundle.lo, loFromQuery(queryBundle))) {
        return false;
      }
    }
    if (filterBundle.hi !== undefined) {
      if (!upperBoundImplies(filterBundle.hi, hiFromQuery(queryBundle))) {
        return false;
      }
    }
  }
  return true;
};
