/**
 * Logical reference fold and read oracle for the prolly-tree prototype.
 *
 * Given a base row set and a run of `LogEntry` records, {@link foldLogical}
 * folds a contiguous seq prefix and returns the rows a reader must observe,
 * keyed by `_id`, plus the folded seq. {@link readPoint}, {@link readRange}
 * and {@link readScan} answer reads over that result in `utf8-scalar-v1`
 * order. A tree fold, publish or reader is correct when its observable rows
 * equal this oracle's on the same inputs.
 *
 * The oracle is deliberately naive and shares no code with the kernel: no
 * compactor, log-walk, snapshot or tree import, and its own UTF-8 byte
 * comparator. `tests/unit/tree-oracle-logical.test.ts` checks that comparator
 * against `compareDocIds`, and the fold against the production folds
 * (`foldLogEntriesOnto` and `compact()`), on the same inputs.
 *
 * ## Seq conventions
 *
 * Log slots are dense integers starting at 0, one `LogEntry` per
 * `log/<seq>.json` ([sync-protocol](../../docs/spec/sync-protocol.md)
 * invariants 4 and 5). `current.json.log_seq_start` is the exclusive end of
 * the folded prefix: the base holds every entry with `seq < log_seq_start`,
 * and the live tail starts at `log_seq_start`.
 *
 * A fold from floor `baseSeq` to `targetSeq` applies exactly the entries with
 * `baseSeq <= seq < targetSeq`, in seq order, and its folded seq is
 * `targetSeq`. That value is the next `log_seq_start`, which is what the
 * compactor publishes (`foldEnd`, the snapshot's `max_seq`,
 * `logSeqStartAfter`). A reader's view at true tail `tail` (its first 404)
 * is the same fold with `targetSeq = tail`. Every seq in
 * `[baseSeq, targetSeq)` must be present: a gap is a protocol violation, not
 * a no-op. Entries outside the range are ignored. An entry for another
 * collection occupies its slot, counts toward the folded seq and changes no
 * row, as in the production folds.
 *
 * Two mutants are defined against these conventions:
 *
 * - **Target-inclusive bound** (`target-inclusive-bound`) reads `targetSeq`
 *   as the last seq to fold (`seq <= targetSeq`). It applies the entry at
 *   `targetSeq` when one exists and still reports `foldedSeq = targetSeq`,
 *   so that entry is both in the base and in the reader's tail
 *   `[targetSeq, tail)`. A replace is idempotent, so base plus tail overlay
 *   can hide the defect; only the fold result alone exposes it.
 * - **Wrong folded seq** (`wrong-folded-seq`) applies the right entries but
 *   reports `targetSeq - 1`, the seq of the last folded entry ("folded
 *   through"), instead of the first unfolded slot. Published as
 *   `log_seq_start`, it puts the last folded entry back in the tail, and on
 *   an empty fold it lowers the floor below `baseSeq` (sync-protocol
 *   invariant 12: the floor is monotone).
 *
 * ## Fold semantics
 *
 * `I` and `U` replace the row with the complete post-image `after`; `D`
 * removes it, and a delete of an absent `_id` changes nothing
 * ([log-entry-shape](../../docs/spec/log-entry-shape.md): `after` is always a
 * complete post-image). Per `_id`, the entry with the highest seq in range
 * wins.
 *
 * Only surviving rows are validated, after the fold, so a later entry can
 * repair an earlier corrupt one. A
 * survivor's `_id` must be a well-formed Unicode string equal to its body's
 * own `_id`, and its body must be a non-array object holding only strings,
 * finite numbers, booleans, arrays and objects (no `null`). A violation
 * throws `BaerlyError{code:"InvalidResponse"}` naming the seq (or `base`) and
 * the JSON-escaped `_id`. An `I`/`U` without `after`, an unknown `op`, or a
 * non-string `doc_id` throws the same code. Misuse of the oracle itself (a
 * gap, a duplicate seq, `targetSeq < baseSeq`) throws a plain `Error`.
 *
 * Output rows are fresh deep copies with properties in canonical order (array
 * indices ascending, then other names in UTF-16 code-unit order), and the
 * result `Map` iterates in `utf8-scalar-v1` order. Neither input bodies nor
 * the base map's or bodies' property insertion order can leak into the
 * result. Reads return fresh copies too.
 *
 * ## Mutant seam
 *
 * {@link foldLogicalMutant} runs the same fold with one single-defect
 * variant from {@link LOGICAL_FOLD_MUTANTS}: the seven fast-check variants,
 * with "skip first/last mutation" split into two. It exists so the test
 * suite can prove each property goes red; nothing else should call it.
 */

import {
  BaerlyError,
  type DocumentData,
  type DocumentValue,
  type LogEntry,
} from "@baerly/protocol";

