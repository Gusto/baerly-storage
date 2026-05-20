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
 * Numeric range / `$in` are routed normally; the encoder at
 * `./indexes.ts:encodeIndexValue` is value-order-preserving for
 * numbers.
 */

import { type DocumentValue, type DocumentData, type Predicate } from "@baerly/protocol";
import type { IndexDefinition } from "./indexes.ts";
import { predicateImplies } from "./query-planner-implies.ts";

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
 * T2's equality-only routing. The executor re-applies the FULL
 * original predicate via `matches(...)` after fetching rows; that
 * single check is both the stale-index defence and the residue
 * consumer, so the planner does NOT emit a separate `postFilter`.
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
  readonly equalityKeys: ReadonlyArray<DocumentValue>;
  /**
   * T3 fills this slot. Range bound on the LAST indexed field beyond
   * the equality prefix. Mutually exclusive with `inOn`.
   */
  readonly rangeOn?: {
    readonly field: string;
    readonly lo?: DocumentValue;
    readonly hi?: DocumentValue;
    readonly loInclusive: boolean;
    readonly hiInclusive: boolean;
  };
  /**
   * T3 fills this slot. $in multi-walk on the LAST indexed field
   * beyond the equality prefix. Mutually exclusive with `rangeOn`.
   */
  readonly inOn?: {
    readonly field: string;
    readonly values: ReadonlyArray<DocumentValue>;
  };
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
    | "predicate-uses-operators-only";
}

/**
 * `$in` fan-out threshold. `$in: [...]` with `values.length`
 * at or below this number emits an `inOn` walk plan; over this
 * number the planner falls back to `FullScanPlan` because N
 * parallel-fan-out LIST round-trips cost more than one snapshot+log
 * fold on every backend we benchmark (see `bench/load-harness/`).
 *
 * Hard-coded at the value that survives Cloudflare's 50-subrequest
 * budget. If the default proves wrong on cheap-LIST backends
 * (Minio / S3 / GCS), file a bug — the answer is "good, let's tune
 * the default," not "make it configurable."
 */
export const IN_FANOUT_THRESHOLD = 50;

/**
 * Detect "operator-shape object": every key starts with `$`. Mirrors
 * T1's `validatePredicate` rule (see
 * `packages/protocol/src/query/validate.ts`).
 */
