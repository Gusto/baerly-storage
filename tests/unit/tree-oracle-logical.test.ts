/**
 * Qualifies the logical reference oracle (`tests/fixtures/tree-oracle-logical.ts`).
 *
 * Three layers: properties of the fold and reads, a cross-check against the
 * two production folds on the same inputs (`foldLogEntriesOnto` and an
 * in-memory `compact()`), and a `mutation` block that runs each property
 * against the oracle's single-defect variants and requires red.
 */

import { fc, test as fcTest } from "@fast-check/vitest";
import {
  assertDocumentSize,
  BaerlyError,
  type DocumentData,
  encodeJsonBytes,
  type LogEntry,
  logObjectKey,
  MAX_DOCUMENT_BYTES as PRODUCTION_MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_DEPTH as PRODUCTION_MAX_DOCUMENT_DEPTH,
  MemoryStorage,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import {
  compactInternal,
  type InternalCompactOptions,
} from "../../packages/server/src/compactor.ts";
import { foldLogEntriesOnto } from "../../packages/server/src/log-walk.ts";
import { assertSnapshotDocId, compareDocIds } from "../../packages/server/src/snapshot-doc-id.ts";
import { loadSnapshotAsMap } from "../../packages/server/src/snapshot.ts";
import { provisionCollection } from "../fixtures/log-state.ts";
import {
  DOC_ID_MAX_UTF8_BYTES as ARBITRARY_DOC_ID_MAX_UTF8_BYTES,
  docIdNearPairArb,
  invalidDocIdArb,
  validDocIdArb,
} from "../fixtures/scalar-doc-id-arbitraries.ts";
import {
  compareUtf8,
  DOC_ID_MAX_UTF8_BYTES,
  foldLogical,
  foldLogicalMutant,
  LOGICAL_FOLD_MUTANTS,
  MAX_DOCUMENT_BYTES,
  MAX_DOCUMENT_DEPTH,
  type LogicalFoldInput,
  type LogicalFoldMutant,
  type LogicalRange,
  type LogicalView,
  LOGICAL_READ_MUTANTS,
  type LogicalReadMutant,
  readPoint,
  readPointMutant,
  readRange,
  readRangeMutant,
  readScan,
} from "../fixtures/tree-oracle-logical.ts";

type Fold = (input: LogicalFoldInput) => LogicalView;

const COLLECTION = "caf\u00e9";
/** NFD spelling of {@link COLLECTION}: canonically equivalent, byte-different. */
const ALIAS_COLLECTION = "cafe\u0301";
const PREFIX = `app/t/tenant/x/manifests/${COLLECTION}`;
const CURRENT_JSON_KEY = `${PREFIX}/current.json`;

// U+FFFD vs U+10000 is where UTF-16 order and `utf8-scalar-v1` disagree;
// "é" vs "é" are distinct IDs (no normalization).
const ID_POOL = ["a", "ab", "b", "é", "é", "�", "\u{10000}", "\u{1F600}"] as const;
/** Never written by any generated case. */
const ABSENT_ID = "never-written";

// ── Invariants and structured failures ─────────────────────────────────

type Invariant =
  | "empty-identity"
  | "last-write-wins"
  | "folded-seq"
  | "beyond-target-invisible"
  | "absent-delete-invisible"
  | "input-order-invisible"
  | "no-aliasing"
  | "prefix-split"
  | "scan-read"
  | "point-read"
  | "range-read"
  | "production-agreement";

type ReadInvariant = "scan-read" | "point-read" | "range-read";
/** The fold invariants with a mutation-block catcher. */
type FoldInvariant = Exclude<Invariant, "production-agreement" | ReadInvariant>;

/** A property failure, naming the invariant and the first differing `_id`. */
class Violation extends Error {
  readonly invariant: Invariant;

  constructor(invariant: Invariant, detail: string) {
    super(`${invariant}: ${detail}`);
    this.invariant = invariant;
  }
}

/**
 * The JSON text of a value. Property order counts: a row must read back
 * in the writer's key order, as the production folds return it.
 */
const stable = (value: unknown): string => JSON.stringify(value) ?? "undefined";

const sortedRows = (rows: ReadonlyMap<string, DocumentData>): [string, DocumentData][] =>
  [...rows].toSorted(([a], [b]) => compareDocIds(a, b));

const expectRows = (
  invariant: Invariant,
  actual: ReadonlyMap<string, DocumentData>,
  expected: ReadonlyMap<string, DocumentData>,
  where = "",
): void => {
  const ids = [...new Set([...actual.keys(), ...expected.keys()])].toSorted(compareDocIds);
  for (const id of ids) {
    const got = actual.get(id);
    const want = expected.get(id);
    if ((got === undefined) !== (want === undefined) || stable(got) !== stable(want)) {
      throw new Violation(
        invariant,
        `${where}first differing _id ${JSON.stringify(id)}: got ${stable(got)}, want ${stable(want)}`,
      );
    }
  }
};

const expectSeq = (invariant: Invariant, actual: number, expected: number, where = ""): void => {
  if (actual !== expected) {
    throw new Violation(invariant, `${where}folded seq ${actual}, want ${expected}`);
  }
};

// ── Case generation ────────────────────────────────────────────────────

type Kind = "I" | "U" | "D" | "foreign" | "alias";

interface Op {
  readonly kind: Kind;
  readonly id: string;
  readonly fields: Record<string, unknown>;
}

interface FoldCase {
  readonly base: readonly (readonly [string, Record<string, unknown>])[];
  readonly baseSeq: number;
  readonly ops: readonly Op[];
  /** Picks `targetSeq` inside `[baseSeq, baseSeq + ops.length]`. */
  readonly cut: number;
  /** Spare choice for properties that need a second position. */
  readonly pick: number;
  /** A permutation of `ops` indices: the order `entries` is passed in. */
  readonly entryOrder: readonly number[];
}

const idArb = fc.constantFrom(...ID_POOL);
const leafArb = fc.oneof(
  fc.constant(null),
  fc.integer({ min: -5, max: 5 }),
  fc.string({ maxLength: 3 }),
  fc.boolean(),
);
const valueArb = fc.oneof(
  leafArb,
  fc.array(leafArb, { maxLength: 3 }),
  fc.record({ x: leafArb, y: leafArb }, { requiredKeys: [] }),
);
// "1" is an array-index name, which canonical property order lists first.
const fieldsArb: fc.Arbitrary<Record<string, unknown>> = fc.record(
  { a: valueArb, b: valueArb, c: valueArb, "1": valueArb },
  { requiredKeys: [] },
);
const opArb = (kind: fc.Arbitrary<Kind>): fc.Arbitrary<Op> =>
  fc.record({ kind, id: idArb, fields: fieldsArb });
const kindArb: fc.Arbitrary<Kind> = fc.oneof(
  { weight: 3, arbitrary: fc.constant("I" as const) },
  { weight: 3, arbitrary: fc.constant("U" as const) },
  { weight: 2, arbitrary: fc.constant("D" as const) },
  { weight: 1, arbitrary: fc.constant("foreign" as const) },
);
const baseArb = fc.uniqueArray(fc.tuple(idArb, fieldsArb), {
  selector: ([id]) => id,
  maxLength: ID_POOL.length,
});

const permutationArb = (length: number): fc.Arbitrary<number[]> => {
  const indices = Array.from({ length }, (_, i) => i);
  return fc.shuffledSubarray(indices, { minLength: length, maxLength: length });
};

const foldCaseArbWith = (kind: fc.Arbitrary<Kind>): fc.Arbitrary<FoldCase> =>
  fc
    .record({
      base: baseArb,
      baseSeq: fc.nat({ max: 20 }),
      ops: fc.array(opArb(kind), { maxLength: 24 }),
      cut: fc.nat(),
      pick: fc.nat(),
    })
    .chain((c) =>
      permutationArb(c.ops.length).map((entryOrder): FoldCase =>
        Object.assign({}, c, { entryOrder }),
      ),
    );

const foldCaseArb = foldCaseArbWith(kindArb);
/** Adds NFD-alias entries, which every fold must refuse with the same code. */
const crossCaseArb = foldCaseArbWith(
  fc.oneof(
    { weight: 12, arbitrary: kindArb },
    { weight: 1, arbitrary: fc.constant("alias" as const) },
  ),
);

const bodyOf = (id: string, fields: Record<string, unknown>): DocumentData =>
  ({ _id: id, ...structuredClone(fields) }) as DocumentData;

const entryOf = (op: Op, seq: number): LogEntry => ({
  lsn: `lsn-${seq}`,
  commit_ts: "2026-01-01T00:00:00.000Z",
  op: op.kind === "foreign" || op.kind === "alias" ? "I" : op.kind,
  collection: { foreign: "other", alias: ALIAS_COLLECTION }[op.kind as string] ?? COLLECTION,
  doc_id: op.id,
  session: "ssn001",
  seq,
  ...(op.kind === "D" ? {} : { after: bodyOf(op.id, op.fields) }),
});

/** Fresh objects on every call, so one check's mutation never reaches another. */
const inputOf = (c: FoldCase): LogicalFoldInput => ({
  collection: COLLECTION,
  base: new Map(c.base.map(([id, fields]) => [id, bodyOf(id, fields)])),
  baseSeq: c.baseSeq,
  entries: c.entryOrder.map((i) => entryOf(c.ops[i]!, c.baseSeq + i)),
  targetSeq: c.baseSeq + (c.cut % (c.ops.length + 1)),
});

/** Independent per-`_id` model: the highest seq in range decides the row. */
const lastWriteWinsModel = (input: LogicalFoldInput): Map<string, DocumentData> => {
  const latest = new Map<string, LogEntry>();
  for (const entry of input.entries) {
    const inRange = entry.seq >= input.baseSeq && entry.seq < input.targetSeq;
    if (inRange && entry.collection === input.collection) {
      const prior = latest.get(entry.doc_id);
      if (prior === undefined || entry.seq > prior.seq) {
        latest.set(entry.doc_id, entry);
      }
    }
  }
  const rows = new Map(input.base);
  for (const [id, entry] of latest) {
    if (entry.op === "D") {
      rows.delete(id);
    } else {
      rows.set(id, entry.after!);
    }
  }
  return rows;
};

// ── Property checks (throw a Violation on failure) ─────────────────────

const checkEmptyIdentity = (fold: Fold, c: FoldCase): void => {
  const input = { ...inputOf(c), targetSeq: c.baseSeq };
  const view = fold(input);
  expectRows("empty-identity", view.rows, input.base);
  expectSeq("empty-identity", view.foldedSeq, c.baseSeq);
};

const checkLastWriteWins = (fold: Fold, c: FoldCase): void => {
  const input = inputOf(c);
  expectRows("last-write-wins", fold(input).rows, lastWriteWinsModel(input));
};

const checkFoldedSeq = (fold: Fold, c: FoldCase): void => {
  const input = inputOf(c);
  expectSeq("folded-seq", fold(input).foldedSeq, input.targetSeq);
};

const checkBeyondTargetInvisible = (fold: Fold, c: FoldCase): void => {
  const input = inputOf(c);
  const withTail = fold(input);
  const withoutTail = fold({
    ...inputOf(c),
    entries: inputOf(c).entries.filter((entry) => entry.seq < input.targetSeq),
  });
  expectRows("beyond-target-invisible", withTail.rows, withoutTail.rows);
  expectSeq("beyond-target-invisible", withTail.foldedSeq, withoutTail.foldedSeq);
};

const checkAbsentDeleteInvisible = (fold: Fold, c: FoldCase): void => {
  const input = inputOf(c);
  const folded = input.targetSeq - c.baseSeq;
  const at = c.pick % (folded + 1);
  const ops = [
    ...c.ops.slice(0, at),
    { kind: "D", id: ABSENT_ID, fields: {} } as const,
    ...c.ops.slice(at),
  ];
  const withDelete = fold({
    ...input,
    entries: ops.map((op, i) => entryOf(op, c.baseSeq + i)),
    targetSeq: input.targetSeq + 1,
  });
  const without = fold(inputOf(c));
  expectRows("absent-delete-invisible", withDelete.rows, without.rows);
  expectSeq("absent-delete-invisible", withDelete.foldedSeq, without.foldedSeq + 1);
};

const checkPrefixSplit = (fold: Fold, c: FoldCase): void => {
  const input = inputOf(c);
  const split = c.baseSeq + (c.pick % (input.targetSeq - c.baseSeq + 1));
  const first = fold({ ...input, targetSeq: split });
  const second = fold({ ...input, base: first.rows, baseSeq: first.foldedSeq });
  const whole = fold(inputOf(c));
  const where = `split at seq ${split} of [${c.baseSeq}, ${input.targetSeq}): `;
  expectRows("prefix-split", second.rows, whole.rows, where);
  expectSeq("prefix-split", second.foldedSeq, whole.foldedSeq, where);
};

/** Overwrite every field except `_id`, recursing into arrays and objects. */
const scribble = (value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach(scribble);
    value.push("scribbled");
  } else if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key !== "_id") {
        scribble(record[key]);
        if (typeof record[key] !== "object" || record[key] === null) {
          record[key] = "scribbled";
        }
      }
    }
    record["scribbled"] = true;
  }
};

