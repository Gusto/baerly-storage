/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the oracle reads it by name. */

/**
 * Concurrent same-`_id` read-modify-write workload and its oracle.
 *
 * Every op races the others on a pool of three `_id`s: single-row merge
 * patches, a predicate batch update and batch delete, a predicate-field
 * toggle, whole-row replaces, deletes and re-inserts. The oracle checks the
 * committed log (the collection's linearization) instead of a model, so it
 * needs no knowledge of how the ops interleaved:
 *
 * - every `U` follows a live version of its row (no update or replace
 *   resurrects a delete);
 * - an update's post-image is its patch merged onto the version
 *   immediately before it in the log (no lost update), and a batch row's
 *   predecessor still matched the batch predicate;
 * - a replace's post-image is its document;
 * - each verb's result agrees with the entries it committed, and every
 *   committed `D` is counted by exactly one delete;
 * - no write was wrongly skipped: a row that stayed live (and matching a
 *   batch's predicate) at every log position between an op's start and
 *   its end must have been written by it;
 * - reads see the log's fold.
 *
 * Callers run with write-tick maintenance off, so the whole log stays in
 * place for the oracle to read.
 *
 * NOT a `.test.ts` file — a fixture shared by
 * `tests/integration/update-concurrent-write.test.ts` (seeded storm) and
 * `tests/integration/randomized.test.ts` (fast-check model).
 */

import { expect } from "vitest";
import { fc } from "@fast-check/vitest";
import {
  type Collection,
  type DocumentData,
  decodeJsonBytes,
  type LogEntry,
  logObjectKey,
  merge,
  type Storage,
} from "@baerly/protocol";
import { Db, type IndexDefinition } from "@baerly/server";
import { APP, COLLECTION, TABLE_PREFIX, TENANT } from "./maintenance-harness.ts";

/** The `_id` pool every op draws from. */
export const RMW_IDS = ["a", "b", "c"] as const;
type RmwId = (typeof RMW_IDS)[number];

/** One op of the workload; `k` is its index in the op list. */
export type RmwOp =
  | { readonly kind: "update" | "toggle" | "replace" | "insert"; readonly id: RmwId }
  | { readonly kind: "batch" }
  | { readonly kind: "batchDelete" }
  | { readonly kind: "delete"; readonly id: RmwId };

export type RmwResult = { readonly ok: unknown } | { readonly code: string | undefined };

/** The merge patch an update-shaped op `k` applies. `last` names the op in its post-image. */
const patchFor = (op: RmwOp, k: number): DocumentData => {
  if (op.kind === "update") {
    // Three fields, so some racing patches touch the same field and some don't.
    return { [`f${k % 3}`]: k, last: k };
  }
  if (op.kind === "toggle") {
    return { status: k % 2 === 0 ? "closed" : "open", last: k };
  }
  if (op.kind === "batch") {
    return { tag: k, last: k };
  }
  throw new Error(`no patch for ${op.kind}`);
};

const replaceBodyFor = (id: string, k: number): DocumentData => ({
  _id: id,
  status: "open",
  replaced: k,
  last: k,
});
const insertBodyFor = (id: string, k: number): DocumentData => ({
  _id: id,
  status: "open",
  inserted: k,
  last: k,
});

/**
 * Indexes covering every op's predicate: `_id` for the by-id verbs and
 * `status` for the batch ops. Pass them to run the workload on a `Db` that
 * declares them; declared indexes must change no verb's selection.
 */
export const RMW_INDEXES: readonly IndexDefinition[] = [
  { name: "by_id", on: "_id" },
  { name: "by_status", on: "status" },
];

const collectionOn = (storage: Storage, indexes: readonly IndexDefinition[] = []) =>
  Db.create({
    storage,
    app: APP,
    tenant: TENANT,
    config: { collections: { [COLLECTION]: { indexes: [...indexes] } } },
  }).collection(COLLECTION) as Collection<DocumentData>;

