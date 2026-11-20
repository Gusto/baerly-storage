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
 * compactor, log-walk, snapshot, validator or tree import, and its own UTF-8
 * byte comparator. `tests/unit/tree-oracle-logical.test.ts` cross-checks it
 * against production where production has the same rule:
 *
 * - `compareUtf8` against `compareDocIds`: equal results on valid and
 *   near-pair IDs.
 * - The fold against `foldLogEntriesOnto`: the same row set, ignoring row and
 *   property order, or the same error code, over generated valid entries plus
 *   foreign and NFD-alias collection entries. It has no folded seq to compare.
 * - The fold against `compact()` on `MemoryStorage`, with no ceilings, run to
 *   a target and then onto that snapshot to the tail: the same row set and
 *   `log_seq_start`, or the same error code. Row order is not compared,
 *   because the snapshot is in UTF-16 order, nor are bytes.
 * - The `_id` domain against `assertSnapshotDocId` (accept and refuse agree;
 *   the codes differ by design), and the byte cap against
 *   `assertDocumentSize` at the boundary.
 *
 * Not cross-checked, because production does not share the rule: corrupt
 * candidates (production skips an `I`/`U` without `after`), accessor and
 * array-hole refusal, and the read oracle. No production point or range read
 * by `_id` exists to compare against, so reads are checked only against the
 * folded rows and `compareDocIds`.
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
 * row, as in the production folds. An in-range entry whose `collection` is
 * byte-different from the folded one but equal under NFC throws
 * `BaerlyError{code:"InvalidConfig"}`, restating `isOwnCollection`: R2 stores
 * canonically-equivalent keys as one object, so the entry may be this
 * collection's, and neither skipping nor applying it is safe.
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
 * Only the surviving mutation per `_id` is validated, after the fold, so a
 * later entry can repair an earlier corrupt one and a stored violation never
 * wedges the fold. An `I`/`U` without
 * `after` and an entry with an unknown `op` are corrupt candidates: they
 * replace the row like any write, and throw only if nothing later in range
 * supersedes them. A violation by a survivor throws
 * `BaerlyError{code:"InvalidResponse"}` naming the seq (or `base`) and the
 * JSON-escaped `_id`. The rules are restated here rather than imported, so the oracle stays
 * independent of the kernel validators (`assertSnapshotDocId` in
 * `packages/server/src/snapshot-doc-id.ts`, `assertDocumentSize`):
 *
 * - The `_id` is a Unicode scalar string (no unpaired surrogate), non-empty,
 *   at most {@link DOC_ID_MAX_UTF8_BYTES} UTF-8 bytes, with no `/`, not `.`
 *   or `..`, no C0, DEL or C1 control character, and no leading `_`.
 * - The body is a plain non-array object whose own `_id` equals the row's.
 * - Every value is a string, finite number, boolean, array or plain object:
 *   no `null`, `undefined`, function, symbol, bigint, accessor property or
 *   array hole.
 * - The body's canonical bytes are at most {@link MAX_DOCUMENT_BYTES}.
 *
 * An entry with no string `doc_id` names no row, so no later entry can
 * supersede it. The oracle skips it, as both production folds do: refusing
 * it would wedge the fold permanently, which is worse than ignoring a
 * mutation that addresses nothing. Misuse of the oracle itself (a gap, a
 * duplicate seq, `targetSeq < baseSeq`) throws a plain `Error`.
 *
 * Output rows are fresh deep copies with properties in canonical order (array
 * indices ascending, then other names in UTF-16 code-unit order), and the
 * result `Map` iterates in `utf8-scalar-v1` order. Neither input bodies nor
 * the base map's or bodies' property insertion order can leak into the
 * result. Reads return fresh copies too.
 *
 * ## Mutant seam
 *
 * {@link readPointMutant} and {@link readRangeMutant} do the same for the
 * read oracle, with the variants in {@link LOGICAL_READ_MUTANTS}: a `gt`/`gte`
 * swap, an `lt`/`lte` swap, and a point miss that returns the next row.
 *
 * {@link foldLogicalMutant} runs the same fold with one single-defect
 * variant from {@link LOGICAL_FOLD_MUTANTS}: the seven fast-check variants,
 * with "skip first/last mutation" split into two, plus two the list misses:
 * `absent-delete-creates-row` (the only one the absent-delete property can
 * catch) and `array-order-not-seq-order` (applies entries in input array
 * order instead of seq order). It exists so the
 * test suite can prove each property goes red; nothing else should call it.
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
  "array-order-not-seq-order",
  "delete-as-noop",
  "absent-delete-creates-row",
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