const inputImage = (input: LogicalFoldInput): string =>
  stable([sortedRows(input.base), input.entries]);

const checkNoAliasing = (fold: Fold, c: FoldCase): void => {
  const source = inputOf(c);
  const view = fold(source);
  const before = stable(sortedRows(view.rows));
  source.base.forEach(scribble);
  source.entries.forEach((entry) => scribble(entry.after));
  if (stable(sortedRows(view.rows)) !== before) {
    throw new Violation("no-aliasing", "mutating an input body after the fold changed the result");
  }
  const kept = inputOf(c);
  const image = inputImage(kept);
  fold(kept).rows.forEach(scribble);
  if (inputImage(kept) !== image) {
    throw new Violation("no-aliasing", "mutating a result body changed the fold's input");
  }
};

interface OrderCase {
  readonly base: FoldCase["base"];
  readonly baseOrder: readonly number[];
  /** One op per distinct `_id`, so their relative order cannot matter. */
  readonly ops: readonly Op[];
  readonly opOrder: readonly number[];
}

const orderCaseArb: fc.Arbitrary<OrderCase> = fc
  .tuple(
    baseArb,
    fc.uniqueArray(opArb(fc.constantFrom("I", "U", "D")), {
      selector: (op) => op.id,
      maxLength: ID_POOL.length,
    }),
  )
  .chain(([base, ops]) =>
    fc.record({
      base: fc.constant(base),
      baseOrder: permutationArb(base.length),
      ops: fc.constant(ops),
      opOrder: permutationArb(ops.length),
    }),
  );

