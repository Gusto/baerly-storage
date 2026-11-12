/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes; the oracle reads it by name. */

/**
 * Concurrent same-`_id` read-modify-write workload and its oracle.
 *
 * Every op races the others on a pool of three `_id`s: single-row merge
 * patches, a predicate batch update, a predicate-field toggle, whole-row
 * replaces, deletes and re-inserts. The oracle checks the committed log
 * (the collection's linearization) instead of a model, so it needs no
 * knowledge of how the ops interleaved:
 *
 * - every `U` follows a live version of its row (no update or replace
 *   resurrects a delete);
 * - an update's post-image is its patch merged onto the version
 *   immediately before it in the log (no lost update), and a batch row's
 *   predecessor still matched the batch predicate;
 * - a replace's post-image is its document;
 * - each verb's result agrees with the entries it committed;
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
import { Db } from "@baerly/server";
import { APP, COLLECTION, TABLE_PREFIX, TENANT } from "./maintenance-harness.ts";

/** The `_id` pool every op draws from. */
export const RMW_IDS = ["a", "b", "c"] as const;
type RmwId = (typeof RMW_IDS)[number];

/** One op of the workload; `k` is its index in the op list. */
export type RmwOp =
  | { readonly kind: "update" | "toggle" | "replace" | "insert"; readonly id: RmwId }
  | { readonly kind: "batch" }
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

const collectionOn = (storage: Storage) =>
  Db.create({ storage, app: APP, tenant: TENANT }).collection(
    COLLECTION,
  ) as Collection<DocumentData>;

/** Seed every pooled row live and matching the batch predicate. */
export const seedRmwRows = async (storage: Storage): Promise<void> => {
  for (const id of RMW_IDS) {
    await collectionOn(storage).insert({ _id: id, status: "open", last: -1 });
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

const KINDS = ["update", "update", "toggle", "batch", "replace", "delete", "insert"] as const;

export const rmwOpsFromPrng = (rand: () => number, count: number): RmwOp[] =>
  Array.from({ length: count }, () => {
    const kind = KINDS[Math.floor(rand() * KINDS.length)]!;
    const id = RMW_IDS[Math.floor(rand() * RMW_IDS.length)]!;
    return kind === "batch" ? { kind } : { kind, id };
  });

export const rmwOpsArb: fc.Arbitrary<RmwOp[]> = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constantFrom("update", "toggle", "replace", "insert", "delete"),
      id: fc.constantFrom(...RMW_IDS),
    }),
    fc.constant({ kind: "batch" as const }),
  ),
  { minLength: 2, maxLength: 8 },
);

const runOp = (storage: Storage, op: RmwOp, k: number): Promise<unknown> => {
  const c = collectionOn(storage);
  if (op.kind === "batch") {
    return c.where({ status: "open" }).update(patchFor(op, k));
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

/** Start every op at once over `storage`; settle each to its value or error code. */
export const runRmwOps = (storage: Storage, ops: readonly RmwOp[]): Promise<RmwResult[]> =>
  Promise.all(
    ops.map((op, k) =>
      runOp(storage, op, k).then(
        (ok) => ({ ok }),
        (error: unknown) => ({ code: (error as { code?: string }).code }),
      ),
    ),
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
  results: readonly RmwResult[],
  label: string,
): Promise<void> => {
  const log = await readWholeLog(storage);
  const live = new Map<string, DocumentData>();
  const writesBy = new Map<number, number>();
  // Each check embeds `at` in the compared value, so a failure names the
  // seed, the log slot and the op.
  for (const entry of log) {
    const at = `${label}: log/${entry.seq} (${entry.op} ${entry.doc_id})`;
    const prev = live.get(entry.doc_id);
    if (entry.op === "D") {
      live.delete(entry.doc_id);
      continue;
    }
    const after = entry.after!;
    const k = after["last"] as number;
    writesBy.set(k, (writesBy.get(k) ?? 0) + 1);
    live.set(entry.doc_id, after);
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
  ops.forEach((op, k) => {
    const at = `${label}: op ${k} ${JSON.stringify(op)}`;
    const wrote = writesBy.get(k) ?? 0;
    const result = results[k]!;
    if (op.kind === "delete") {
      expect({ at, result }).toMatchObject({ at, result: { ok: { deleted: expect.any(Number) } } });
      return;
    }
    let expected: RmwResult = { ok: { modified: wrote } };
    if (op.kind === "replace") {
      expected = wrote === 1 ? { ok: undefined } : { code: "NotFound" };
    } else if (op.kind === "insert") {
      expected = wrote === 1 ? { ok: { _id: op.id } } : { code: "AlreadyExists" };
    }
    expect({ at, result }).toEqual({ at, result: expected });
  });
  const rows = await collectionOn(storage).all();
  expect({ at: label, rows: Object.fromEntries(rows.map((r) => [r["_id"] as string, r])) }).toEqual(
    {
      at: label,
      rows: Object.fromEntries(live),
    },
  );
};
