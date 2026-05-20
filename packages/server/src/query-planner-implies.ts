/**
 * Filtered-index implication checker — decides whether every
 * document accepted by a query predicate is also accepted by a
 * filtered index's predicate. The query planner uses the result to
 * rank candidate indexes; see {@link "./query-planner.ts".planQuery}.
 *
 * Pure-function module: no I/O, no `Db` / `Storage` imports. Lives
 * in `@baerly/server` (not in `@baerly/protocol`) because the
 * planner is the only caller.
 */

import {
  deepEqualDocumentValue,
  type DocumentData,
  type DocumentValue,
  type Predicate,
} from "@baerly/protocol";

/**
 * One side of a range bound extracted from an operator clause. The
 * `inclusive` flag distinguishes `$gte` / `$lte` (inclusive) from
 * `$gt` / `$lt` (exclusive). Private to {@link predicateImplies}.
 */
interface RangeInfo {
  readonly value: DocumentValue;
  readonly inclusive: boolean;
}

/**
 * Normalised view of one predicate clause for the implication
 * checker. A clause is either a bare primitive (collapses to `eq`),
 * a non-operator nested object (handled by the recursive path in
 * {@link predicateImplies}, never decoded here), or an operator
 * object whose keys are a subset of `{$eq, $gt, $gte, $lt, $lte, $in}`.
 * Any other shape — unknown operator key, malformed `$in`, mixed
 * key set — surfaces as `"unknown-shape"` so the caller can
 * conservatively return `false`. Private to {@link predicateImplies}.
 */
interface OperatorBundle {
  readonly eq?: DocumentValue;
  readonly lo?: RangeInfo;
  readonly hi?: RangeInfo;
  readonly in?: ReadonlyArray<DocumentValue>;
}

const decodeClause = (
  clause: DocumentValue | Record<string, DocumentValue>,
): OperatorBundle | "unknown-shape" => {
  // Bare primitive collapses to {eq: clause}.
  if (clause === null || typeof clause !== "object" || Array.isArray(clause)) {
    return { eq: clause as DocumentValue };
  }
  const obj = clause as Record<string, DocumentValue>;
  const keys = Object.keys(obj);
  const allOps = keys.length > 0 && keys.every((k) => k.startsWith("$"));
  if (!allOps) {
    return { eq: clause as DocumentValue };
  } // nested non-op object → equality
  const bundle: {
    eq?: DocumentValue;
    lo?: RangeInfo;
    hi?: RangeInfo;
    in?: ReadonlyArray<DocumentValue>;
  } = {};
  for (const k of keys) {
    const v = obj[k];
    if (v === undefined) {
      continue;
    }
    if (k === "$eq") {
      bundle.eq = v;
    } else if (k === "$gte") {
      bundle.lo = { value: v, inclusive: true };
    } else if (k === "$gt") {
      bundle.lo = { value: v, inclusive: false };
    } else if (k === "$lte") {
      bundle.hi = { value: v, inclusive: true };
    } else if (k === "$lt") {
      bundle.hi = { value: v, inclusive: false };
    } else if (k === "$in") {
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
// order): an `$eq` clamp, the smallest `$in` value, an explicit `lo`.
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
 * accepted by `queryPredicate` is also accepted by `indexFilter`. When
 * `true`, a walk over an index declared with `predicate: indexFilter`
 * is **complete** for `queryPredicate`: no matching doc is missing
 * from the smaller key set, so the planner can prefer it.
 *
 * Implication on `$eq`, `$gt` / `$gte`, `$lt` / `$lte`, and `$in` is
 * sound and complete in pure operator form; combined shapes (e.g.
 * range-on-filter and `$in`-on-query) follow the algebra in the body
 * JSDoc.
 *
 * Algorithm — for every top-level key `k` in `indexFilter`:
 *
 *  1. `indexFilter[k]` is a non-operator nested object → require
 *     `queryPredicate[k]` to be an object (not primitive / missing /
 *     array) and recurse with the sub-predicates.
 *  2. Otherwise decode both `indexFilter[k]` and `queryPredicate[k]`
 *     into an {@link OperatorBundle} (bare primitive collapses to
 *     `eq`; operator object decomposes into `eq` / `lo` / `hi` / `in`).
 *     For each non-empty slot of the filter bundle, the query bundle
 *     must establish the constraint:
 *       - `eq` → query establishes equality (via its own `eq`).
 *       - `in` → query is contained in the set (via `eq` ∈ set or
 *         `in` ⊆ set).
 *       - `lo` / `hi` → query establishes the bound via `eq`, `in`
 *         (then min/max of the set), or its own `lo`/`hi` with the
 *         inclusivity rules in {@link lowerBoundImplies} /
 *         {@link upperBoundImplies}.
 *     Mixed types (e.g. number filter vs string query) refuse
 *     implication conservatively.
 *
 * Returns `true` iff every clause was satisfied. An empty
 * `indexFilter` is vacuously implied by any `queryPredicate`.
 *
 * Soundness contract — when this function returns `true`,
 * `matches(queryPredicate, doc) ⇒ matches(indexFilter, doc)` for any
 * document `doc`. Tests pin this property; see
 * `./query-planner-implies.test.ts`.
 *
 * @example
 * ```ts
 * predicateImplies({ status: "open" }, { status: "open" }); // true
 * predicateImplies({ status: "open" }, { status: "open", assignee: "alice" }); // true
 * predicateImplies({ status: "open" }, { status: "closed" }); // false
 * predicateImplies({ assignee: { team: "platform" } }, { assignee: { team: "platform" } }); // true
 * predicateImplies({ age: { $gte: 18 } }, { age: 21 }); // true
 * ```
 */
export const predicateImplies = <T extends DocumentData = DocumentData>(
  indexFilter: Predicate<T>,
  queryPredicate: Predicate<T>,
): boolean => {
  for (const key of Object.keys(indexFilter)) {
    const filterVal = (indexFilter as Record<string, DocumentValue | undefined>)[key];
    if (filterVal === undefined) {
      continue;
    }

    // Nested non-operator object → recurse.
    if (
      typeof filterVal === "object" &&
      filterVal !== null &&
      !Array.isArray(filterVal) &&
      !Object.keys(filterVal).every((k) => k.startsWith("$"))
    ) {
      const queryVal = (queryPredicate as Record<string, DocumentValue | undefined>)[key];
      if (
        queryVal === undefined ||
        typeof queryVal !== "object" ||
        queryVal === null ||
        Array.isArray(queryVal)
      ) {
        return false;
      }
      if (
        !predicateImplies(
          filterVal as Predicate<DocumentData>,
          queryVal as Predicate<DocumentData>,
        )
      ) {
        return false;
      }
      continue;
    }

    // Decode both clauses.
    const filterBundle = decodeClause(filterVal as DocumentValue);
    if (filterBundle === "unknown-shape") {
      return false;
    }
    const queryVal = (queryPredicate as Record<string, DocumentValue | undefined>)[key];
    if (queryVal === undefined) {
      return false;
    }
    const queryBundle = decodeClause(queryVal as DocumentValue);
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
        return false; // range query against $in filter — not a subset
      }
      // $in filter clause forbids any extra range constraint on the
      // filter side (enforced upstream by `validatePredicate`);
      // nothing else to check.
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