const reverseProperties = (fields: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(fields).toReversed());

const checkInputOrderInvisible = (fold: Fold, c: OrderCase): void => {
  const run = (base: FoldCase["base"], ops: readonly Op[], reorder: boolean) => {
    const shape = (id: string, fields: Record<string, unknown>): DocumentData => {
      const body = bodyOf(id, fields);
      return reorder ? (reverseProperties(body) as DocumentData) : body;
    };
    return fold({
      collection: COLLECTION,
      base: new Map(base.map(([id, fields]) => [id, shape(id, fields)])),
      baseSeq: 0,
      entries: ops.map((op, seq) => ({
        ...entryOf(op, seq),
        ...(op.kind === "D" ? {} : { after: shape(op.id, op.fields) }),
      })),
      targetSeq: ops.length,
    }).rows;
  };
  // Base and log array order are invisible, and every row keeps its
  // post-image's property order: reversing each body's properties
  // reverses them in the output and changes nothing else.
  // Order-sensitive on purpose: map iteration order and property order.
  const expected = JSON.stringify(
    [...run(c.base, c.ops, false)].map(([id, row]) => [id, reverseProperties(row)]),
  );
  const permuted = JSON.stringify([
    ...run(
      c.baseOrder.map((i) => c.base[i]!),
      c.opOrder.map((i) => c.ops[i]!),
      true,
    ),
  ]);
  if (expected !== permuted) {
    throw new Violation(
      "input-order-invisible",
      `base or log order leaked, or property order was not kept: ${expected} vs ${permuted}`,
    );
  }
};

// ── Properties on the oracle ───────────────────────────────────────────

