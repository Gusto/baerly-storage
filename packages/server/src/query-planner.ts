/**
 * Pure-function query planner. Picks a walk plan (or a full-scan
 * decision) from a predicate + the collection's declared indexes.
 *
 * Zero I/O, zero storage-encoding awareness, zero `Db`/`Storage`
 * imports. The planner sits between `runRead`'s predicate intake and
 * the executor that walks index entries; the executor handles every
 * storage-encoding boundary (`encodeIndexValue`, `Storage.list`,
 * etc.).
 *
 * Today (T2): equality-only walks — single-field, composite full,
 * and composite partial-prefix. Operator clauses (`$gt`, `$in`, …)
 * always land on the post-filter residue and the read path's
 * in-memory `matches(...)` re-check consumes them.
 *
 * T3 fills the `rangeOn` / `inOn` slots reserved on
 * {@link IndexWalkPlan} to push range / `$in` clauses into the walk
 * on the LAST indexed field beyond the equality prefix. T4 adds the
 * filtered-index cost bias.
 *
 * @see ../../../.claude/research/planning/tickets/predicate-routing/02-auto-planner-and-composite-reads.md
 */

import type { Predicate, JSONArrayless, JSONArraylessObject } from "@baerly/protocol";
import type { IndexDefinition } from "./indexes.ts";

/**
 * Tagged union returned by {@link planQuery}. The read path
 * routes on `kind` — `index-walk` invokes the executor, `full-scan`
 * falls through to the snapshot + log fold.
 */
export type QueryPlan = IndexWalkPlan | FullScanPlan;

/**
 * Plan to satisfy the predicate by walking one declared index. The
 * executor encodes `equalityKeys` via `encodeIndexValue` at the I/O
 * boundary and lists `<tablePrefix>/index/<indexName>/<v0>/.../<vN>/`.
 *
 * `rangeOn` and `inOn` are reserved for T3 — both `undefined` under
 * T2's equality-only routing. The executor re-applies the original
 * predicate after fetching rows to defend against stale index
 * entries AND to consume the planner's `postFilter` residue.
 */
export interface IndexWalkPlan {
  readonly kind: "index-walk";
  /** Name of the chosen IndexDefinition. */
  readonly indexName: string;
  /**
   * Left-anchored raw equality values, one per indexed field consumed.
   * Length ≥ 1. The executor encodes these via `encodeIndexValue` at
   * the I/O boundary; the planner stays storage-encoding-free.
   */
  readonly equalityKeys: ReadonlyArray<JSONArrayless>;
  /**
   * T3 fills this slot. Range bound on the LAST indexed field beyond
   * the equality prefix. Mutually exclusive with `inOn`.
   */
  readonly rangeOn?: {
    readonly field: string;
    readonly lo?: JSONArrayless;
    readonly hi?: JSONArrayless;
    readonly loInclusive: boolean;
    readonly hiInclusive: boolean;
  };
  /**
   * T3 fills this slot. $in multi-walk on the LAST indexed field
   * beyond the equality prefix. Mutually exclusive with `rangeOn`.
   */
  readonly inOn?: {
    readonly field: string;
    readonly values: ReadonlyArray<JSONArrayless>;
  };
  /**
   * Predicate residue the executor MUST re-apply post-fetch via
   * `matches(...)`. Defends against stale index entries AND consumes
   * predicate clauses the planner could not push into the walk (e.g.
   * unrelated equality on a non-indexed field, or operator clauses
   * the planner left for the in-memory re-check).
   */
  readonly postFilter?: Predicate<JSONArraylessObject>;
}

/**
 * Plan to fall through to the snapshot + log fold. The `reason`
 * field is diagnostic only — it is NOT part of the public API and
 * is consumed by the planner's tests / future observability.
 */
export interface FullScanPlan {
  readonly kind: "full-scan";
  /** Diagnostic — not part of the public API. */
  readonly reason:
    | "no-predicate"
    | "no-indexes-declared"
    | "no-matching-index"
    | "predicate-uses-operators-only"
    | "numeric-range-on-byte-encoder"; // T3
}

/**
 * Optional configuration for {@link planQuery}. Reserved for future
 * diagnostic toggles; ignored by the current implementation.
 */
export interface PlanQueryOptions {
  /** Diagnostic toggle; attaches `consideredIndexes` when true. */
  readonly trace?: boolean;
}

/**
 * Detect "operator-shape object": every key starts with `$`. Mirrors
 * T1's `validatePredicate` rule (see
 * `packages/protocol/src/query/predicate.ts`).
 */
const isOperatorObject = (v: unknown): boolean => {
  if (v === null || typeof v !== "object") return false;
  const keys = Object.keys(v as Record<string, unknown>);
  if (keys.length === 0) return false;
  for (const k of keys) {
    if (!k.startsWith("$")) return false;
  }
  return true;
};

