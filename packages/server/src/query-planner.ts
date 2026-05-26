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

import { type DocumentValue, type PredicateWire } from "@baerly/protocol";
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
 * original wire via `matchesWire(...)` after fetching rows; that
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
 * Per-field range bound bundle decoded from a {@link PredicateWire}.
 * Mirrors the shape the executor consumes on the plan's `rangeOn`
 * slot.
 */
interface RangeOpInfo {
  readonly lo?: DocumentValue;
  readonly hi?: DocumentValue;
  readonly loInclusive: boolean;
  readonly hiInclusive: boolean;
}

/**
 * Choose a query plan over the wire predicate + declared indexes.
 * Pure function. The executor enforces the I/O semantics; the
 * planner's only contract is "given these inputs, this is the
 * routing decision."
 *
 * Algorithm:
 *  1. `wire === undefined` or empty → `no-predicate`.
 *  2. `indexes.length === 0` → `no-indexes-declared`.
 *  3. Partition wire clauses per field into:
 *      - `equality[f] = v` from `eq` clauses.
 *      - `rangeOps[f] = {lo, hi, loInclusive, hiInclusive}` from
 *        one or more of `gt`/`gte`/`lt`/`lte` clauses on `f`.
 *      - `inOps[f] = [...]` from a single `in` clause on `f`.
 *      - Defensive: any field whose clause group mixes op-channels
 *        (mostly impossible post-validation) is marked unroutable
 *        and skipped — the executor's full-wire `matchesWire(...)`
 *        post-fetch catches the residue automatically.
 *  4. If no equality / range / `in` candidates exist →
 *     `predicate-uses-operators-only`.
 *  5. For each `def`, walk `def.on` left-to-right consuming
 *     equality clauses for each indexed field. On the FIRST field
 *     where the equality clause is absent, check whether a range
 *     or `in` clause is available for that field — if so, that's
 *     the "tail slot" of the walk.
 *  6. Score candidates by `(equalityPrefixLen, hasTailExtension)`.
 *     Longest prefix wins; tail-extension breaks ties. If no
 *     candidate consumed at least one field (equality OR
 *     range/`in`): `no-matching-index`.
 *  7. `in` FAN-OUT GUARD: if the chosen plan's `in` slot has
 *     `values.length > IN_FANOUT_THRESHOLD`, fall back to
 *     `FullScanPlan{reason:"no-matching-index"}` — N sequential
 *     LISTs cost more than a snapshot+log fold.
 *
 * The planner deliberately treats `def.on` as the LITERAL tuple of
 * field names — top-level only. Dotted paths are out of scope here
 * (the projector at `indexes.ts:projectIndexValues` is top-level-
 * only too).
 *
 * **Range/`in` is allowed only on the LAST indexed field beyond the
 * equality prefix** — on a composite `[a, b]`, a range on `a` with
 * equality on `b` is NOT contiguous under the key encoding (the `b`
 * slot sits to the right of the varying `a` slot). Clauses landing
 * outside the tail slot are simply left for the executor's full-
 * predicate re-check.
 */