describe("logical fold properties", () => {
  fcTest.prop({ c: foldCaseArb })("empty fold is the identity", ({ c }) => {
    checkEmptyIdentity(foldLogical, c);
  });

  fcTest.prop({ c: foldCaseArb })("last write wins per _id", ({ c }) => {
    checkLastWriteWins(foldLogical, c);
  });

  fcTest.prop({ c: foldCaseArb })("the folded seq is the exclusive target", ({ c }) => {
    checkFoldedSeq(foldLogical, c);
  });

  fcTest.prop({ c: foldCaseArb })("entries at or past the target are invisible", ({ c }) => {
    checkBeyondTargetInvisible(foldLogical, c);
  });

  fcTest.prop({ c: foldCaseArb })("a delete of an absent _id is invisible", ({ c }) => {
    checkAbsentDeleteInvisible(foldLogical, c);
  });

  fcTest.prop({ c: orderCaseArb })(
    "base and independent-log order are invisible, and property order is kept",
    ({ c }) => {
      checkInputOrderInvisible(foldLogical, c);
    },
  );

  fcTest.prop({ c: foldCaseArb })("the fold aliases no input or result body", ({ c }) => {
    checkNoAliasing(foldLogical, c);
  });

  fcTest.prop({ c: foldCaseArb })("folding in two steps equals one fold", ({ c }) => {
    checkPrefixSplit(foldLogical, c);
  });

  test("a prefix-split failure names the split seq", () => {
    const c: FoldCase = {
      base: [],
      baseSeq: 3,
      ops: [
        { kind: "I", id: "a", fields: {} },
        { kind: "D", id: "a", fields: {} },
      ],
      cut: 2,
      pick: 1,
      entryOrder: [0, 1],
    };
    const fold: Fold = (input) => foldLogicalMutant(input, "skip-last-mutation");
    expect(() => checkPrefixSplit(fold, c)).toThrow(/^prefix-split: split at seq 4 of \[3, 5\): /);
  });

  test("an empty base and log fold to no rows", () => {
    const view = foldLogical({
      collection: COLLECTION,
      base: new Map(),
      baseSeq: 0,
      entries: [],
      targetSeq: 0,
    });
    expect([...view.rows]).toEqual([]);
    expect(view.foldedSeq).toBe(0);
  });
});

// ── Read oracle ────────────────────────────────────────────────────────

const boundArb = fc.constantFrom(...ID_POOL, ABSENT_ID);
const lowerArb: fc.Arbitrary<LogicalRange> = fc.oneof(
  fc.constant({}),
  boundArb.map((gt) => ({ gt })),
  boundArb.map((gte) => ({ gte })),
);
const upperArb: fc.Arbitrary<LogicalRange> = fc.oneof(
  fc.constant({}),
  boundArb.map((lt) => ({ lt })),
  boundArb.map((lte) => ({ lte })),
);
const rangeArb: fc.Arbitrary<LogicalRange> = fc
  .tuple(lowerArb, upperArb)
  .map(([lower, upper]) => Object.assign({}, lower, upper));

interface Reads {
  readonly point: (view: LogicalView, id: string) => DocumentData | undefined;
  readonly range: (view: LogicalView, range: LogicalRange) => DocumentData[];
  readonly scan: (view: LogicalView) => DocumentData[];
}

const ORACLE_READS: Reads = { point: readPoint, range: readRange, scan: readScan };

const mutantReads = (mutant: LogicalReadMutant): Reads => ({
  point: (view, id) => readPointMutant(view, id, mutant),
  range: (view, range) => readRangeMutant(view, range, mutant),
  scan: readScan,
});

const expectBodies = (
  invariant: ReadInvariant,
  actual: readonly (DocumentData | undefined)[],
  expected: readonly (DocumentData | undefined)[],
  where: string,
): void => {
  if (stable(actual) !== stable(expected)) {
    throw new Violation(invariant, `${where}: got ${stable(actual)}, want ${stable(expected)}`);
  }
};

const checkScanRead = (reads: Reads, c: FoldCase): void => {
  const view = foldLogical(inputOf(c));
  const scan = reads.scan(view);
  expectBodies(
    "scan-read",
    scan,
    sortedRows(view.rows).map(([, body]) => body),
    "scan",
  );
};

const checkPointRead = (reads: Reads, c: FoldCase): void => {
  const view = foldLogical(inputOf(c));
  for (const id of [...ID_POOL, ABSENT_ID]) {
    expectBodies(
      "point-read",
      [reads.point(view, id)],
      [view.rows.get(id)],
      `point ${JSON.stringify(id)}`,
    );
  }
};

const checkRangeRead = (reads: Reads, c: FoldCase, range: LogicalRange): void => {
  const view = foldLogical(inputOf(c));
  const inRange = (id: string): boolean =>
    (range.gt === undefined || compareDocIds(id, range.gt) > 0) &&
    (range.gte === undefined || compareDocIds(id, range.gte) >= 0) &&
    (range.lt === undefined || compareDocIds(id, range.lt) < 0) &&
    (range.lte === undefined || compareDocIds(id, range.lte) <= 0);
  const want = sortedRows(view.rows)
    .filter(([id]) => inRange(id))
    .map(([, body]) => body);
  expectBodies("range-read", reads.range(view, range), want, `range ${JSON.stringify(range)}`);
};

describe("logical read oracle", () => {
  fcTest.prop({ c: foldCaseArb })("scan returns every row in compareDocIds order", ({ c }) => {
    checkScanRead(ORACLE_READS, c);
  });

  fcTest.prop({ c: foldCaseArb })("point reads return the row or nothing", ({ c }) => {
    checkPointRead(ORACLE_READS, c);
  });

  fcTest.prop({ c: foldCaseArb, range: rangeArb })(
    "range reads return exactly the rows within the bounds",
    ({ c, range }) => {
      checkRangeRead(ORACLE_READS, c, range);
    },
  );

  fcTest.prop({ c: foldCaseArb })("reads return copies", ({ c }) => {
    const view = foldLogical(inputOf(c));
    const image = stable(sortedRows(view.rows));
    readScan(view).forEach(scribble);
    readRange(view, {}).forEach(scribble);
    for (const id of ID_POOL) {
      scribble(readPoint(view, id));
    }
    expect(stable(sortedRows(view.rows))).toBe(image);
  });

  test("scan order is utf8-scalar-v1, not UTF-16 code-unit order", () => {
    const view = foldLogical({
      collection: COLLECTION,
      base: new Map([
        ["\u{10000}", { _id: "\u{10000}" }],
        ["�", { _id: "�" }],
        ["a", { _id: "a" }],
      ]),
      baseSeq: 0,
      entries: [],
      targetSeq: 0,
    });
    expect(readScan(view).map((body) => body["_id"])).toEqual(["a", "�", "\u{10000}"]);
    expect([...view.rows.keys()]).toEqual(["a", "�", "\u{10000}"]);
  });

  test("a range with two lower or two upper bounds is refused", () => {
    const view = foldLogical({
      collection: COLLECTION,
      base: new Map(),
      baseSeq: 0,
      entries: [],
      targetSeq: 0,
    });
    expect(() => readRange(view, { gt: "a", gte: "a" })).toThrow(Error);
    expect(() => readRange(view, { lt: "a", lte: "a" })).toThrow(Error);
  });

  fcTest.prop({ a: validDocIdArb, b: validDocIdArb })(
    "compareUtf8 agrees with compareDocIds",
    ({ a, b }) => {
      expect(compareUtf8(a, b)).toBe(compareDocIds(a, b));
    },
  );

  fcTest.prop({ pair: docIdNearPairArb })(
    "compareUtf8 agrees with compareDocIds on near pairs",
    ({ pair }) => {
      expect(compareUtf8(pair.left, pair.right)).toBe(compareDocIds(pair.left, pair.right));
      expect(compareUtf8(pair.right, pair.left)).toBe(compareDocIds(pair.right, pair.left));
    },
  );
});