/** Seed every pooled row live and matching the batch predicate. */
export const seedRmwRows = async (
  storage: Storage,
  indexes: readonly IndexDefinition[] = [],
): Promise<void> => {
  for (const id of RMW_IDS) {
    await collectionOn(storage, indexes).insert({ _id: id, status: "open", last: -1 });
  }
};

/** Mulberry32: a deterministic PRNG for seeded storms. */
export const seededPrng = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** Each storage op first waits a random 0-3 ms, so the ops interleave differently per seed. */
export const jitterStorage = (inner: Storage, rand: () => number): Storage => {
  const wait = () => new Promise<void>((resolve) => setTimeout(resolve, Math.floor(rand() * 4)));
  return {
    get: async (k, o) => (await wait(), await inner.get(k, o)),
    put: async (k, b, o) => (await wait(), await inner.put(k, b, o)),
    delete: async (k, o) => (await wait(), await inner.delete(k, o)),
    list: async function* (p, o) {
      await wait();
      yield* inner.list(p, o);
    },
  };
};

/**
 * Each storage call starts only when fast-check's scheduler `s` releases
 * it, so the property explores the orders the calls of concurrent ops
 * start in (and shrinks a failing one).
 */
export const scheduledStorage = (inner: Storage, s: fc.Scheduler): Storage => {
  const turn = (label: string) => s.schedule(Promise.resolve(), label);
  return {
    get: async (k, o) => (await turn(`get ${k}`), await inner.get(k, o)),
    put: async (k, b, o) => (await turn(`put ${k}`), await inner.put(k, b, o)),
    delete: async (k, o) => (await turn(`delete ${k}`), await inner.delete(k, o)),
    list: async function* (p, o) {
      await turn(`list ${p}`);
      yield* inner.list(p, o);
    },
  };
};

const KINDS = [
  "update",
  "update",
  "toggle",
  "batch",
  "replace",
  "delete",
  "batchDelete",
  "insert",
] as const;

export const rmwOpsFromPrng = (rand: () => number, count: number): RmwOp[] =>
  Array.from({ length: count }, () => {
    const kind = KINDS[Math.floor(rand() * KINDS.length)]!;
    const id = RMW_IDS[Math.floor(rand() * RMW_IDS.length)]!;
    return kind === "batch" || kind === "batchDelete" ? { kind } : { kind, id };
  });

export const rmwOpsArb: fc.Arbitrary<RmwOp[]> = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constantFrom("update", "toggle", "replace", "insert", "delete"),
      id: fc.constantFrom(...RMW_IDS),
    }),
    fc.constantFrom({ kind: "batch" as const }, { kind: "batchDelete" as const }),
  ),
  { minLength: 2, maxLength: 8 },
);

/** The batch ops' predicate. */
const BATCH_WHERE = { status: "open" } as const;
const matchesBatch = (row: DocumentData | undefined): boolean => row?.["status"] === "open";

const runOp = (
  storage: Storage,
  op: RmwOp,
  k: number,
  indexes: readonly IndexDefinition[],
): Promise<unknown> => {
  const c = collectionOn(storage, indexes);
  if (op.kind === "batch") {
    return c.where(BATCH_WHERE).update(patchFor(op, k));
  }
  if (op.kind === "batchDelete") {
    return c.where(BATCH_WHERE).delete();
  }
  if (op.kind === "update" || op.kind === "toggle") {
    return c.update(op.id, patchFor(op, k));
  }
  if (op.kind === "replace") {
    return c.replace(op.id, replaceBodyFor(op.id, k));
  }
  if (op.kind === "insert") {
    return c.insert(insertBodyFor(op.id, k));
  }
  return c.delete(op.id);
};

/**
 * An op's result, and the log length before it started (`from`) and after
 * it settled (`to`). Its read and its commit both happened at log
 * positions in `[from, to]`.
 */
