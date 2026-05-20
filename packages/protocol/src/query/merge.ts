/**
 * AND-merge two validated predicates into one. Powers
 * `Query<T>.where(...).where(...)` chaining: each new clause AND's
 * with the existing predicate, with op-aware intersection on
 * operator-shaped values.
 *
 * Companion modules: `./validate.ts` (construction-time check),
 * `./matches.ts` (evaluator). Shared types and helpers live in
 * `./_internals.ts`.
 */

import type { Predicate } from "../table-api.ts";
import { BaerlyError } from "../errors.ts";
import type { DocumentData, DocumentValue } from "../json.ts";

import {
  assertOpObjectSatisfiable,
  compareScalar,
  deepEqualDocumentValue,
  type PredicateOp,
  sameComparableType,
} from "./_internals.ts";

const RANGE_OPS = ["$gt", "$gte", "$lt", "$lte"] as const;
type RangeOp = (typeof RANGE_OPS)[number];

/**
 * AND-merge two validated predicates. The result accepts a document
 * iff both `a` and `b` would accept it.
 *
 * Field-level union: keys unique to one side carry over verbatim.
 * Shared keys merge per the operator-aware rules in
 * CONTRACTS.md §10:
 *
 * - Both primitive / non-op: must `deepEqualDocumentValue` — a
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
export const mergePredicates = <T extends DocumentData = DocumentData>(
  a: Predicate<T>,
  b: Predicate<T>,
): Predicate<T> => {
  const out: Record<string, DocumentValue> = { ...(a as Record<string, DocumentValue>) };
  for (const key of Object.keys(b)) {
    const bVal = (b as Record<string, DocumentValue>)[key];
    if (bVal === undefined) {
      continue;
    } // tsc satisfaction; validator forbids undefined
    if (!(key in out)) {
      out[key] = bVal;
      continue;
    }
    const aVal = out[key];
    if (aVal === undefined) {
      continue;
    }
    const aOp = isOpObject(aVal);
    const bOp = isOpObject(bVal);
    if (!aOp && !bOp) {
      if (!deepEqualDocumentValue(aVal, bVal)) {
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
    const opA: PredicateOp<DocumentValue> = aOp
      ? (aVal as PredicateOp<DocumentValue>)
      : { $eq: aVal };
    const opB: PredicateOp<DocumentValue> = bOp
      ? (bVal as PredicateOp<DocumentValue>)
      : { $eq: bVal };
    out[key] = mergeOpObjects(opA, opB, key) as unknown as DocumentValue;
  }
  return out as Predicate<T>;
};

const isOpObject = (v: DocumentValue): boolean => {
  if (typeof v !== "object") {
    return false;
  }
  const k = Object.keys(v);
  return k.length > 0 && k.every((x) => x.startsWith("$"));
};

const mergeOpObjects = (
  a: PredicateOp<DocumentValue>,
  b: PredicateOp<DocumentValue>,
  field: string,
): DocumentData => {
  const candidate: Record<string, DocumentValue> = {};
  // $eq agreement.
  if (a.$eq !== undefined && b.$eq !== undefined) {
    if (!deepEqualDocumentValue(a.$eq, b.$eq)) {
      throw new BaerlyError(
        "UnsatisfiablePredicate",
        `mergePredicates: conflicting $eq values for key ${JSON.stringify(field)} (a=${JSON.stringify(a.$eq)}, b=${JSON.stringify(b.$eq)}).`,
      );
    }
    candidate["$eq"] = a.$eq;
  } else if (a.$eq !== undefined) {
    candidate["$eq"] = a.$eq;
  } else if (b.$eq !== undefined) {
    candidate["$eq"] = b.$eq;
  }
  // $in intersection.
  if (a.$in !== undefined && b.$in !== undefined) {
    const isect: DocumentValue[] = [];
    for (const m of a.$in) {
      for (const n of b.$in) {
        if (deepEqualDocumentValue(m, n)) {
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
    candidate["$in"] = isect as unknown as DocumentValue;
  } else if (a.$in !== undefined) {
    candidate["$in"] = a.$in as unknown as DocumentValue;
  } else if (b.$in !== undefined) {
    candidate["$in"] = b.$in as unknown as DocumentValue;
  }
  // Lower bound: stricter wins. Strict ($gt) beats inclusive
  // ($gte) on tie.
  const lo = pickStricter("lower", a, b);
  if (lo !== undefined) {
    if (lo.strict) {
      candidate["$gt"] = lo.value;
    } else {
      candidate["$gte"] = lo.value;
    }
  }
  // Upper bound: stricter wins.
  const hi = pickStricter("upper", a, b);
  if (hi !== undefined) {
    if (hi.strict) {
      candidate["$lt"] = hi.value;
    } else {
      candidate["$lte"] = hi.value;
    }
  }

  // Re-run satisfiability against the candidate. Reuses the
  // construction-time check so merge and validation stay in
  // lockstep.
  assertOpObjectSatisfiable(candidate as DocumentData, [field]);

  // If $eq survives alongside any range / $in clause, collapse to
  // `{ $eq: v }` alone — the satisfiability check already proved
  // $eq lies inside the interval / set.
  if (
    candidate["$eq"] !== undefined &&
    ("$in" in candidate ||
      "$gt" in candidate ||
      "$gte" in candidate ||
      "$lt" in candidate ||
      "$lte" in candidate)
  ) {
    return { $eq: candidate["$eq"] };
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
  a: PredicateOp<DocumentValue>,
  b: PredicateOp<DocumentValue>,
): { value: DocumentValue; strict: boolean } | undefined => {
  const strictOp: RangeOp = side === "lower" ? "$gt" : "$lt";
  const inclOp: RangeOp = side === "lower" ? "$gte" : "$lte";
  const collect = (
    op: PredicateOp<DocumentValue>,
  ): Array<{ value: DocumentValue; strict: boolean }> => {
    const out: Array<{ value: DocumentValue; strict: boolean }> = [];
    const s = (op as Record<string, DocumentValue>)[strictOp];
    const i = (op as Record<string, DocumentValue>)[inclOp];
    if (s !== undefined) {
      out.push({ value: s, strict: true });
    }
    if (i !== undefined) {
      out.push({ value: i, strict: false });
    }
    return out;
  };
  const candidates = [...collect(a), ...collect(b)];
  if (candidates.length === 0) {
    return undefined;
  }
  let best = candidates[0]!;
  for (let i = 1; i < candidates.length; i++) {
    const cur = candidates[i]!;
    if (!sameComparableType(best.value, cur.value)) {
      return undefined;
    }
    const c = compareScalar(best.value, cur.value);
    if (side === "lower") {
      if (c < 0) {
        best = cur;
      } else if (c === 0 && cur.strict && !best.strict) {
        best = cur;
      }
    } else {
      if (c > 0) {
        best = cur;
      } else if (c === 0 && cur.strict && !best.strict) {
        best = cur;
      }
    }
  }
  return best;
};