type Outcome<T> = { readonly value: T } | { readonly code: string };

const outcomeOf = <T>(action: () => T): Outcome<T> => {
  try {
    return { value: action() };
  } catch (error) {
    return { code: error instanceof BaerlyError ? error.code : String(error) };
  }
};

const asyncOutcomeOf = async <T>(action: () => Promise<T>): Promise<Outcome<T>> => {
  try {
    return { value: await action() };
  } catch (error) {
    return { code: error instanceof BaerlyError ? error.code : String(error) };
  }
};

/** Both folds refused with the same code, or both produced the same rows. */
const expectSameOutcome = (
  oracle: Outcome<ReadonlyMap<string, DocumentData>>,
  production: Outcome<ReadonlyMap<string, DocumentData>>,
): void => {
  if ("code" in oracle || "code" in production) {
    const code = (o: Outcome<unknown>): string => ("code" in o ? o.code : "no error");
    if (code(oracle) !== code(production)) {
      throw new Violation(
        "production-agreement",
        `oracle ${code(oracle)}, production ${code(production)}`,
      );
    }
    return;
  }
  expectRows("production-agreement", oracle.value, production.value);
};

// ── Domain and misuse ──────────────────────────────────────────────────

const entry = (seq: number, op: "I" | "U" | "D", id: string, after?: unknown): LogEntry =>
  ({
    lsn: `lsn-${seq}`,
    commit_ts: "2026-01-01T00:00:00.000Z",
    op,
    collection: COLLECTION,
    doc_id: id,
    session: "ssn001",
    seq,
    ...(after !== undefined && { after }),
  }) as LogEntry;

const unknownOp = (seq: number, id: string): LogEntry =>
  ({ ...entry(seq, "I", id, { _id: id }), op: "X" }) as unknown as LogEntry;

const foldEntries = (entries: readonly LogEntry[], targetSeq = entries.length): LogicalView =>
  foldLogical({ collection: COLLECTION, base: new Map(), baseSeq: 0, entries, targetSeq });

const codeOf = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof BaerlyError ? error.code : "not-a-BaerlyError";
  }
  return undefined;
};