/** The single-defect read variants the test suite must catch. */
export const LOGICAL_READ_MUTANTS = [
  "gt-gte-swap",
  "lt-lte-swap",
  "point-miss-returns-successor",
] as const;

export type LogicalReadMutant = (typeof LOGICAL_READ_MUTANTS)[number];

/** The row with this `_id`, as a fresh copy, or `undefined`. */
export const readPoint = (view: LogicalView, id: string): DocumentData | undefined =>
  pointWith(view, id, undefined);

/** {@link readPoint} with one deliberate defect. Test-only mutant seam. */
export const readPointMutant = (
  view: LogicalView,
  id: string,
  mutant: LogicalReadMutant,
): DocumentData | undefined => pointWith(view, id, mutant);

const pointWith = (
  view: LogicalView,
  id: string,
  mutant: LogicalReadMutant | undefined,
): DocumentData | undefined => {
  const body = view.rows.get(id);
  if (body !== undefined) {
    return copyDocument(body);
  }
  if (mutant === "point-miss-returns-successor") {
    return readScan(view).find((row) => compareUtf8(row["_id"] as string, id) > 0);
  }
  return undefined;
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
export const readRange = (view: LogicalView, range: LogicalRange): DocumentData[] =>
  rangeWith(view, range, undefined);

/** {@link readRange} with one deliberate defect. Test-only mutant seam. */
export const readRangeMutant = (
  view: LogicalView,
  range: LogicalRange,
  mutant: LogicalReadMutant,
): DocumentData[] => rangeWith(view, range, mutant);

const rangeWith = (
  view: LogicalView,
  given: LogicalRange,
  mutant: LogicalReadMutant | undefined,
): DocumentData[] => {
  let range = given;
  if (mutant === "gt-gte-swap") {
    range = { ...given, gt: given.gte, gte: given.gt };
  }
  if (mutant === "lt-lte-swap") {
    range = { ...given, lt: given.lte, lte: given.lt };
  }
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

/** Per-`_id` UTF-8 byte ceiling (restates the kernel's 256-byte `_id` ceiling). */
export const DOC_ID_MAX_UTF8_BYTES = 256;

/** Canonical-byte ceiling for one row: 1 MiB (`MAX_DOCUMENT_BYTES` in `packages/protocol/src/constants.ts`). */
export const MAX_DOCUMENT_BYTES = 1_048_576;

/** A row's current candidate: a body, or a corrupt write that throws if it survives. */
type LiveRow =
  | { readonly body: DocumentData; readonly origin: string }
  | { readonly corrupt: string; readonly origin: string };

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
  if (mutant === "array-order-not-seq-order") {
    seqs.splice(0, seqs.length, ...entries.map((e) => e.seq).filter((seq) => seqs.includes(seq)));
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
    if (!isOwnCollection(entry.collection, collection, seq)) {
      continue;
    }
    const id: unknown = entry.doc_id;
    if (typeof id !== "string") {
      continue;
    }
    const origin = `seq ${seq}`;
    const op: string = entry.op;
    if (op === "D") {
      if (mutant === "absent-delete-creates-row" && !live.has(id)) {
        live.set(id, { body: { _id: id }, origin });
      } else if (mutant !== "delete-as-noop") {
        live.delete(id);
      }
      continue;
    }
    if (mutant === "first-write-wins" && writtenThisFold.has(id)) {
      continue;
    }
    writtenThisFold.add(id);
    if (op !== "I" && op !== "U") {
      live.set(id, { corrupt: `has unknown op ${JSON.stringify(op)}`, origin });
    } else if (entry.after === undefined) {
      live.set(id, { corrupt: `is an ${op} entry with no after post-image`, origin });
    } else {
      const prior = live.get(id);
      const body =
        mutant === "merge-instead-of-replace" && prior !== undefined && "body" in prior
          ? { ...prior.body, ...entry.after }
          : entry.after;
      live.set(id, { body, origin });
    }
  }

  const survivors = new Map<string, DocumentData>();
  for (const [id, row] of live) {
    if ("corrupt" in row) {
      throw domainError(row.origin, id, row.corrupt);
    }
    assertSurvivor(id, row.body, row.origin);
    survivors.set(id, row.body);
  }
  const rows = new Map<string, DocumentData>();
  for (const id of [...survivors.keys()].toSorted(compareUtf8)) {
    const body = survivors.get(id)!;
    rows.set(id, mutant === "aliased-bodies" ? body : copyDocument(body));
  }
  return {
    collection,
    foldedSeq: mutant === "wrong-folded-seq" ? targetSeq - 1 : targetSeq,
    rows,
  };
};

/** Exact match is own; NFC-equal but byte-different is refused; anything else is foreign. */
const isOwnCollection = (stored: unknown, expected: string, seq: number): boolean => {
  if (stored === expected) {
    return true;
  }
  if (typeof stored === "string" && stored.normalize("NFC") === expected.normalize("NFC")) {
    throw new BaerlyError(
      "InvalidConfig",
      `logical oracle: seq ${seq} names collection ${JSON.stringify(stored)}, canonically equivalent to ${JSON.stringify(expected)}`,
    );
  }
  return false;
};

const isSeq = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

const domainError = (origin: number | string, id: unknown, problem: string): BaerlyError =>
  new BaerlyError(
    "InvalidResponse",
    `logical oracle: ${typeof origin === "number" ? `seq ${origin}` : origin} _id ${JSON.stringify(id)} ${problem}`,
  );

const docIdProblem = (id: string): string | undefined => {
  if (!id.isWellFormed()) {
    return "is not a Unicode scalar string";
  }
  if (id.length === 0) {
    return "is empty";
  }
  if (id === "." || id === "..") {
    return 'is "." or ".."';
  }
  if (id.startsWith("_")) {
    return 'begins with "_"';
  }
  for (const char of id) {
    const point = char.codePointAt(0)!;
    if (char === "/") {
      return 'contains "/"';
    }
    if (point <= 0x1f || (point >= 0x7f && point <= 0x9f)) {
      return "contains a control character";
    }
  }
  if (utf8.encode(id).length > DOC_ID_MAX_UTF8_BYTES) {
    return `is over ${DOC_ID_MAX_UTF8_BYTES} UTF-8 bytes`;
  }
  return undefined;
};

const assertSurvivor = (id: string, body: DocumentData, origin: string): void => {
  const idProblem = docIdProblem(id);
  if (idProblem !== undefined) {
    throw domainError(origin, id, idProblem);
  }
  if (!isPlainObject(body)) {
    throw domainError(origin, id, "has a body that is not a JSON object");
  }
  if (body["_id"] !== id) {
    throw domainError(origin, id, `has a body whose _id is ${JSON.stringify(body["_id"])}`);
  }
  assertDocumentValue(body, origin, id);
  const bytes = utf8.encode(JSON.stringify(copyDocument(body))).length;
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw domainError(origin, id, `has ${bytes} canonical bytes, over ${MAX_DOCUMENT_BYTES}`);
  }
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
    for (let index = 0; index < value.length; index++) {
      assertOwnDataProperty(value, String(index), origin, id);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const key of Object.keys(value)) {
      assertOwnDataProperty(value, key, origin, id);
    }
    return;
  }
  throw domainError(origin, id, `holds a ${value === null ? "null" : typeof value} value`);
};

/** Check a property's value without running a getter: accessors and holes are refused. */
const assertOwnDataProperty = (
  container: object,
  key: string,
  origin: string,
  id: string,
): void => {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined) {
    throw domainError(origin, id, `holds an array hole at index ${key}`);
  }
  if (!("value" in descriptor)) {
    throw domainError(origin, id, `holds an accessor property ${JSON.stringify(key)}`);
  }
  assertDocumentValue(descriptor.value, origin, id);
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