export interface RmwOutcome {
  readonly result: RmwResult;
  readonly from: number;
  readonly to: number;
}

/** The number of log entries (the log is dense from 0: nothing folds). */
const logLength = async (storage: Storage): Promise<number> => {
  let seq = 0;
  while ((await storage.get(logObjectKey(TABLE_PREFIX, seq))) !== null) {
    seq++;
  }
  return seq;
};

/**
 * Start every op at once over `storage`; settle each to its value or error
 * code. `logOf` is read, unjittered and unscheduled, for each op's span.
 * Every op runs on a `Db` declaring `indexes`.
 */
export const runRmwOps = (
  storage: Storage,
  ops: readonly RmwOp[],
  logOf: Storage,
  indexes: readonly IndexDefinition[] = [],
): Promise<RmwOutcome[]> =>
  Promise.all(
    ops.map(async (op, k) => {
      const from = await logLength(logOf);
      const result = await runOp(storage, op, k, indexes).then(
        (ok): RmwResult => ({ ok }),
        (error: unknown): RmwResult => ({ code: (error as { code?: string }).code }),
      );
      return { result, from, to: await logLength(logOf) };
    }),
  );

const readWholeLog = async (storage: Storage): Promise<LogEntry[]> => {
  const entries: LogEntry[] = [];
  for (let seq = 0; ; seq++) {
    const got = await storage.get(logObjectKey(TABLE_PREFIX, seq));
    if (got === null) {
      return entries;
    }
    entries.push(decodeJsonBytes<LogEntry>(got.body));
  }
};