describe("logical fold domain", () => {
  test("a gap, a duplicate seq or a target below the base is oracle misuse", () => {
    const gap = [entry(0, "I", "a", { _id: "a" }), entry(2, "I", "b", { _id: "b" })];
    expect(codeOf(() => foldEntries(gap, 3))).toBe("not-a-BaerlyError");
    const twice = [entry(0, "I", "a", { _id: "a" }), entry(0, "I", "b", { _id: "b" })];
    expect(codeOf(() => foldEntries(twice, 1))).toBe("not-a-BaerlyError");
    expect(
      codeOf(() =>
        foldLogical({
          collection: COLLECTION,
          base: new Map(),
          baseSeq: 2,
          entries: [],
          targetSeq: 1,
        }),
      ),
    ).toBe("not-a-BaerlyError");
  });

  test("a surviving row outside the document domain is InvalidResponse", () => {
    expect(codeOf(() => foldEntries([entry(0, "I", "a", { _id: "a", n: undefined })]))).toBe(
      "InvalidResponse",
    );
    expect(codeOf(() => foldEntries([entry(0, "I", "a", { _id: "b" })]))).toBe("InvalidResponse");
    expect(codeOf(() => foldEntries([entry(0, "I", "a\uD800", { _id: "a\uD800" })]))).toBe(
      "InvalidResponse",
    );
  });

  test.each([
    ["empty", ""],
    ["slash", "a/b"],
    ["dot", "."],
    ["dot-dot", ".."],
    ["C0 control", "a\u0001"],
    ["DEL", "a\u007f"],
    ["C1 control", "a\u0085"],
    ["leading underscore", "_a"],
    ["unpaired surrogate", "a\uDC00"],
    ["257 UTF-8 bytes", "a".repeat(DOC_ID_MAX_UTF8_BYTES + 1)],
    ["257 UTF-8 bytes, astral last", `${"a".repeat(DOC_ID_MAX_UTF8_BYTES - 3)}\u{1F600}`],
  ])("a surviving _id that breaks the ID domain (%s) is InvalidResponse", (_rule, id) => {
    expect(codeOf(() => foldEntries([entry(0, "I", id, { _id: id })]))).toBe("InvalidResponse");
  });

  test("a 256-byte _id and inner dots or underscores are in the ID domain", () => {
    for (const id of ["a".repeat(DOC_ID_MAX_UTF8_BYTES), "a.b", "a_", "...", "\u00a0"]) {
      expect(codeOf(() => foldEntries([entry(0, "I", id, { _id: id })]))).toBeUndefined();
    }
  });

  test.each([
    ["undefined", { _id: "a", v: undefined }],
    ["a function", { _id: "a", v: () => 1 }],
    ["a bigint", { _id: "a", v: 1n }],
    ["a symbol", { _id: "a", v: Symbol("s") }],
    ["a non-finite number", { _id: "a", v: Number.NaN }],
    ["a non-plain object", { _id: "a", v: new Date(0) }],
    // oxlint-disable-next-line no-sparse-arrays -- the hole is the case
    ["an array hole", { _id: "a", v: [1, , 2] }],
  ])("a surviving body holding %s is InvalidResponse", (_what, body) => {
    expect(codeOf(() => foldEntries([entry(0, "I", "a", body)]))).toBe("InvalidResponse");
  });

  const nestedDocument = (depth: number, kind: "object" | "array"): DocumentData => {
    const [open, close] = kind === "object" ? ['{"v":', "}"] : ["[", "]"];
    return JSON.parse(
      '{"_id":"a","v":' + open.repeat(depth - 1) + "true" + close.repeat(depth - 1) + "}",
    ) as DocumentData;
  };

  test.each(["object", "array"] as const)(
    "a surviving document of 100 %s levels fits; 101 is InvalidResponse",
    (kind) => {
      expect(
        codeOf(() => foldEntries([entry(0, "I", "a", nestedDocument(100, kind))])),
      ).toBeUndefined();
      expect(codeOf(() => foldEntries([entry(0, "I", "a", nestedDocument(101, kind))]))).toBe(
        "InvalidResponse",
      );
    },
  );

  test("a deeply nested stored document is InvalidResponse without overflowing the stack", () => {
    const body = nestedDocument(10_000, "object");
    expect(codeOf(() => foldEntries([entry(0, "I", "a", body)]))).toBe("InvalidResponse");
  });

  test("a later repair supersedes a deeply nested stored document", () => {
    const view = foldEntries([
      entry(0, "I", "a", nestedDocument(10_000, "object")),
      entry(1, "U", "a", { _id: "a", repaired: true }),
    ]);
    expect([...view.rows]).toEqual([["a", { _id: "a", repaired: true }]]);
  });

  test("an accessor property is refused without being called", () => {
    let calls = 0;
    const top = {
      _id: "a",
      get v() {
        calls++;
        return 1;
      },
    };
    const nested = {
      _id: "a",
      n: {
        get v() {
          calls++;
          return 1;
        },
      },
    };
    expect(codeOf(() => foldEntries([entry(0, "I", "a", top)]))).toBe("InvalidResponse");
    expect(codeOf(() => foldEntries([entry(0, "I", "a", nested)]))).toBe("InvalidResponse");
    expect(calls).toBe(0);
  });

  test("a body of exactly MAX_DOCUMENT_BYTES canonical bytes fits; one more is InvalidResponse", () => {
    const overhead = JSON.stringify({ _id: "a", s: "" }).length;
    const body = (bytes: number): DocumentData => ({ s: "x".repeat(bytes - overhead), _id: "a" });
    expect(
      codeOf(() => foldEntries([entry(0, "I", "a", body(MAX_DOCUMENT_BYTES))])),
    ).toBeUndefined();
    expect(codeOf(() => foldEntries([entry(0, "I", "a", body(MAX_DOCUMENT_BYTES + 1))]))).toBe(
      "InvalidResponse",
    );
    // A superseded oversized write does not wedge the fold.
    const repaired = foldEntries([
      entry(0, "I", "a", body(MAX_DOCUMENT_BYTES + 1)),
      entry(1, "U", "a", { _id: "a" }),
    ]);
    expect([...repaired.rows]).toEqual([["a", { _id: "a" }]]);
  });

  test("a surviving corrupt write is InvalidResponse, and it replaces the prior row", () => {
    expect(codeOf(() => foldEntries([entry(0, "U", "a")]))).toBe("InvalidResponse");
    expect(codeOf(() => foldEntries([entry(0, "I", "a", { _id: "a" }), entry(1, "U", "a")]))).toBe(
      "InvalidResponse",
    );
    expect(codeOf(() => foldEntries([unknownOp(0, "a")]))).toBe("InvalidResponse");
  });

  test("a later entry repairs a corrupt one, because only survivors are validated", () => {
    const view = foldEntries([
      entry(0, "I", "a", { _id: "a", n: undefined }),
      entry(1, "U", "a", { _id: "a", n: 1 }),
      entry(2, "I", "b", { _id: "x" }),
      entry(3, "D", "b"),
      entry(4, "U", "c"),
      entry(5, "I", "c", { _id: "c" }),
      unknownOp(6, "d"),
      entry(7, "D", "d"),
    ]);
    expect([...view.rows]).toEqual([
      ["a", { _id: "a", n: 1 }],
      ["c", { _id: "c" }],
    ]);
  });

  test("an entry with no string doc_id is skipped, as production skips it", () => {
    const entries = [
      entry(0, "I", "a", { _id: "a" }),
      { ...entry(1, "D", "a"), doc_id: undefined } as unknown as LogEntry,
    ];
    const view = foldEntries(entries);
    expect([...view.rows]).toEqual([["a", { _id: "a" }]]);
    expect(view.foldedSeq).toBe(2);
    const production = new Map<string, DocumentData>();
    foldLogEntriesOnto(production, entries, { collection: COLLECTION });
    expectSameOutcome({ value: view.rows }, { value: production });
  });

  test("another collection's entry fills its slot and changes no row", () => {
    const view = foldEntries([
      entry(0, "I", "a", { _id: "a", v: 1 }),
      { ...entry(1, "U", "a", { _id: "a", v: 2 }), collection: "other" },
    ]);
    expect([...view.rows]).toEqual([["a", { _id: "a", v: 1 }]]);
    expect(view.foldedSeq).toBe(2);
  });

  test("output properties keep the post-image's order", () => {
    const view = foldEntries([
      entry(0, "I", "a", { z: 1, _id: "a", 10: 0, 2: 0, b: { y: 1, x: 2 } }),
    ]);
    expect(JSON.stringify(view.rows.get("a"))).toBe(
      '{"2":0,"10":0,"z":1,"_id":"a","b":{"y":1,"x":2}}',
    );
  });
});