export const planQuery = (
  wire: PredicateWire | undefined,
  indexes: ReadonlyArray<IndexDefinition>,
): QueryPlan => {
  if (wire === undefined || wire.clauses.length === 0) {
    return { kind: "full-scan", reason: "no-predicate" };
  }
  if (indexes.length === 0) {
    return { kind: "full-scan", reason: "no-indexes-declared" };
  }

  // Partition wire clauses per-field into:
  //   - equality (one `eq` clause on a field)
  //   - rangeOps (one or more of `gt`/`gte`/`lt`/`lte` on a field)
  //   - inOps (one `in` clause on a field)
  //   - "unroutable" fields are skipped — the executor re-applies the
  //     FULL original wire via `matchesWire(...)` post-fetch, which
  //     catches the residue automatically.
  //
  // Validator-guaranteed invariants we lean on:
  //   - Single op per field is the common case; multi-eq + multi-range
  //     are pre-collapsed to a satisfiable group.
  //   - An `eq` clause never coexists with `in` on the same field.
  //   - An `in` clause never coexists with other ops on the same field.
  //
  // Defensive posture for "mixed eq+in" or "two `in` clauses" (which
  // the validator does NOT explicitly forbid for routing's sake but
  // are not worth set-intersecting at plan time): mark the field as
  // unroutable and let the executor's full-wire post-filter cover
  // correctness.
  const equality = new Map<string, DocumentValue>();
  const rangeOps = new Map<string, RangeOpInfo>();
  const inOps = new Map<string, ReadonlyArray<DocumentValue>>();
  const unroutable = new Set<string>();

  // First pass: per field, accumulate the lo/hi bounds and detect
  // collisions between op channels.
  interface RangeAcc {
    lo?: DocumentValue;
    hi?: DocumentValue;
    loInclusive: boolean;
    hiInclusive: boolean;
  }
  const rangeAcc = new Map<string, RangeAcc>();
  for (const clause of wire.clauses) {
    const field = clause.field;
    if (unroutable.has(field)) {
      continue;
    }
    if (clause.op === "eq") {
      if (inOps.has(field) || rangeAcc.has(field)) {
        // Defensive: shouldn't happen post-validation, but keep the
        // executor's post-filter as the safety net.
        unroutable.add(field);
        equality.delete(field);
        inOps.delete(field);
        rangeAcc.delete(field);
        continue;
      }
      // Multiple `eq` on a field: the validator proves agreement; pick
      // the first observed (overwrite is fine — values agree).
      equality.set(field, clause.value as DocumentValue);
    } else if (clause.op === "in") {
      if (equality.has(field) || rangeAcc.has(field) || inOps.has(field)) {
        unroutable.add(field);
        equality.delete(field);
        inOps.delete(field);
        rangeAcc.delete(field);
        continue;
      }
      if (!Array.isArray(clause.value)) {
        unroutable.add(field);
        continue;
      }
      inOps.set(field, clause.value as ReadonlyArray<DocumentValue>);
    } else {
      // Range op (gt / gte / lt / lte).
      if (equality.has(field) || inOps.has(field)) {
        unroutable.add(field);
        equality.delete(field);
        inOps.delete(field);
        rangeAcc.delete(field);
        continue;
      }
      const acc: RangeAcc = rangeAcc.get(field) ?? { loInclusive: false, hiInclusive: false };
      const v = clause.value as DocumentValue;
      if (clause.op === "gte") {
        // Tighten lo upward.
        if (acc.lo === undefined || v > acc.lo) {
          acc.lo = v;
          acc.loInclusive = true;
        } else if (v === acc.lo && !acc.loInclusive) {
          // existing exclusive is stricter — keep it
        }
      } else if (clause.op === "gt") {
        if (acc.lo === undefined || v > acc.lo) {
          acc.lo = v;
          acc.loInclusive = false;
        } else if (v === acc.lo) {
          // Same value; exclusive wins.
          acc.loInclusive = false;
        }
      } else if (clause.op === "lte") {
        if (acc.hi === undefined || v < acc.hi) {
          acc.hi = v;
          acc.hiInclusive = true;
        }
      } else if (clause.op === "lt") {
        if (acc.hi === undefined || v < acc.hi) {
          acc.hi = v;
          acc.hiInclusive = false;
        } else if (v === acc.hi) {
          acc.hiInclusive = false;
        }
      }
      rangeAcc.set(field, acc);
    }
  }
  // Project the range accumulators into the final `RangeOpInfo` map.
  for (const [field, acc] of rangeAcc) {
    rangeOps.set(field, {
      ...(acc.lo !== undefined ? { lo: acc.lo } : {}),
      ...(acc.hi !== undefined ? { hi: acc.hi } : {}),
      loInclusive: acc.loInclusive,
      hiInclusive: acc.hiInclusive,
    });
  }

  if (equality.size === 0 && rangeOps.size === 0 && inOps.size === 0) {
    return { kind: "full-scan", reason: "predicate-uses-operators-only" };
  }

  // Enumerate every viable candidate over the declared indexes,
  // then sort with the T4 tie-break:
  //
  //  (1) Implied filter — a filtered index whose
  //      `predicateImplies(def.predicate, queryWire)` is `true`
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
  // last resort. The post-fetch `matchesWire(wire, ...)` re-check
  // would still drop the rows that fall outside the filter, so the
  // index walk is unsound for the query (it would silently miss
  // matching rows that fell outside the filter), and only the
  // sort order keeps it last.
  const rank = (c: Candidate): number => {
    if (c.def.predicate === undefined) {
      return 1;
    }
    return predicateImplies(c.def.predicate, wire) ? 0 : 2;
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

  // Residue (unconsumed wire clauses) is intentionally NOT
  // surfaced on the plan — the executor re-applies the FULL
  // original wire via `matchesWire(...)` post-fetch, which is
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