const isOperatorObject = (v: unknown): boolean => {
  if (v === null || typeof v !== "object") {
    return false;
  }
  const keys = Object.keys(v as Record<string, unknown>);
  if (keys.length === 0) {
    return false;
  }
  for (const k of keys) {
    if (!k.startsWith("$")) {
      return false;
    }
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
  readonly lo?: DocumentValue;
  readonly hi?: DocumentValue;
  readonly loInclusive: boolean;
  readonly hiInclusive: boolean;
}

const tryExtractRange = (op: Record<string, unknown>): RangeOpInfo | undefined => {
  const keys = Object.keys(op);
  // `$in` is its own routing channel — never mix with range here.
  if (keys.includes("$in")) {
    return undefined;
  }
  // `$eq` alone — caller should treat the field as equality, not range.
  if (keys.length === 1 && keys[0] === "$eq") {
    return undefined;
  }
  const hasRange =
    op["$gt"] !== undefined ||
    op["$gte"] !== undefined ||
    op["$lt"] !== undefined ||
    op["$lte"] !== undefined;
  if (!hasRange) {
    return undefined;
  }
  // `$eq` mixed with a range — T1 validation collapses this to a
  // single $eq when satisfiable, but defensively refuse routing
  // anyway; the full-scan path is correct.
  if (op["$eq"] !== undefined) {
    return undefined;
  }
  let lo: DocumentValue | undefined;
  let loInclusive = false;
  if (op["$gte"] !== undefined) {
    lo = op["$gte"] as DocumentValue;
    loInclusive = true;
  } else if (op["$gt"] !== undefined) {
    lo = op["$gt"] as DocumentValue;
    loInclusive = false;
  }
  let hi: DocumentValue | undefined;
  let hiInclusive = false;
  if (op["$lte"] !== undefined) {
    hi = op["$lte"] as DocumentValue;
    hiInclusive = true;
  } else if (op["$lt"] !== undefined) {
    hi = op["$lt"] as DocumentValue;
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
const tryExtractIn = (op: Record<string, unknown>): ReadonlyArray<DocumentValue> | undefined => {
  const keys = Object.keys(op);
  if (keys.length !== 1 || keys[0] !== "$in") {
    return undefined;
  }
  const values = op["$in"] as ReadonlyArray<DocumentValue> | undefined;
  if (!Array.isArray(values)) {
    return undefined;
  }
  return values;
};

/**
 * `$eq` extraction — collapses `{$eq:v}` to a bare equality value
 * the planner can put in `equalityKeys`. Returns `undefined` for any
 * other shape.
 */
const tryExtractEq = (op: Record<string, unknown>): DocumentValue | undefined => {
  const keys = Object.keys(op);
  if (keys.length === 1 && keys[0] === "$eq" && op["$eq"] !== undefined) {
    return op["$eq"] as DocumentValue;
  }
  return undefined;
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
 *      - Everything else stays in the original predicate; the
 *        executor re-applies the full predicate post-fetch via
 *        `matches(...)`, which catches the residue automatically.
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
 *  7. `$in` FAN-OUT GUARD: if the chosen plan's `$in` slot has
 *     `values.length > IN_FANOUT_THRESHOLD`, fall back to
 *     `FullScanPlan{reason:"no-matching-index"}` — N sequential
 *     LISTs cost more than a snapshot+log fold.
 *
 * The planner deliberately treats `def.on` as the LITERAL tuple of
 * field names — top-level only. Dotted paths are out of scope here
 * (the projector at `indexes.ts:projectIndexValues` is top-level-
 * only too).
 *
 * **Range/`$in` is allowed only on the LAST indexed field beyond the
 * equality prefix** — on a composite `[a, b]`, a range on `a` with
 * equality on `b` is NOT contiguous under the key encoding (the `b`
 * slot sits to the right of the varying `a` slot). Clauses landing
 * outside the tail slot are simply left for the executor's full-
 * predicate re-check.
 *
 * @typeParam T - the document shape the predicate is keyed against.
 */
export const planQuery = <T extends DocumentData = DocumentData>(
  predicate: Predicate<T> | undefined,
  indexes: ReadonlyArray<IndexDefinition>,
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
  const equality = new Map<string, DocumentValue>();
  const rangeOps = new Map<string, RangeOpInfo>();
  const inOps = new Map<string, ReadonlyArray<DocumentValue>>();
  for (const key of Object.keys(predicate)) {
    const value = (predicate as Record<string, unknown>)[key];
    if (value === undefined) {
      continue;
    }
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
      // Some other operator-object shape (e.g. mixed). Stays in
      // the original predicate; the executor's full-predicate
      // re-check applies it post-fetch.
      continue;
    }
    // Primitives + non-operator nested objects are routable as
    // equality. The encoder accepts any DocumentValue value; equal-
    // by-value objects produce byte-equal segments.
    equality.set(key, value as DocumentValue);
  }

  if (equality.size === 0 && rangeOps.size === 0 && inOps.size === 0) {
    return { kind: "full-scan", reason: "predicate-uses-operators-only" };
  }

  // Enumerate every viable candidate over the declared indexes,
  // then sort with the T4 tie-break:
  //
  //  (1) Implied filter — a filtered index whose
  //      `predicateImplies(def.predicate, queryPredicate)` is `true`
  //      outranks an unfiltered alternative (sparser key range →
  //      smaller LIST). An unfiltered index outranks a filtered one
  //      whose `predicateImplies` is `false` — walking the smaller
  //      set would miss matching docs.
  //  (2) Longest total consumed length wins among ties on (1).
  //  (3) Definition order among ties on (1) and (2).
  interface Candidate {
    readonly def: IndexDefinition;
    readonly defIndex: number;
    readonly prefixLen: number;
    readonly equalityKeys: DocumentValue[];
    readonly tail?:
      | { kind: "range"; field: string; info: RangeOpInfo }
      | { kind: "in"; field: string; values: ReadonlyArray<DocumentValue> };
  }
  const candidates: Candidate[] = [];
  for (let defIndex = 0; defIndex < indexes.length; defIndex++) {
    const def = indexes[defIndex]!;
    const tuple: readonly string[] = typeof def.on === "string" ? [def.on] : def.on;
    const equalityKeys: DocumentValue[] = [];
    let tail: Candidate["tail"] | undefined;
    for (let i = 0; i < tuple.length; i++) {
      const field = tuple[i]!;
      const v = equality.get(field);
      if (v !== undefined) {
        equalityKeys.push(v);
        continue;
      }
      // First field WITHOUT equality — this is the "tail slot"
      // candidate for range/$in. Range and $in are mutually
      // exclusive on a single walk; the partitioning above is
      // mutually exclusive per-field, so at most one applies.
      const range = rangeOps.get(field);
      if (range !== undefined) {
        tail = { kind: "range", field, info: range };
      } else {
        const inVals = inOps.get(field);
        if (inVals !== undefined) {
          tail = { kind: "in", field, values: inVals };
        }
      }
      break;
    }
    const candidateLen = equalityKeys.length + (tail !== undefined ? 1 : 0);
    if (candidateLen === 0) {
      continue;
    }
    candidates.push({
      def,
      defIndex,
      prefixLen: candidateLen,
      equalityKeys,
      ...(tail !== undefined ? { tail } : {}),
    });
  }
  if (candidates.length === 0) {
    return { kind: "full-scan", reason: "no-matching-index" };
  }

  // T4 cost-bias rank: 0 = filtered + implied (best), 1 = unfiltered
  // (mid), 2 = filtered + NOT implied (worst). A filtered candidate
  // whose filter is NOT implied is STILL eligible — but only as a
  // last resort. The post-fetch `matches(predicate, ...)` re-check
  // would still drop the rows that fall outside the filter, so the
  // index walk is unsound for the query (it would silently miss
  // matching rows that fell outside the filter), and only the
  // sort order keeps it last.
  const rank = (c: Candidate): number => {
    if (c.def.predicate === undefined) {
      return 1;
    }
    return predicateImplies(c.def.predicate, predicate as Predicate<DocumentData>) ? 0 : 2;
  };
  candidates.sort((a, b) => {
    const aRank = rank(a);
    const bRank = rank(b);
    if (aRank !== bRank) {
      return aRank - bRank;
    }
    if (b.prefixLen !== a.prefixLen) {
      return b.prefixLen - a.prefixLen;
    }
    return a.defIndex - b.defIndex;
  });
  const best: Candidate = candidates[0]!;

  // `$in` fan-out guard. Over {@link IN_FANOUT_THRESHOLD}, N
  // sequential LISTs cost more than one snapshot+log fold on every
  // backend we benchmark — refuse routing. Full-scan is correct.
  if (best.tail !== undefined && best.tail.kind === "in") {
    if (best.tail.values.length > IN_FANOUT_THRESHOLD) {
      return { kind: "full-scan", reason: "no-matching-index" };
    }
  }

  // Residue (unconsumed predicate clauses) is intentionally NOT
  // surfaced on the plan — the executor re-applies the FULL
  // original predicate via `matches(...)` post-fetch, which is
  // both the stale-index defence and the residue consumer. See
  // `query.ts` ("simpler invariant").
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
  };
  return plan;
};