// ── Cross-check against the production folds ──────────────────────────

describe("logical fold agrees with production", () => {
  fcTest.prop({ c: crossCaseArb })("foldLogEntriesOnto (the read-path fold)", ({ c }) => {
    const input = inputOf(c);
    const inRange = inputOf(c)
      .entries.filter((e) => e.seq >= input.baseSeq && e.seq < input.targetSeq)
      .toSorted((a, b) => a.seq - b.seq);
    const production = outcomeOf(() => {
      const rows = new Map(input.base);
      foldLogEntriesOnto(rows, inRange, { collection: COLLECTION });
      return rows;
    });
    expectSameOutcome(
      outcomeOf(() => foldLogical(input).rows),
      production,
    );
  });

  const seededStorage = async (entries: readonly LogEntry[]): Promise<MemoryStorage> => {
    const storage = new MemoryStorage();
    await provisionCollection(storage, CURRENT_JSON_KEY);
    for (const logEntry of entries) {
      await storage.put(logObjectKey(PREFIX, logEntry.seq), encodeJsonBytes(logEntry));
    }
    return storage;
  };

  const compactTo = async (
    storage: MemoryStorage,
    maxEntriesPerRun: number,
  ): Promise<LogicalView> => {
    const options: InternalCompactOptions = { minEntriesToCompact: 0, maxEntriesPerRun };
    const result = await compactInternal({ storage, currentJsonKey: CURRENT_JSON_KEY }, options);
    expect(result.written).toBe(true);
    const rows = await loadSnapshotAsMap(storage, result.newSnapshotKey!, COLLECTION);
    return { collection: COLLECTION, foldedSeq: result.logSeqStartAfter, rows };
  };

  // MemoryStorage keeps this in-process; a run seeds a fresh log and folds it
  // twice, the second time onto the first snapshot as a non-empty base.
  fcTest.prop({ c: crossCaseArb }, { numRuns: 25 })(
    "compact(), folding to a target and then to the tail",
    async ({ c }) => {
      const entries = c.ops.map((op, seq) => entryOf(op, seq));
      const storage = await seededStorage(entries);
      const target = c.cut % (entries.length + 1);

      const firstProduction = await asyncOutcomeOf(() => compactTo(storage, target));
      const first = outcomeOf(() =>
        foldLogical({
          collection: COLLECTION,
          base: new Map(),
          baseSeq: 0,
          entries,
          targetSeq: target,
        }),
      );
      expectSameOutcome(
        "value" in first ? { value: first.value.rows } : first,
        "value" in firstProduction ? { value: firstProduction.value.rows } : firstProduction,
      );
      if (!("value" in first) || !("value" in firstProduction)) {
        return;
      }
      expect(first.value.foldedSeq).toBe(firstProduction.value.foldedSeq);

      const secondProduction = await asyncOutcomeOf(() =>
        compactTo(storage, Number.MAX_SAFE_INTEGER),
      );
      const second = outcomeOf(() =>
        foldLogical({
          collection: COLLECTION,
          base: first.value.rows,
          baseSeq: first.value.foldedSeq,
          entries,
          targetSeq: entries.length,
        }),
      );
      expectSameOutcome(
        "value" in second ? { value: second.value.rows } : second,
        "value" in secondProduction ? { value: secondProduction.value.rows } : secondProduction,
      );
      if ("value" in second && "value" in secondProduction) {
        expect(second.value.foldedSeq).toBe(secondProduction.value.foldedSeq);
      }
    },
  );

  test("the restated ceilings equal production's", () => {
    expect(MAX_DOCUMENT_BYTES).toBe(PRODUCTION_MAX_DOCUMENT_BYTES);
    expect(MAX_DOCUMENT_DEPTH).toBe(PRODUCTION_MAX_DOCUMENT_DEPTH);
    expect(DOC_ID_MAX_UTF8_BYTES).toBe(ARBITRARY_DOC_ID_MAX_UTF8_BYTES);
  });

  fcTest.prop({ invalid: invalidDocIdArb })(
    "an _id outside the domain is refused by the oracle and by assertSnapshotDocId",
    ({ invalid }) => {
      const body = { _id: invalid.id };
      expect(codeOf(() => foldEntries([entry(0, "I", invalid.id, body)]))).toBe("InvalidResponse");
      expect(codeOf(() => assertSnapshotDocId(invalid.id))).toBe("InvalidConfig");
    },
  );

  fcTest.prop({ id: validDocIdArb })(
    "an _id inside the domain is accepted by the oracle and by assertSnapshotDocId",
    ({ id }) => {
      expect(codeOf(() => foldEntries([entry(0, "I", id, { _id: id })]))).toBeUndefined();
      expect(codeOf(() => assertSnapshotDocId(id))).toBeUndefined();
    },
  );

  test("the document byte cap matches assertDocumentSize at the boundary", () => {
    const overhead = JSON.stringify({ _id: "a", s: "" }).length;
    for (const [bytes, oracleCode, productionCode] of [
      [MAX_DOCUMENT_BYTES, undefined, undefined],
      [MAX_DOCUMENT_BYTES + 1, "InvalidResponse", "InvalidConfig"],
    ] as const) {
      // A two-byte character straddles the boundary, so bytes, not code units, decide.
      const body = { _id: "a", s: `${"x".repeat(bytes - overhead - 2)}é` };
      expect(codeOf(() => foldEntries([entry(0, "I", "a", body)]))).toBe(oracleCode);
      expect(codeOf(() => assertDocumentSize(body, "test"))).toBe(productionCode);
    }
  });

  test("an NFD alias of the collection is refused by every fold, and only in range", async () => {
    const ops: Op[] = [
      { kind: "I", id: "a", fields: {} },
      { kind: "alias", id: "b", fields: {} },
    ];
    const entries = ops.map((op, seq) => entryOf(op, seq));
    const oracleTo = (targetSeq: number): Outcome<ReadonlyMap<string, DocumentData>> =>
      outcomeOf(
        () =>
          foldLogical({ collection: COLLECTION, base: new Map(), baseSeq: 0, entries, targetSeq })
            .rows,
      );
    const readerTo = (targetSeq: number): Outcome<ReadonlyMap<string, DocumentData>> =>
      outcomeOf(() => {
        const rows = new Map<string, DocumentData>();
        foldLogEntriesOnto(rows, entries.slice(0, targetSeq), { collection: COLLECTION });
        return rows;
      });

    expect(oracleTo(2)).toEqual({ code: "InvalidConfig" });
    expect(readerTo(2)).toEqual({ code: "InvalidConfig" });
    const storage = await seededStorage(entries);
    await expect(asyncOutcomeOf(() => compactTo(storage, 2))).resolves.toEqual({
      code: "InvalidConfig",
    });

    // Out of range, the alias is never read.
    expect(oracleTo(1)).toEqual({ value: new Map([["a", { _id: "a" }]]) });
    expectSameOutcome(oracleTo(1), readerTo(1));
    const view = await compactTo(storage, 1);
    expectSameOutcome(oracleTo(1), { value: view.rows });
  });
});