/** Check the committed log and each op's result against the contract above. */
export const assertEvalPlanQualHistory = async (
  storage: Storage,
  ops: readonly RmwOp[],
  outcomes: readonly RmwOutcome[],
  label: string,
  indexes: readonly IndexDefinition[] = [],
): Promise<void> => {
  const log = await readWholeLog(storage);
  const live = new Map<string, DocumentData>();
  // `states[p]`: each row after the first `p` log entries.
  const states: Array<ReadonlyMap<string, DocumentData>> = [new Map()];
  const writes = new Map<number, Set<string>>();
  // Each check embeds `at` in the compared value, so a failure names the
  // seed, the log slot and the op.
  for (const entry of log) {
    const at = `${label}: log/${entry.seq} (${entry.op} ${entry.doc_id})`;
    const prev = live.get(entry.doc_id);
    if (entry.op === "D") {
      // A delete re-checks its row at commit, so it never tombstones an
      // absent one (two racing deletes commit one `D`).
      expect({ at, deleteOfAbsentRow: prev === undefined }).toEqual({
        at,
        deleteOfAbsentRow: false,
      });
      live.delete(entry.doc_id);
      states.push(new Map(live));
      continue;
    }
    const after = entry.after!;
    const k = after["last"] as number;
    writes.set(k, (writes.get(k) ?? new Set()).add(entry.doc_id));
    live.set(entry.doc_id, after);
    states.push(new Map(live));
    if (entry.op === "I") {
      expect({ at, insertOverLiveRow: prev !== undefined }).toEqual({
        at,
        insertOverLiveRow: false,
      });
      continue;
    }
    expect({ at, op: k, resurrected: prev === undefined }).toEqual({
      at,
      op: k,
      resurrected: false,
    });
    const op = ops[k]!;
    if (op.kind === "replace") {
      expect({ at, after }).toEqual({ at, after: replaceBodyFor(entry.doc_id, k) });
      continue;
    }
    if (op.kind === "batch") {
      expect({ at, predecessorStatus: prev!["status"] }).toEqual({ at, predecessorStatus: "open" });
    }
    expect({ at, after }).toEqual({ at, after: merge(prev!, patchFor(op, k)) });
  }

  // Completeness: a write that should have landed did. An op reads and
  // commits at log positions in its span `[from, to]`, so if its row stayed
  // live (and matching the batch predicate) at every position of the span,
  // no peer deleted or disqualified it there, and skipping it is wrong.
  const heldThroughout = (
    outcome: RmwOutcome,
    id: string,
    holds: (row: DocumentData | undefined) => boolean,
  ): boolean => states.slice(outcome.from, outcome.to + 1).every((state) => holds(state.get(id)));
  const isLive = (row: DocumentData | undefined): boolean => row !== undefined;
  let reportedDeletes = 0;
  ops.forEach((op, k) => {
    const at = `${label}: op ${k} ${JSON.stringify(op)} span [${outcomes[k]!.from}, ${outcomes[k]!.to}]`;
    const outcome = outcomes[k]!;
    const { result } = outcome;
    const wrote = writes.get(k) ?? new Set<string>();
    if (op.kind === "delete" || op.kind === "batchDelete") {
      expect({ at, result }).toMatchObject({ at, result: { ok: { deleted: expect.any(Number) } } });
      const { deleted } = (result as { ok: { deleted: number } }).ok;
      reportedDeletes += deleted;
      const owed =
        op.kind === "delete"
          ? [op.id].filter((id) => heldThroughout(outcome, id, isLive))
          : RMW_IDS.filter((id) => heldThroughout(outcome, id, matchesBatch));
      // A row live throughout the span cannot stay live past this op.
      expect({ at, deletedAtLeast: Math.min(deleted, owed.length) }).toEqual({
        at,
        deletedAtLeast: owed.length,
      });
      return;
    }
    if (op.kind === "insert") {
      expect({ at, result }).toEqual({
        at,
        result: wrote.size === 1 ? { ok: { _id: op.id } } : { code: "AlreadyExists" },
      });
      const absentThroughout = heldThroughout(outcome, op.id, (row) => row === undefined);
      expect({ at, refusedWhileAbsent: wrote.size === 0 && absentThroughout }).toEqual({
        at,
        refusedWhileAbsent: false,
      });
      return;
    }
    if (op.kind === "replace") {
      expect({ at, result }).toEqual({
        at,
        result: wrote.size === 1 ? { ok: undefined } : { code: "NotFound" },
      });
    } else {
      expect({ at, result }).toEqual({ at, result: { ok: { modified: wrote.size } } });
    }
    const targets = op.kind === "batch" ? RMW_IDS : [op.id];
    const holds = op.kind === "batch" ? matchesBatch : isLive;
    const wronglySkipped = targets.filter(
      (id) => !wrote.has(id) && heldThroughout(outcome, id, holds),
    );
    expect({ at, wronglySkipped }).toEqual({ at, wronglySkipped: [] });
  });
  // Every committed `D` is reported by exactly one delete, and none twice.
  const committedDeletes = log.filter((entry) => entry.op === "D").length;
  expect({ at: label, reportedDeletes }).toEqual({ at: label, reportedDeletes: committedDeletes });

  const rows = await collectionOn(storage).all();
  expect({ at: label, rows: Object.fromEntries(rows.map((r) => [r["_id"] as string, r])) }).toEqual(
    {
      at: label,
      rows: Object.fromEntries(live),
    },
  );
  // Reads on a `Db` declaring `indexes` see the same fold.
  const indexed = collectionOn(storage, indexes);
  const byPredicate = await indexed.where(BATCH_WHERE).all();
  const byId = await Promise.all(RMW_IDS.map((id) => indexed.get(id)));
  expect({
    at: label,
    byPredicate: byPredicate.map((r) => r["_id"]).toSorted(),
    byId: byId.map((r) => r?.["_id"]),
  }).toEqual({
    at: label,
    byPredicate: [...live.values()]
      .filter(matchesBatch)
      .map((r) => r["_id"])
      .toSorted(),
    byId: RMW_IDS.map((id) => live.get(id)?.["_id"]),
  });
};