/** Input to {@link foldLogical}. */
export interface LogicalFoldInput {
  /** The collection whose log this is. Entries for another collection change no row. */
  readonly collection: string;
  /** Rows covering every seq below `baseSeq`, keyed by `_id`. Not modified. */
  readonly base: ReadonlyMap<string, DocumentData>;
  /** The base's `log_seq_start`: the first seq the fold may apply. */
  readonly baseSeq: number;
  /** Log entries in any array order; each sits at its own `seq`. Not modified. */
  readonly entries: readonly LogEntry[];
  /** Exclusive end of the fold: the first seq left unapplied. */
  readonly targetSeq: number;
}

/** The rows a reader observes after a fold. */
export interface LogicalView {
  readonly collection: string;
  /** The new `log_seq_start`: every seq below it is folded in. */
  readonly foldedSeq: number;
  /** Live rows, keyed by `_id`, iterating in `utf8-scalar-v1` order. */
  readonly rows: ReadonlyMap<string, DocumentData>;
}

/** The single-defect variants the test suite must catch. */
export const LOGICAL_FOLD_MUTANTS = [
  "target-inclusive-bound",
  "skip-first-mutation",
  "skip-last-mutation",
  "first-write-wins",
  "delete-as-noop",
  "merge-instead-of-replace",
  "wrong-folded-seq",
  "aliased-bodies",
] as const;

export type LogicalFoldMutant = (typeof LOGICAL_FOLD_MUTANTS)[number];

/** Fold `[baseSeq, targetSeq)` of `entries` onto `base`. */
export const foldLogical = (input: LogicalFoldInput): LogicalView => foldWith(input, undefined);

/** {@link foldLogical} with one deliberate defect. Test-only mutant seam. */
export const foldLogicalMutant = (
  input: LogicalFoldInput,
  mutant: LogicalFoldMutant,
): LogicalView => foldWith(input, mutant);

/** The row with this `_id`, as a fresh copy, or `undefined`. */
export const readPoint = (view: LogicalView, id: string): DocumentData | undefined => {
  const body = view.rows.get(id);
  return body === undefined ? undefined : copyDocument(body);
};

/**
 * Bounds of a range read, compared in `utf8-scalar-v1` order. At most one
 * lower bound (`gt` or `gte`) and one upper bound (`lt` or `lte`); an absent
 * side is unbounded.
 */
export interface LogicalRange {
  readonly gt?: string;
  readonly gte?: string;
  readonly lt?: string;
  readonly lte?: string;
}

/** Rows whose `_id` lies within `range`, in `utf8-scalar-v1` order, as fresh copies. */
export const readRange = (view: LogicalView, range: LogicalRange): DocumentData[] => {
  if (range.gt !== undefined && range.gte !== undefined) {
    throw new Error("readRange: pass at most one of gt / gte");
  }
  if (range.lt !== undefined && range.lte !== undefined) {
    throw new Error("readRange: pass at most one of lt / lte");
  }
  for (const bound of [range.gt, range.gte, range.lt, range.lte]) {
    if (bound !== undefined && !bound.isWellFormed()) {
      throw new Error(`readRange: bound ${JSON.stringify(bound)} is not a scalar string`);
    }
  }
  const inRange = (id: string): boolean =>
    (range.gt === undefined || compareUtf8(id, range.gt) > 0) &&
    (range.gte === undefined || compareUtf8(id, range.gte) >= 0) &&
    (range.lt === undefined || compareUtf8(id, range.lt) < 0) &&
    (range.lte === undefined || compareUtf8(id, range.lte) <= 0);
  return readScan(view).filter((body) => inRange(body["_id"] as string));
};

/** Every row in `utf8-scalar-v1` order, as fresh copies. */
export const readScan = (view: LogicalView): DocumentData[] =>
  [...view.rows.keys()].toSorted(compareUtf8).map((id) => copyDocument(view.rows.get(id)!));

/**
 * `utf8-scalar-v1`: compare the UTF-8 byte sequences lexicographically, a
 * proper prefix first. Returns `-1`, `0` or `1`. Both arguments must be
 * well-formed (an encoder would map a lone surrogate to U+FFFD).
 */
export const compareUtf8 = (left: string, right: string): number => {
  const a = utf8.encode(left);
  const b = utf8.encode(right);
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) {
      return a[i]! < b[i]! ? -1 : 1;
    }
  }
  if (a.length === b.length) {
    return 0;
  }
  return a.length < b.length ? -1 : 1;
};

const utf8 = new TextEncoder();

interface LiveRow {
  readonly body: DocumentData;
  /** Where the surviving body came from, for error messages. */
  readonly origin: string;
}

