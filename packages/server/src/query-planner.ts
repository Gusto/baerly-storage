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
 * T2 shipped equality-only walks — single-field, composite full,
 * and composite partial-prefix. T3 fills the `rangeOn` / `inOn`
 * slots reserved on {@link IndexWalkPlan} so range / `$in` clauses
 * on the LAST indexed field beyond the equality prefix get pushed
 * into the walk too. T4 adds the filtered-index cost bias.
 *
 * KNOWN LIMITATION — numeric ranges and numeric `$in` predicates are
 * refused at the planner via `FullScanPlan{reason:
 * "numeric-range-on-byte-encoder"}`. `encodeIndexValue`
 * (`./indexes.ts`) is byte-order-preserving on `JSON.stringify(v)`,
 * not value-order-preserving — `"9" > "10"` byte-wise. The
 * full-scan path is correct for these predicates; only the index
 * optimisation is refused. A value-order-preserving numeric encoder
 * is a follow-up.
 *
 * @see ../../../.claude/research/planning/tickets/predicate-routing/02-auto-planner-and-composite-reads.md
 * @see ../../../.claude/research/planning/tickets/predicate-routing/03-range-and-in-walks.md
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
 * `$in` fan-out threshold. `$in: [...]` with `values.length` at or
 * below this number emits an `inOn` walk plan; over this number the
 * planner falls back to `FullScanPlan` because N sequential LIST
 * round-trips cost more than one snapshot+log fold on every backend
 * we benchmark (see `bench/load-harness/` and T5's bench evidence).
 *
 * Hard-coded for T3; a `Db.create({ inFanoutThreshold })` option is
 * a follow-up captured in `docs/followups/predicate-routing.md`.
 */
export const IN_FANOUT_THRESHOLD = 50;

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
 * Extract a normalized range bound from an operator object, if one
 * is present. Returns `undefined` when the op-object has neither a
 * range bound nor `$eq` (e.g. `{$in:[...]}` only). When `$eq` is
 * present alongside no range bounds, returns it as an equality.
 *
 * The detection is conservative — any unsupported shape (mixed
 * `$eq` + range, `$in` mixed with anything else) returns
 * `undefined` so the planner skips routing that field rather than
 * misroute.
 */
interface RangeOpInfo {
  readonly lo?: JSONArrayless;
  readonly hi?: JSONArrayless;
  readonly loInclusive: boolean;
  readonly hiInclusive: boolean;
}

const tryExtractRange = (op: Record<string, unknown>): RangeOpInfo | undefined => {
  const keys = Object.keys(op);
  // `$in` is its own routing channel — never mix with range here.
  if (keys.includes("$in")) return undefined;
  // `$eq` alone — caller should treat the field as equality, not range.
  if (keys.length === 1 && keys[0] === "$eq") return undefined;
  const hasRange =
    op.$gt !== undefined || op.$gte !== undefined || op.$lt !== undefined || op.$lte !== undefined;
  if (!hasRange) return undefined;
  // `$eq` mixed with a range — T1 validation collapses this to a
  // single $eq when satisfiable, but defensively refuse routing
  // anyway; the full-scan path is correct.
  if (op.$eq !== undefined) return undefined;
  let lo: JSONArrayless | undefined;
  let loInclusive = false;
  if (op.$gte !== undefined) {
    lo = op.$gte as JSONArrayless;
    loInclusive = true;
  } else if (op.$gt !== undefined) {
    lo = op.$gt as JSONArrayless;
    loInclusive = false;
  }
  let hi: JSONArrayless | undefined;
  let hiInclusive = false;
  if (op.$lte !== undefined) {
    hi = op.$lte as JSONArrayless;
    hiInclusive = true;
  } else if (op.$lt !== undefined) {
    hi = op.$lt as JSONArrayless;
    hiInclusive = false;
  }
  return {
    ...(lo !== undefined ? { lo } : {}),
    ...(hi !== undefined ? { hi } : {}),
    loInclusive,
    hiInclusive,
  };
};

/**
 * Extract `$in` member values from an op-object, if it is an
 * `$in`-only clause. Returns `undefined` for anything else (including
 * `$in` mixed with other operators — the planner only routes the
 * pure shape).
 */
const tryExtractIn = (op: Record<string, unknown>): ReadonlyArray<JSONArrayless> | undefined => {
  const keys = Object.keys(op);
  if (keys.length !== 1 || keys[0] !== "$in") return undefined;
  const values = op.$in as ReadonlyArray<JSONArrayless> | undefined;
  if (!Array.isArray(values)) return undefined;
  return values;
};

/**
 * `$eq` extraction — collapses `{$eq:v}` to a bare equality value
 * the planner can put in `equalityKeys`. Returns `undefined` for any
 * other shape.
 */
const tryExtractEq = (op: Record<string, unknown>): JSONArrayless | undefined => {
  const keys = Object.keys(op);
  if (keys.length === 1 && keys[0] === "$eq" && op.$eq !== undefined) {
    return op.$eq as JSONArrayless;
  }
  return undefined;
};

/**
 * NUMERIC-RANGE GUARD.
 *
 * `encodeIndexValue` is byte-order-preserving on `JSON.stringify(v)`,
 * not value-order-preserving. JSON-stringified numbers don't sort
 * lexicographically by numeric value: `JSON.stringify(9) === "9"`
 * (one byte: 0x39) and `JSON.stringify(10) === "10"` (two bytes:
 * 0x31 0x30), so `"9" > "10"` byte-wise. A range walk that trusted
 * the encoder for numeric values would silently miss rows.
 *
 * Mitigation: refuse to optimise numeric ranges at the planner.
 * The full-scan path is correct — only the index optimisation is
 * refused. A value-order-preserving numeric encoder is a follow-up
 * ticket (see `docs/followups/predicate-routing.md`).
 *
 * Strings, booleans, and object equality (via `deepEqualJSONArrayless`)
 * remain safe because their JSON encoding IS byte-order-preserving
 * with respect to JS `<` (UTF-16 strings; booleans collapse to two
 * canonical encodings `"true"` / `"false"`).
 */
const containsNumber = (values: ReadonlyArray<JSONArrayless | undefined>): boolean => {
  for (const v of values) {
    if (typeof v === "number") return true;
  }
  return false;
};

/**
 * Choose a query plan over the predicate + declared indexes. Pure
 * function. The executor enforces the I/O semantics; the planner's
 * only contract is "given these inputs, this is the routing
 * decision."
 *
 * Algorithm:
 *  1. `predicate === undefined` → `no-predicate`.
 *  2. `indexes.length === 0` → `no-indexes-declared`.
 *  3. Partition predicate keys into:
 *      - `equality[k] = v` (JSON primitive, non-operator nested
 *        object, or `{$eq:v}` collapsing to `v`).
 *      - `rangeOps[k] = {lo, hi, loInclusive, hiInclusive}` for
 *        range-only `{$gt|$gte|$lt|$lte}` op-objects.
 *      - `inOps[k] = [...]` for pure `{$in:[...]}` op-objects.
 *      - Everything else lands on `postFilter` residue.
 *  4. If no equality / range / $in candidates exist →
 *     `predicate-uses-operators-only`.
 *  5. For each `def`, walk `def.on` left-to-right consuming
 *     equality clauses for each indexed field. On the FIRST field
 *     where the equality clause is absent, check whether a range
 *     or `$in` clause is available for that field — if so, that's
 *     the "tail slot" of the walk.
 *  6. Score candidates by `(equalityPrefixLen, hasTailExtension)`.
 *     Longest prefix wins; tail-extension breaks ties. If no
 *     candidate consumed at least one field (equality OR
 *     range/$in): `no-matching-index`.
 *  7. NUMERIC-RANGE GUARD: if the chosen plan's range/$in slot
 *     contains any `typeof === "number"` value, emit
 *     `FullScanPlan{reason:"numeric-range-on-byte-encoder"}` — the
 *     full-scan path is correct for the predicate; only the
 *     optimisation is refused.
 *  8. `$in` FAN-OUT GUARD: if the chosen plan's `$in` slot has
 *     `values.length > IN_FANOUT_THRESHOLD`, fall back to
 *     `FullScanPlan{reason:"no-matching-index"}` — N sequential
 *     LISTs cost more than a snapshot+log fold.
 *  9. Build the `postFilter` residue: every predicate clause NOT
 *     consumed by the walk (operator residue on non-indexed
 *     fields, equality on non-indexed fields, operator residue on
 *     fields BEYOND the tail slot, etc.). Attach only when
 *     non-empty.
 *
 * The planner deliberately treats `def.on` as the LITERAL tuple of
 * field names — top-level only. Dotted paths are out of scope here
 * (the projector at `indexes.ts:projectIndexValues` is top-level-
 * only too).
 *
 * **Range/`$in` is allowed only on the LAST indexed field beyond the
 * equality prefix** — on a composite `[a, b]`, a range on `a` with
 * equality on `b` is NOT contiguous under the key encoding (the `b`
 * slot sits to the right of the varying `a` slot). The clause
 * landing outside the tail slot becomes `postFilter` residue.
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

  // Partition predicate keys into:
  //   - equality (planner-consumable; bare value or `{$eq:v}`)
  //   - rangeOps (range-only op-objects)
  //   - inOps (`$in`-only op-objects)
  //   - other (anything else — always post-fetch residue)
  const equality = new Map<string, JSONArrayless>();
  const rangeOps = new Map<string, RangeOpInfo>();
  const inOps = new Map<string, ReadonlyArray<JSONArrayless>>();
  for (const key of Object.keys(predicate)) {
    const value = (predicate as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (isOperatorObject(value)) {
      const op = value as Record<string, unknown>;
      const eq = tryExtractEq(op);
      if (eq !== undefined) {
        equality.set(key, eq);
        continue;
      }
      const range = tryExtractRange(op);
      if (range !== undefined) {
        rangeOps.set(key, range);
        continue;
      }
      const inVals = tryExtractIn(op);
      if (inVals !== undefined) {
        inOps.set(key, inVals);
        continue;
      }
      // Some other operator-object shape (e.g. mixed). Falls
      // through to postFilter via the residue rebuild later.
      continue;
    }
    // Primitives + non-operator nested objects are routable as
    // equality. The encoder accepts any JSONArrayless value; equal-
    // by-value objects produce byte-equal segments.
    equality.set(key, value as JSONArrayless);
  }

  if (equality.size === 0 && rangeOps.size === 0 && inOps.size === 0) {
    return { kind: "full-scan", reason: "predicate-uses-operators-only" };
  }

  // Find the best candidate over all declared indexes. Iteration
  // order is the array order — the only tie-break source.
  interface Candidate {
    readonly def: IndexDefinition;
    readonly prefixLen: number;
    readonly equalityKeys: JSONArrayless[];
    readonly consumed: ReadonlyArray<string>;
    readonly tail?:
      | { kind: "range"; field: string; info: RangeOpInfo }
      | { kind: "in"; field: string; values: ReadonlyArray<JSONArrayless> };
  }
  let best: Candidate | undefined;
  for (const def of indexes) {
    const tuple: readonly string[] = typeof def.on === "string" ? [def.on] : def.on;
    const equalityKeys: JSONArrayless[] = [];
    const consumed: string[] = [];
    let tail: Candidate["tail"] | undefined;
    for (let i = 0; i < tuple.length; i++) {
      const field = tuple[i]!;
      const v = equality.get(field);
      if (v !== undefined) {
        equalityKeys.push(v);
        consumed.push(field);
        continue;
      }
      // First field WITHOUT equality — this is the "tail slot"
      // candidate for range/$in. Range and $in are mutually
      // exclusive on a single walk; the partitioning above is
      // mutually exclusive per-field, so at most one applies.
      const range = rangeOps.get(field);
      if (range !== undefined) {
        tail = { kind: "range", field, info: range };
        consumed.push(field);
      } else {
        const inVals = inOps.get(field);
        if (inVals !== undefined) {
          tail = { kind: "in", field, values: inVals };
          consumed.push(field);
        }
      }
      break;
    }
    const candidateLen = equalityKeys.length + (tail !== undefined ? 1 : 0);
    if (candidateLen === 0) continue;
    // Score: prefer longer total consumed length; tie-break by
    // declaration order (first wins).
    if (best === undefined || candidateLen > best.prefixLen) {
      best = {
        def,
        prefixLen: candidateLen,
        equalityKeys,
        consumed,
        ...(tail !== undefined ? { tail } : {}),
      };
    }
  }
  if (best === undefined) {
    return { kind: "full-scan", reason: "no-matching-index" };
  }

  // NUMERIC-RANGE GUARD (see `containsNumber` JSDoc above). Refuse
  // to route any range or $in plan whose bounds/members include a
  // JS number — the byte-order-preserving encoder would silently
  // miss rows.
  if (best.tail !== undefined) {
    if (best.tail.kind === "range") {
      const { lo, hi } = best.tail.info;
      if (containsNumber([lo, hi])) {
        return { kind: "full-scan", reason: "numeric-range-on-byte-encoder" };
      }
    } else {
      if (containsNumber(best.tail.values)) {
        return { kind: "full-scan", reason: "numeric-range-on-byte-encoder" };
      }
      // `$in` fan-out guard. Over the threshold, N sequential LISTs
      // cost more than one snapshot+log fold on every backend we
      // benchmark — refuse routing. Full-scan is correct.
      if (best.tail.values.length > IN_FANOUT_THRESHOLD) {
        return { kind: "full-scan", reason: "no-matching-index" };
      }
    }
  }

  // Residue = every predicate key NOT consumed by the winner's
  // walk prefix. Includes:
  //   - Equality clauses on non-indexed fields.
  //   - Operator-shape clauses on fields the walk didn't consume
  //     (e.g. range on a non-tail-slot field, or mixed-shape
  //     op-objects the planner refuses to route).
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

  const plan: IndexWalkPlan = {
    kind: "index-walk",
    indexName: best.def.name,
    equalityKeys: best.equalityKeys,
    ...(best.tail !== undefined && best.tail.kind === "range"
      ? {
          rangeOn: {
            field: best.tail.field,
            ...(best.tail.info.lo !== undefined ? { lo: best.tail.info.lo } : {}),
            ...(best.tail.info.hi !== undefined ? { hi: best.tail.info.hi } : {}),
            loInclusive: best.tail.info.loInclusive,
            hiInclusive: best.tail.info.hiInclusive,
          },
        }
      : {}),
    ...(best.tail !== undefined && best.tail.kind === "in"
      ? { inOn: { field: best.tail.field, values: best.tail.values } }
      : {}),
    ...(residueCount > 0 ? { postFilter: postFilter as Predicate<JSONArraylessObject> } : {}),
  };
  return plan;
};