// ── Mutation: every single-defect variant goes red ─────────────────────

describe("mutation", () => {
  // Fixed so the red/green verdicts are reproducible and independent of
  // FC_NUM_RUNS.
  const RUNS = { seed: 0x1d0c, numRuns: 500 } as const;

  interface CheckOutcome {
    readonly failed: boolean;
    readonly error: unknown;
  }
  const run = <T>(arb: fc.Arbitrary<T>, check: (c: T) => void): CheckOutcome => {
    const details = fc.check(fc.property(arb, check), RUNS);
    return { failed: details.failed, error: details.errorInstance };
  };

  const catchers: Record<FoldInvariant, (fold: Fold) => CheckOutcome> = {
    "empty-identity": (fold) => run(foldCaseArb, (c) => checkEmptyIdentity(fold, c)),
    "last-write-wins": (fold) => run(foldCaseArb, (c) => checkLastWriteWins(fold, c)),
    "folded-seq": (fold) => run(foldCaseArb, (c) => checkFoldedSeq(fold, c)),
    "beyond-target-invisible": (fold) =>
      run(foldCaseArb, (c) => checkBeyondTargetInvisible(fold, c)),
    "absent-delete-invisible": (fold) =>
      run(foldCaseArb, (c) => checkAbsentDeleteInvisible(fold, c)),
    "input-order-invisible": (fold) => run(orderCaseArb, (c) => checkInputOrderInvisible(fold, c)),
    "no-aliasing": (fold) => run(foldCaseArb, (c) => checkNoAliasing(fold, c)),
    "prefix-split": (fold) => run(foldCaseArb, (c) => checkPrefixSplit(fold, c)),
  };

  /** The properties that must name each variant. Others may also go red. */
  const caughtBy: Record<LogicalFoldMutant, readonly FoldInvariant[]> = {
    "target-inclusive-bound": ["empty-identity", "last-write-wins", "beyond-target-invisible"],
    "skip-first-mutation": ["last-write-wins"],
    "skip-last-mutation": ["last-write-wins"],
    "first-write-wins": ["last-write-wins"],
    "array-order-not-seq-order": ["last-write-wins"],
    "delete-as-noop": ["last-write-wins"],
    "absent-delete-creates-row": ["absent-delete-invisible", "last-write-wins"],
    "merge-instead-of-replace": ["last-write-wins"],
    "wrong-folded-seq": ["empty-identity", "folded-seq"],
    "aliased-bodies": ["no-aliasing"],
    "sorted-keys": ["input-order-invisible"],
  };

  const readCatchers: Record<ReadInvariant, (reads: Reads) => CheckOutcome> = {
    "scan-read": (reads) => run(foldCaseArb, (c) => checkScanRead(reads, c)),
    "point-read": (reads) => run(foldCaseArb, (c) => checkPointRead(reads, c)),
    "range-read": (reads) =>
      run(fc.tuple(foldCaseArb, rangeArb), ([c, range]) => checkRangeRead(reads, c, range)),
  };

  const readCaughtBy: Record<LogicalReadMutant, readonly ReadInvariant[]> = {
    "gt-gte-swap": ["range-read"],
    "lt-lte-swap": ["range-read"],
    "point-miss-returns-successor": ["point-read"],
  };

  test("every read catcher is green on the oracle", () => {
    for (const catcher of Object.values(readCatchers)) {
      const outcome = catcher(ORACLE_READS);
      expect(outcome.error).toBeNull();
      expect(outcome.failed).toBe(false);
    }
  });

  test.each(LOGICAL_READ_MUTANTS)("read mutant %s is red", (mutant) => {
    for (const invariant of readCaughtBy[mutant]) {
      const outcome = readCatchers[invariant](mutantReads(mutant));
      expect(outcome.failed).toBe(true);
      expect(outcome.error).toBeInstanceOf(Violation);
      expect((outcome.error as Violation).invariant).toBe(invariant);
    }
  });

  test("every catcher is green on the oracle", () => {
    for (const catcher of Object.values(catchers)) {
      const outcome = catcher(foldLogical);
      expect(outcome.error).toBeNull();
      expect(outcome.failed).toBe(false);
    }
  });

  test.each(LOGICAL_FOLD_MUTANTS)("%s is red", (mutant) => {
    const fold: Fold = (input) => foldLogicalMutant(input, mutant);
    for (const invariant of caughtBy[mutant]) {
      const outcome = catchers[invariant](fold);
      expect(outcome.failed).toBe(true);
      expect(outcome.error).toBeInstanceOf(Violation);
      expect((outcome.error as Violation).invariant).toBe(invariant);
    }
  });
});