/**
 * Choose a query plan over the predicate + declared indexes. Pure
 * function. The executor enforces the I/O semantics; the planner's
 * only contract is "given these inputs, this is the routing
 * decision."
 *
 * Algorithm (T2, equality-only):
 *  1. `predicate === undefined` → `no-predicate`.
 *  2. `indexes.length === 0` → `no-indexes-declared`.
 *  3. Partition predicate keys into `equality[k] = v` (JSON primitive
 *     or non-operator nested object) and `residue` (operator-shape
 *     objects).
 *  4. If `equality` is empty → `predicate-uses-operators-only`.
 *  5. For each `def`, walk `def.on` left-to-right and stop on the
 *     first absent equality key. Record `(prefixLen, equalityKeys)`
 *     where `prefixLen > 0`. Otherwise skip.
 *  6. Pick the candidate with the largest `prefixLen`. Ties go to
 *     the first-declared. If no candidates: `no-matching-index`.
 *  7. Build the `postFilter` residue: every predicate key NOT in
 *     the winner's consumed prefix. Attach only when non-empty.
 *
 * The planner deliberately treats `def.on` as the LITERAL tuple of
 * field names — top-level only. Dotted paths are out of scope here
 * (the projector at `indexes.ts:projectIndexValues` is top-level-
 * only too).
 *
 * @typeParam T - the document shape the predicate is keyed against.
 */
export const planQuery = <T extends JSONArraylessObject = JSONArraylessObject>(
  predicate: Predicate<T> | undefined,
  indexes: ReadonlyArray<IndexDefinition>,
  _options?: PlanQueryOptions,
): QueryPlan => {
  if (predicate === undefined) {
    return { kind: "full-scan", reason: "no-predicate" };
  }
  if (indexes.length === 0) {
    return { kind: "full-scan", reason: "no-indexes-declared" };
  }

  // Partition predicate keys into equality (planner-consumable)
  // versus operator-shape residue (always post-fetch).
  const equality = new Map<string, JSONArrayless>();
  const residueKeys: string[] = [];
  for (const key of Object.keys(predicate)) {
    const value = (predicate as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (isOperatorObject(value)) {
      residueKeys.push(key);
      continue;
    }
    // Primitives + non-operator nested objects are routable as
    // equality. The encoder accepts any JSONArrayless value; equal-
    // by-value objects produce byte-equal segments.
    equality.set(key, value as JSONArrayless);
  }

  if (equality.size === 0) {
    return { kind: "full-scan", reason: "predicate-uses-operators-only" };
  }

  // Find the best candidate over all declared indexes. Iteration
  // order is the array order — the only tie-break source.
  interface Candidate {
    readonly def: IndexDefinition;
    readonly prefixLen: number;
    readonly equalityKeys: JSONArrayless[];
    readonly consumed: ReadonlyArray<string>;
  }
  let best: Candidate | undefined;
  for (const def of indexes) {
    const tuple: readonly string[] = typeof def.on === "string" ? [def.on] : def.on;
    const equalityKeys: JSONArrayless[] = [];
    const consumed: string[] = [];
    for (let i = 0; i < tuple.length; i++) {
      const field = tuple[i]!;
      const v = equality.get(field);
      if (v === undefined) break;
      equalityKeys.push(v);
      consumed.push(field);
    }
    if (equalityKeys.length === 0) continue;
    if (best === undefined || equalityKeys.length > best.prefixLen) {
      best = {
        def,
        prefixLen: equalityKeys.length,
        equalityKeys,
        consumed,
      };
    }
  }
  if (best === undefined) {
    return { kind: "full-scan", reason: "no-matching-index" };
  }

  // Residue = every predicate key NOT consumed by the winner's
  // walk prefix. Includes:
  //   - Equality clauses on non-indexed fields.
  //   - Operator-shape clauses (always — the walk never consumes
  //     them under T2).
  const consumedSet = new Set(best.consumed);
  const postFilter: Record<string, unknown> = {};
  let residueCount = 0;
  for (const key of Object.keys(predicate)) {
    if (consumedSet.has(key)) continue;
    const value = (predicate as Record<string, unknown>)[key];
    if (value === undefined) continue;
    postFilter[key] = value;
    residueCount++;
  }
  // Silence unused warnings in case future T3 logic uses residueKeys
  // directly; today the residue is rebuilt from the predicate.
  void residueKeys;

  const plan: IndexWalkPlan = {
    kind: "index-walk",
    indexName: best.def.name,
    equalityKeys: best.equalityKeys,
    ...(residueCount > 0 ? { postFilter: postFilter as Predicate<JSONArraylessObject> } : {}),
  };
  return plan;
};