const foldWith = (input: LogicalFoldInput, mutant: LogicalFoldMutant | undefined): LogicalView => {
  const { collection, base, baseSeq, entries, targetSeq } = input;
  if (!isSeq(baseSeq) || !isSeq(targetSeq) || targetSeq < baseSeq) {
    throw new Error(
      `foldLogical: need integers 0 <= baseSeq <= targetSeq, got ${baseSeq}, ${targetSeq}`,
    );
  }
  const bySeq = new Map<number, LogEntry>();
  for (const entry of entries) {
    if (!isSeq(entry.seq)) {
      throw new Error(`foldLogical: entry seq ${String(entry.seq)} is not a non-negative integer`);
    }
    if (bySeq.has(entry.seq)) {
      throw new Error(`foldLogical: two entries at seq ${entry.seq}`);
    }
    bySeq.set(entry.seq, entry);
  }

  const seqs: number[] = [];
  for (let seq = baseSeq; seq < targetSeq; seq++) {
    if (!bySeq.has(seq)) {
      throw new Error(`foldLogical: no entry at seq ${seq} inside [${baseSeq}, ${targetSeq})`);
    }
    seqs.push(seq);
  }
  if (mutant === "target-inclusive-bound" && bySeq.has(targetSeq)) {
    seqs.push(targetSeq);
  }
  if (mutant === "skip-first-mutation") {
    seqs.shift();
  }
  if (mutant === "skip-last-mutation") {
    seqs.pop();
  }

  const live = new Map<string, LiveRow>();
  for (const [id, body] of base) {
    live.set(id, { body, origin: "base" });
  }
  const writtenThisFold = new Set<string>();
  for (const seq of seqs) {
    const entry = bySeq.get(seq)!;
    if (entry.collection !== collection) {
      continue;
    }
    const id: unknown = entry.doc_id;
    if (typeof id !== "string") {
      throw domainError(seq, id, "has no string doc_id");
    }
    switch (entry.op) {
      case "I":
      case "U": {
        if (entry.after === undefined) {
          throw domainError(seq, id, `is an ${entry.op} entry with no after post-image`);
        }
        if (mutant === "first-write-wins" && writtenThisFold.has(id)) {
          break;
        }
        writtenThisFold.add(id);
        const prior = live.get(id);
        const body =
          mutant === "merge-instead-of-replace" && prior !== undefined
            ? { ...prior.body, ...entry.after }
            : entry.after;
        live.set(id, { body, origin: `seq ${seq}` });
        break;
      }
      case "D": {
        if (mutant !== "delete-as-noop") {
          live.delete(id);
        }
        break;
      }
      default: {
        throw domainError(seq, id, `has unknown op ${JSON.stringify(entry.op)}`);
      }
    }
  }

  for (const [id, row] of live) {
    assertSurvivor(id, row);
  }
  const rows = new Map<string, DocumentData>();
  for (const id of [...live.keys()].toSorted(compareUtf8)) {
    const { body } = live.get(id)!;
    rows.set(id, mutant === "aliased-bodies" ? body : copyDocument(body));
  }
  return {
    collection,
    foldedSeq: mutant === "wrong-folded-seq" ? targetSeq - 1 : targetSeq,
    rows,
  };
};

const isSeq = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const domainError = (origin: number | string, id: unknown, problem: string): BaerlyError =>
  new BaerlyError(
    "InvalidResponse",
    `logical oracle: ${typeof origin === "number" ? `seq ${origin}` : origin} _id ${JSON.stringify(id)} ${problem}`,
  );

const assertSurvivor = (id: string, { body, origin }: LiveRow): void => {
  if (!id.isWellFormed()) {
    throw domainError(origin, id, "is not a Unicode scalar string");
  }
  if (!isPlainObject(body)) {
    throw domainError(origin, id, "has a body that is not a JSON object");
  }
  if (body["_id"] !== id) {
    throw domainError(origin, id, `has a body whose _id is ${JSON.stringify(body["_id"])}`);
  }
  assertDocumentValue(body, origin, id);
};

const assertDocumentValue = (value: unknown, origin: string, id: string): void => {
  if (typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw domainError(origin, id, "holds a non-finite number");
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertDocumentValue(item, origin, id);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      assertDocumentValue(value[key], origin, id);
    }
    return;
  }
  throw domainError(origin, id, `holds a ${value === null ? "null" : typeof value} value`);
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Deep copy with properties inserted in canonical order. Input is already validated. */
const copyDocument = (body: DocumentData): DocumentData => copyValue(body) as DocumentData;

const copyValue = (value: DocumentValue): DocumentValue => {
  if (Array.isArray(value)) {
    return value.map(copyValue);
  }
  if (typeof value === "object") {
    const out: DocumentData = {};
    // Default sort is UTF-16 code-unit order; inserting in that order makes
    // the engine list array-index names first, ascending. `defineProperty`
    // keeps a `__proto__` key an own property.
    for (const key of Object.keys(value).toSorted()) {
      Object.defineProperty(out, key, {
        value: copyValue(value[key]!),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  }
  return value;
};
