/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol/src/db.ts`'s `Table<T>`
   declaration); reads expose it on rows. */

/**
 * Read terminals — examples per ticket 09 §5. All 12 cases
 * exercise the read path against `MemoryStorage`; no infra required.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  createCurrentJson,
  type JSONArraylessObject,
  MemoryStorage,
  BaerlyError,
  type Predicate,
} from "@baerly/protocol";
import { beforeEach, describe, expect, test } from "vitest";
import { compact } from "./compactor.ts";
import { Db } from "./db.ts";
import { runAllWithMeta } from "./query.ts";
import { ServerWriter } from "./server-writer.ts";

const APP = "test";
const TENANT = "t";
const COLL = "tickets";
const currentJsonKey = (coll: string): string =>
  `app/${APP}/tenant/${TENANT}/manifests/${coll}/current.json`;
const logKey = (coll: string, seq: number): string =>
  `app/${APP}/tenant/${TENANT}/manifests/${coll}/log/${seq}.json`;

const seedCurrent = (next_seq = 0): CurrentJson => ({
  schema_version: CURRENT_JSON_SCHEMA_VERSION,
  snapshot: null,
  next_seq,
  writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
});

const makeDb = (storage: MemoryStorage): Db => Db.create({ storage, app: APP, tenant: TENANT });

const provision = async (storage: MemoryStorage, coll = COLL): Promise<void> => {
  await createCurrentJson(storage, currentJsonKey(coll), seedCurrent());
};

const commit = (storage: MemoryStorage, coll = COLL): ServerWriter =>
  new ServerWriter({ storage, currentJsonKey: currentJsonKey(coll) });

describe("Db.table read terminals", () => {
  let storage: MemoryStorage;
  let db: Db;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = makeDb(storage);
  });

  test("case 1: empty table (next_seq=0) returns [], undefined, 0", async () => {
    await provision(storage);
    const t = db.table(COLL);
    expect(await t.where({}).all()).toEqual([]);
    expect(await t.where({}).first()).toBeUndefined();
    expect(await t.count()).toBe(0);
  });

  test("case 2: missing current.json returns [], undefined, 0 (no throw)", async () => {
    // No provision call — current.json doesn't exist.
    const t = db.table(COLL);
    expect(await t.where({}).all()).toEqual([]);
    expect(await t.where({}).first()).toBeUndefined();
    expect(await t.count()).toBe(0);
  });

  test("case 3: single insert via ServerWriter is visible to all()", async () => {
    await provision(storage);
    const w = commit(storage);
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "doc-1",
      body: { _id: "doc-1", title: "hello" },
    });

    const rows = await db.table(COLL).where({}).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ _id: "doc-1", title: "hello" });
  });

  test("case 4: predicate filters multiple inserts (all/count/first agree)", async () => {
    await provision(storage);
    const w = commit(storage);
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "a",
      body: { _id: "a", status: "open" },
    });
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "b",
      body: { _id: "b", status: "closed" },
    });
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "c",
      body: { _id: "c", status: "open" },
    });

    const q = db.table(COLL).where({ status: "open" });
    const rows = await q.all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r._id).toSorted()).toEqual(["a", "c"]);
    expect(await q.count()).toBe(2);
    const head = await q.first();
    expect(head).toBeDefined();
    expect((head as { status: string }).status).toBe("open");
  });

  test("case 5: .where().where() AND-merges via mergePredicates", async () => {
    await provision(storage);
    const w = commit(storage);
    await w.commit({ op: "I", collection: COLL, docId: "1", body: { _id: "1", a: 1, b: 2 } });
    await w.commit({ op: "I", collection: COLL, docId: "2", body: { _id: "2", a: 1, b: 3 } });
    await w.commit({ op: "I", collection: COLL, docId: "3", body: { _id: "3", a: 2, b: 2 } });

    const rows = await db.table(COLL).where({ a: 1 }).where({ b: 2 }).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!._id).toBe("1");
  });

  test("case 6: .order() asc/desc on a monotonically-varying field", async () => {
    await provision(storage);
    const w = commit(storage);
    // Insert in a deliberately-unsorted order so the sort is doing work.
    await w.commit({ op: "I", collection: COLL, docId: "b", body: { _id: "b", n: 2 } });
    await w.commit({ op: "I", collection: COLL, docId: "a", body: { _id: "a", n: 1 } });
    await w.commit({ op: "I", collection: COLL, docId: "c", body: { _id: "c", n: 3 } });

    const asc = await db.table(COLL).order({ n: "asc" }).all();
    expect(asc.map((r) => r._id)).toEqual(["a", "b", "c"]);
    const desc = await db.table(COLL).order({ n: "desc" }).all();
    expect(desc.map((r) => r._id)).toEqual(["c", "b", "a"]);
  });

  test("case 7: .limit(n) truncates results", async () => {
    await provision(storage);
    const w = commit(storage);
    for (const id of ["a", "b", "c"]) {
      await w.commit({ op: "I", collection: COLL, docId: id, body: { _id: id, n: 1 } });
    }
    const rows = await db.table(COLL).order({ _id: "asc" }).limit(2).all();
    expect(rows.map((r) => r._id)).toEqual(["a", "b"]);
  });

  test("case 8: fold reflects update (post-image overwrites) and delete (tombstone removes)", async () => {
    await provision(storage);
    const w = commit(storage);
    // Insert A, update A, insert B, delete B → fold = { A_updated }
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "A",
      body: { _id: "A", v: "v1" },
    });
    await w.commit({
      op: "U",
      collection: COLL,
      docId: "A",
      body: { _id: "A", v: "v2" },
    });
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "B",
      body: { _id: "B", v: "x" },
    });
    await w.commit({ op: "D", collection: COLL, docId: "B" });

    const rows = await db.table(COLL).where({}).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ _id: "A", v: "v2" });
  });

  test("case 9: chain immutability — .where() returns a new object; original Table is unchanged", async () => {
    await provision(storage);
    const w = commit(storage);
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "1",
      body: { _id: "1", status: "open" },
    });
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "2",
      body: { _id: "2", status: "closed" },
    });

    const table = db.table(COLL);
    const q1 = table.where({ status: "open" });
    // The Query returned is a fresh object — identity inequality with
    // the Table it came from.
    expect(q1 as unknown).not.toBe(table as unknown);
    // Chaining another modifier on the ORIGINAL table sees no
    // predicate state from `q1` (frozen-state invariant).
    const all = await table.where({}).all();
    expect(all).toHaveLength(2);
    // And `q1` is still narrow.
    const open = await q1.all();
    expect(open).toHaveLength(1);
    expect(open[0]!._id).toBe("1");
    // Two consecutive `.where` calls produce distinct Query objects.
    const q2 = q1.where({ _id: "1" });
    expect(q2 as unknown).not.toBe(q1 as unknown);
  });

  test("case 10: tenant isolation — two Dbs over one MemoryStorage don't see each other", async () => {
    const dbA = Db.create({ storage, app: APP, tenant: "alice" });
    const dbB = Db.create({ storage, app: APP, tenant: "bob" });
    await createCurrentJson(
      storage,
      `app/${APP}/tenant/alice/manifests/${COLL}/current.json`,
      seedCurrent(),
    );
    await createCurrentJson(
      storage,
      `app/${APP}/tenant/bob/manifests/${COLL}/current.json`,
      seedCurrent(),
    );
    const wA = new ServerWriter({
      storage,
      currentJsonKey: `app/${APP}/tenant/alice/manifests/${COLL}/current.json`,
    });
    const wB = new ServerWriter({
      storage,
      currentJsonKey: `app/${APP}/tenant/bob/manifests/${COLL}/current.json`,
    });
    await wA.commit({
      op: "I",
      collection: COLL,
      docId: "alice-doc",
      body: { _id: "alice-doc", owner: "alice" },
    });
    await wB.commit({
      op: "I",
      collection: COLL,
      docId: "bob-doc",
      body: { _id: "bob-doc", owner: "bob" },
    });

    const aRows = await dbA.table(COLL).where({}).all();
    const bRows = await dbB.table(COLL).where({}).all();
    expect(aRows.map((r) => r._id)).toEqual(["alice-doc"]);
    expect(bRows.map((r) => r._id)).toEqual(["bob-doc"]);
  });

  test("case 11: invalid table name throws InvalidConfig", async () => {
    // Empty name → InvalidConfig (constructed at .table() call).
    expect(() => db.table("")).toThrow(BaerlyError);
    try {
      db.table("");
    } catch (err) {
      expect((err as BaerlyError).code).toBe("InvalidConfig");
    }
    // Slash in name → InvalidConfig.
    try {
      db.table("a/b");
    } catch (err) {
      expect((err as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("case 12: malformed log entry surfaces as InvalidResponse", async () => {
    // Bootstrap current.json claiming one log entry exists, then plant
    // a non-JSON body at log/0.json. The reader walks [0, 1) and
    // chokes on the parse.
    await createCurrentJson(storage, currentJsonKey(COLL), seedCurrent(1));
    await storage.put(logKey(COLL, 0), new TextEncoder().encode("not-json{"));

    try {
      await db.table(COLL).where({}).all();
      throw new Error("expected malformed log entry to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(BaerlyError);
      expect((err as BaerlyError).code).toBe("InvalidResponse");
    }
  });

  test("case 13: read skips log entries below log_seq_start", async () => {
    // Bootstrap a collection with one I entry at seq=0, then manually
    // CAS-write current.json with log_seq_start=1. The reader's bound
    // becomes [1, 1) so the read returns empty even though log/0.json
    // still exists on the bucket. Tests the reader's bound — the
    // compactor lands in ticket 14, where a populated read across this
    // boundary will use snapshot consumption.
    await provision(storage);
    const w = commit(storage);
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "doc-1",
      body: { _id: "doc-1", title: "hello" },
    });

    // Sanity: the row is visible before we advance log_seq_start.
    expect(await db.table(COLL).where({}).all()).toHaveLength(1);

    // Manually advance log_seq_start to 1 (simulates a compactor run
    // that folded log/0.json into a snapshot).
    const { casUpdateCurrentJson } = await import("@baerly/protocol");
    await casUpdateCurrentJson(storage, currentJsonKey(COLL), (c) => ({
      ...c,
      log_seq_start: 1,
    }));

    // Reader now walks [1, 1) → empty.
    expect(await db.table(COLL).where({}).all()).toEqual([]);
    expect(await db.table(COLL).count()).toBe(0);
    expect(await db.table(COLL).where({}).first()).toBeUndefined();
  });

  test("case 14: read walks [log_seq_start, next_seq) and skips dropped entries", async () => {
    // Bootstrap with log_seq_start=2 and next_seq=3, where log/0.json
    // and log/1.json are absent (simulating a post-truncation bucket).
    // The reader MUST NOT GET them — only log/2.json — and surface that
    // single row.
    await createCurrentJson(storage, currentJsonKey(COLL), {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 3,
      writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
      log_seq_start: 2,
    });
    // Plant only the live log entry.
    const entry = {
      lsn: "fake-lsn",
      commit_ts: new Date().toISOString(),
      op: "I" as const,
      collection: COLL,
      doc_id: "live",
      schema_version: 0,
      session: "fakesess1",
      seq: 2,
      new: { _id: "live", v: 1 },
      patch: { _id: "live", v: 1 },
    };
    await storage.put(logKey(COLL, 2), new TextEncoder().encode(JSON.stringify(entry)));

    const rows = await db.table(COLL).where({}).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ _id: "live", v: 1 });
  });

  test("case 15: read consumes the snapshot — rows unchanged across a compaction", async () => {
    // Insert N rows, snapshot them all, then read: every row must
    // still surface. Validates the snapshot-load + overlay path in
    // `runRead`.
    await provision(storage);
    const w = commit(storage);
    for (let i = 0; i < 50; i++) {
      await w.commit({
        op: "I",
        collection: COLL,
        docId: `d${i}`,
        body: { _id: `d${i}`, n: i },
      });
    }

    // Pre-compaction snapshot of the row set, for an apples-to-apples
    // comparison after the snapshot lands.
    const before = await db.table<{ _id: string; n: number }>(COLL).order({ _id: "asc" }).all();
    expect(before).toHaveLength(50);

    const res = await compact(
      { storage, currentJsonKey: currentJsonKey(COLL) },
      { minEntriesToCompact: 10, maxEntriesPerRun: 100 },
    );
    expect(res.written).toBe(true);
    expect(res.logSeqStartAfter).toBe(50);

    const after = await db.table<{ _id: string; n: number }>(COLL).order({ _id: "asc" }).all();
    expect(after).toEqual(before);
  });

  test("case 16: read overlays post-snapshot inserts on top of the snapshot", async () => {
    // Snapshot covers N rows; another M arrive after; the read fold
    // returns N+M rows (snapshot base + live tail).
    await provision(storage);
    const w = commit(storage);
    for (let i = 0; i < 40; i++) {
      await w.commit({
        op: "I",
        collection: COLL,
        docId: `pre${i}`,
        body: { _id: `pre${i}`, phase: "pre" },
      });
    }
    const res = await compact(
      { storage, currentJsonKey: currentJsonKey(COLL) },
      { minEntriesToCompact: 10, maxEntriesPerRun: 100 },
    );
    expect(res.written).toBe(true);
    expect(res.logSeqStartAfter).toBe(40);

    // 10 more inserts AFTER the snapshot.
    for (let i = 0; i < 10; i++) {
      await w.commit({
        op: "I",
        collection: COLL,
        docId: `post${i}`,
        body: { _id: `post${i}`, phase: "post" },
      });
    }

    const rows = await db.table<{ _id: string; phase: string }>(COLL).where({}).all();
    expect(rows).toHaveLength(50);
    expect(rows.filter((r) => r.phase === "pre")).toHaveLength(40);
    expect(rows.filter((r) => r.phase === "post")).toHaveLength(10);
  });

  test("case 17: eventual read against unchanged current.json returns fresh:false and stable pointer", async () => {
    // Ticket 33 + Ticket 34 invariant: under ticket 34's redefinition,
    // `fresh` reflects the caller's requested level — `false` whenever
    // `eventual` served the response. Two reads against the same
    // `current.json` generation return the same cursor; the second
    // (eventual) read carries `fresh:false` and skips the per-call
    // `current.json` GET.
    await provision(storage);
    const w = commit(storage);
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "doc-1",
      body: { _id: "doc-1", title: "hello" },
    });

    const ctx = db.tableReadContext(COLL);
    const baseState = {
      predicate: undefined,
      order: undefined,
      limit: undefined,
    } as const;

    // Strong anchors the cache.
    const r1 = await runAllWithMeta<JSONArraylessObject>(ctx, {
      ...baseState,
      consistency: "strong",
    });
    // Eventual serves from the cache.
    const r2 = await runAllWithMeta<JSONArraylessObject>(ctx, {
      ...baseState,
      consistency: "eventual",
    });

    expect(r1.fresh).toBe(true);
    expect(r2.fresh).toBe(false);
    expect(r2.manifestPointer).toBe(r1.manifestPointer);
    expect(r1.rows.map((r) => r._id)).toEqual(["doc-1"]);
    expect(r2.rows.map((r) => r._id)).toEqual(["doc-1"]);
  });

  test("case 18: strong read sees the new pointer after a writer advances next_seq", async () => {
    // Ticket 33 invariant: a concurrent commit between two strong reads
    // advances `current.json`; the second read observes a new
    // manifest pointer and reports `fresh:true`. Under ticket 34,
    // every strong read carries `fresh:true` by definition.
    await provision(storage);
    const w = commit(storage);
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "doc-1",
      body: { _id: "doc-1", title: "hello" },
    });

    const ctx = db.tableReadContext(COLL);
    const strongState = {
      predicate: undefined,
      order: undefined,
      limit: undefined,
      consistency: "strong",
    } as const;

    const r1 = await runAllWithMeta<JSONArraylessObject>(ctx, strongState);
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "doc-2",
      body: { _id: "doc-2", title: "world" },
    });
    const r2 = await runAllWithMeta<JSONArraylessObject>(ctx, strongState);

    expect(r1.fresh).toBe(true);
    expect(r2.fresh).toBe(true);
    expect(r2.manifestPointer).not.toBe(r1.manifestPointer);
    expect(r1.rows.map((r) => r._id)).toEqual(["doc-1"]);
    expect(r2.rows.map((r) => r._id).toSorted()).toEqual(["doc-1", "doc-2"]);
  });

  test("case 19: consistency('eventual') returns a new Query; chain is immutable", async () => {
    // Ticket 34: `.consistency(level)` follows the same identity-
    // inequality contract as `.where` / `.order` / `.limit`.
    await provision(storage);
    const t = db.table(COLL);
    const a = t.where({});
    const b = a.consistency("eventual");
    expect(b as unknown).not.toBe(a as unknown);
    expect(typeof b.all).toBe("function");
  });

  test("case 20: last-call-wins on .consistency()", async () => {
    // Ticket 34: repeat `.consistency(level)` invocations replace
    // the level (matching `.order()` / `.limit()` semantics).
    // Empty table → both levels resolve to `[]`.
    await provision(storage);
    const q = db.table(COLL).consistency("eventual").consistency("strong");
    expect(await q.all()).toEqual([]);
  });
});

describe("auto-planner index routing", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  /**
   * Build a Db with one declared single-field index `by_status` on
   * the `tickets` collection. Mirrors the writer's `indexes` so the
   * reader's planner picks the same entries on the wire.
   */
  const dbWithByStatus = (): Db =>
    Db.create({
      storage,
      app: APP,
      tenant: TENANT,
      indexes: new Map([[COLL, [{ name: "by_status", on: "status" }]]]),
    });

  const dbWithComposite = (): Db =>
    Db.create({
      storage,
      app: APP,
      tenant: TENANT,
      indexes: new Map([[COLL, [{ name: "by_status_priority", on: ["status", "priority"] }]]]),
    });

  test("auto-routes a single-field equality predicate to the declared index", async () => {
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_status", on: "status" }] },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "open" },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-2",
      body: { _id: "t-2", status: "open" },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-3",
      body: { _id: "t-3", status: "closed" },
    });
    const db = dbWithByStatus();
    const rows = await db
      .table<{ _id: string; status: string }>(COLL)
      .where({ status: "open" })
      .all();
    const ids = rows.map((r) => r._id).toSorted();
    expect(ids).toEqual(["t-1", "t-2"]);
  });

  test("returns empty result when the index prefix is empty (no matches)", async () => {
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_status", on: "status" }] },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "open" },
    });
    const db = dbWithByStatus();
    const rows = await db
      .table<{ _id: string; status: string }>(COLL)
      .where({ status: "wip" })
      .all();
    expect(rows).toEqual([]);
  });

  test("applies the predicate residue when the predicate has multiple keys", async () => {
    // The planner routes through `by_status` at prefix-length 1; the
    // post-fetch `matches(...)` re-check filters by `assignee`.
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_status", on: "status" }] },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "open", assignee: "alice" },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-2",
      body: { _id: "t-2", status: "open", assignee: "bob" },
    });
    const db = dbWithByStatus();
    const rows = await db
      .table<{ _id: string; status: string; assignee: string }>(COLL)
      .where({ status: "open", assignee: "alice" })
      .all();
    expect(rows.map((r) => r._id)).toEqual(["t-1"]);
  });

  test("respects .limit() applied after the index walk", async () => {
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_status", on: "status" }] },
    });
    for (let i = 0; i < 5; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `t-${i}`,
        body: { _id: `t-${i}`, status: "open" },
      });
    }
    const db = dbWithByStatus();
    const rows = await db
      .table<{ _id: string; status: string }>(COLL)
      .where({ status: "open" })
      .limit(2)
      .all();
    expect(rows).toHaveLength(2);
  });

  test("composite index routes a two-field equality predicate through the walk path", async () => {
    // [status, priority] index, full walk (length 2 of 2). Each
    // yielded key has tail `<docId>.json` (single segment).
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_status_priority", on: ["status", "priority"] }] },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "open", priority: "p2" },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-2",
      body: { _id: "t-2", status: "open", priority: "p1" },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-3",
      body: { _id: "t-3", status: "closed", priority: "p2" },
    });
    const db = dbWithComposite();
    const rows = await db
      .table<{ _id: string; status: string; priority: string }>(COLL)
      .where({ status: "open", priority: "p2" })
      .all();
    expect(rows.map((r) => r._id)).toEqual(["t-1"]);
  });

  test("composite index walked at partial prefix returns the right docs", async () => {
    // [status, priority] index, walked at partial-prefix length 1
    // (`status` only). Each yielded key has tail
    // `<priority-b32>/<docId>.json` — TWO segments. This exercises
    // the multi-segment doc-id extraction in `runIndexWalkPlan`.
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_status_priority", on: ["status", "priority"] }] },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "open", priority: "p1" },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-2",
      body: { _id: "t-2", status: "open", priority: "p2" },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-3",
      body: { _id: "t-3", status: "open", priority: "p3" },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-4",
      body: { _id: "t-4", status: "closed", priority: "p1" },
    });
    const db = dbWithComposite();
    const rows = await db
      .table<{ _id: string; status: string; priority: string }>(COLL)
      .where({ status: "open" })
      .all();
    expect(rows.map((r) => r._id).toSorted()).toEqual(["t-1", "t-2", "t-3"]);
  });

  test("composite [a,b,c] index walked at prefix [a,b] returns the right docs", async () => {
    // Three-field index walked at length 2 of 3. Each yielded key
    // has tail `<c-b32>/<docId>.json` — TWO segments — exercising
    // the same multi-segment extraction as the [status, priority]
    // case but with a deeper tail. Fixture: 3 (a,b) groups × 3 c-
    // values × ~1 doc/c = ~9 docs; assert just the 3 docs whose
    // (a,b) = (1,2).
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_a_b_c", on: ["a", "b", "c"] }] },
    });
    const docs: Array<{ id: string; a: number; b: number; c: number }> = [
      // (a=1, b=2) group — three docs that share the walk's [1,2]
      // prefix and differ only on `c`. These are the rows we want
      // back.
      { id: "x-1", a: 1, b: 2, c: 10 },
      { id: "x-2", a: 1, b: 2, c: 20 },
      { id: "x-3", a: 1, b: 2, c: 30 },
      // Other (a,b) groups — must NOT appear in the result.
      { id: "y-1", a: 1, b: 3, c: 10 },
      { id: "y-2", a: 1, b: 3, c: 20 },
      { id: "y-3", a: 1, b: 3, c: 30 },
      { id: "z-1", a: 2, b: 2, c: 10 },
      { id: "z-2", a: 2, b: 2, c: 20 },
      { id: "z-3", a: 2, b: 2, c: 30 },
    ];
    for (const d of docs) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: d.id,
        body: { _id: d.id, a: d.a, b: d.b, c: d.c },
      });
    }
    const db = Db.create({
      storage,
      app: APP,
      tenant: TENANT,
      indexes: new Map([[COLL, [{ name: "by_a_b_c", on: ["a", "b", "c"] }]]]),
    });
    const rows = await db
      .table<{ _id: string; a: number; b: number; c: number }>(COLL)
      .where({ a: 1, b: 2 })
      .all();
    expect(rows.map((r) => r._id).toSorted()).toEqual(["x-1", "x-2", "x-3"]);
  });

  test("mixed predicate with an operator clause walks the index and in-memory-filters the operator", async () => {
    // The planner routes on the equality clause; the operator clause
    // lands on the post-fetch matches() re-check.
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_status", on: "status" }] },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "open", priority: "p1" },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-2",
      body: { _id: "t-2", status: "open", priority: "p2" },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-3",
      body: { _id: "t-3", status: "open", priority: "p3" },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-4",
      body: { _id: "t-4", status: "closed", priority: "p3" },
    });
    const db = dbWithByStatus();
    const rows = await db
      .table<{ _id: string; status: string; priority: string }>(COLL)
      .where({ status: "open", priority: { $gt: "p2" } } as unknown as Predicate<{
        _id: string;
        status: string;
        priority: string;
      }>)
      .all();
    expect(rows.map((r) => r._id)).toEqual(["t-3"]);
  });
});

describe("operator predicates — full-scan path", () => {
  let storage: MemoryStorage;
  let db: Db;
  beforeEach(() => {
    storage = new MemoryStorage();
    db = makeDb(storage);
  });

  test("$gte + $lt on number field returns the right slice", async () => {
    await provision(storage);
    const w = commit(storage);
    for (let i = 0; i < 10; i++) {
      await w.commit({
        op: "I",
        collection: COLL,
        docId: `t-${i}`,
        body: { _id: `t-${i}`, count: i },
      });
    }
    const rows = await db
      .table<{ _id: string; count: number }>(COLL)
      .where({ count: { $gte: 3, $lt: 7 } } as unknown as Predicate<{
        _id: string;
        count: number;
      }>)
      .all();
    expect(rows.map((r) => r.count).toSorted((a, b) => a - b)).toEqual([3, 4, 5, 6]);
  });

  test("$in returns the union", async () => {
    await provision(storage);
    const w = commit(storage);
    for (const p of ["p1", "p2", "p3", "p4"]) {
      await w.commit({
        op: "I",
        collection: COLL,
        docId: `t-${p}`,
        body: { _id: `t-${p}`, priority: p },
      });
    }
    const rows = await db
      .table<{ _id: string; priority: string }>(COLL)
      .where({ priority: { $in: ["p1", "p2"] } } as unknown as Predicate<{
        _id: string;
        priority: string;
      }>)
      .all();
    expect(rows.map((r) => r._id).toSorted()).toEqual(["t-p1", "t-p2"]);
  });

  test("range op on date-string field returns the right window", async () => {
    await provision(storage);
    const w = commit(storage);
    for (const d of ["2025-12-31", "2026-01-01", "2026-01-15", "2026-02-01", "2026-02-15"]) {
      await w.commit({
        op: "I",
        collection: COLL,
        docId: d,
        body: { _id: d, created_at: d },
      });
    }
    const rows = await db
      .table<{ _id: string; created_at: string }>(COLL)
      .where({
        created_at: { $gte: "2026-01-01", $lt: "2026-02-01" },
      } as unknown as Predicate<{ _id: string; created_at: string }>)
      .all();
    expect(rows.map((r) => r._id).toSorted()).toEqual(["2026-01-01", "2026-01-15"]);
  });

  test("mixed operator + equality conjunction", async () => {
    await provision(storage);
    const w = commit(storage);
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", status: "open", count: 5 },
    });
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "t-2",
      body: { _id: "t-2", status: "open", count: 50 },
    });
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "t-3",
      body: { _id: "t-3", status: "closed", count: 5 },
    });
    const rows = await db
      .table<{ _id: string; status: string; count: number }>(COLL)
      .where({ status: "open", count: { $lt: 10 } } as unknown as Predicate<{
        _id: string;
        status: string;
        count: number;
      }>)
      .all();
    expect(rows.map((r) => r._id)).toEqual(["t-1"]);
  });

  test(".count() honours operator predicates", async () => {
    await provision(storage);
    const w = commit(storage);
    for (let i = 0; i < 5; i++) {
      await w.commit({
        op: "I",
        collection: COLL,
        docId: `t-${i}`,
        body: { _id: `t-${i}`, count: i },
      });
    }
    const n = await db
      .table<{ _id: string; count: number }>(COLL)
      .where({ count: { $gte: 2 } } as unknown as Predicate<{ _id: string; count: number }>)
      .count();
    expect(n).toBe(3);
  });

  test("type mismatch on a range op is always-miss, not a throw", async () => {
    await provision(storage);
    const w = commit(storage);
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", count: "5" } as unknown as JSONArraylessObject,
    });
    const rows = await db
      .table<{ _id: string; count: number }>(COLL)
      .where({ count: { $gte: 1 } } as unknown as Predicate<{ _id: string; count: number }>)
      .all();
    expect(rows).toEqual([]);
  });
});

describe("auto-planner range and $in walks (T3)", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = new MemoryStorage();
  });

  const dbWithByPriority = (): Db =>
    Db.create({
      storage,
      app: APP,
      tenant: TENANT,
      indexes: new Map([[COLL, [{ name: "by_priority", on: "priority" }]]]),
    });

  const dbWithByStatus = (): Db =>
    Db.create({
      storage,
      app: APP,
      tenant: TENANT,
      indexes: new Map([[COLL, [{ name: "by_status", on: "status" }]]]),
    });

  const dbWithComposite = (): Db =>
    Db.create({
      storage,
      app: APP,
      tenant: TENANT,
      indexes: new Map([[COLL, [{ name: "by_tenant_age", on: ["tenant", "age"] }]]]),
    });

  test("single-field range walk over string-typed field returns the slice", async () => {
    // Seed docs with `priority` ∈ {p1..p9}. Index on `priority`.
    // Walk inclusive lower / exclusive upper [p3, p7).
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_priority", on: "priority" }] },
    });
    for (let i = 1; i <= 9; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `t-${i}`,
        body: { _id: `t-${i}`, priority: `p${i}` },
      });
    }
    const db = dbWithByPriority();
    const rows = await db
      .table<{ _id: string; priority: string }>(COLL)
      .where({ priority: { $gte: "p3", $lt: "p7" } } as unknown as Predicate<{
        _id: string;
        priority: string;
      }>)
      .all();
    expect(rows.map((r) => r.priority).toSorted()).toEqual(["p3", "p4", "p5", "p6"]);
  });

  test("exclusive lower bound walk skips the lower-bound bucket via sentinel", async () => {
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_priority", on: "priority" }] },
    });
    for (let i = 1; i <= 5; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `t-${i}`,
        body: { _id: `t-${i}`, priority: `p${i}` },
      });
    }
    const db = dbWithByPriority();
    // $gt:p2 is exclusive — should NOT include p2.
    const rows = await db
      .table<{ _id: string; priority: string }>(COLL)
      .where({ priority: { $gt: "p2" } } as unknown as Predicate<{
        _id: string;
        priority: string;
      }>)
      .all();
    expect(rows.map((r) => r.priority).toSorted()).toEqual(["p3", "p4", "p5"]);
  });

  test("inclusive upper bound walk includes the upper-bound bucket", async () => {
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_priority", on: "priority" }] },
    });
    for (let i = 1; i <= 5; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `t-${i}`,
        body: { _id: `t-${i}`, priority: `p${i}` },
      });
    }
    const db = dbWithByPriority();
    const rows = await db
      .table<{ _id: string; priority: string }>(COLL)
      .where({ priority: { $lte: "p3" } } as unknown as Predicate<{
        _id: string;
        priority: string;
      }>)
      .all();
    expect(rows.map((r) => r.priority).toSorted()).toEqual(["p1", "p2", "p3"]);
  });

  test("composite eq+range walk constrains to the matching slice", async () => {
    // Seed (tenant, age) where `age` is string-typed (zero-padded
    // IDs) to dodge the numeric-range guard.
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_tenant_age", on: ["tenant", "age"] }] },
    });
    const seedDocs = [
      { id: "a1", tenant: "acme", age: "012" },
      { id: "a2", tenant: "acme", age: "025" },
      { id: "a3", tenant: "acme", age: "050" },
      { id: "a4", tenant: "acme", age: "099" },
      { id: "a5", tenant: "acme", age: "100" },
      { id: "b1", tenant: "beta", age: "025" },
      { id: "b2", tenant: "beta", age: "050" },
    ];
    for (const d of seedDocs) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: d.id,
        body: { _id: d.id, tenant: d.tenant, age: d.age },
      });
    }
    const db = dbWithComposite();
    // [012, 099) within tenant=acme — should include a1, a2, a3 but
    // NOT a4 (099 is excluded by $lt) or a5 (out of range) or b1/b2
    // (wrong tenant).
    const rows = await db
      .table<{ _id: string; tenant: string; age: string }>(COLL)
      .where({ tenant: "acme", age: { $gte: "012", $lt: "099" } } as unknown as Predicate<{
        _id: string;
        tenant: string;
        age: string;
      }>)
      .all();
    expect(rows.map((r) => r._id).toSorted()).toEqual(["a1", "a2", "a3"]);
  });

  test("$in multi-walk returns the union of matching docs", async () => {
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_status", on: "status" }] },
    });
    const seed = [
      { id: "t-1", status: "open" },
      { id: "t-2", status: "pending" },
      { id: "t-3", status: "done" },
      { id: "t-4", status: "open" },
      { id: "t-5", status: "blocked" },
    ];
    for (const d of seed) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: d.id,
        body: { _id: d.id, status: d.status },
      });
    }
    const db = dbWithByStatus();
    const rows = await db
      .table<{ _id: string; status: string }>(COLL)
      .where({ status: { $in: ["open", "done"] } } as unknown as Predicate<{
        _id: string;
        status: string;
      }>)
      .all();
    expect(rows.map((r) => r._id).toSorted()).toEqual(["t-1", "t-3", "t-4"]);
  });

  test("stale-entry post-filter defence: range walk drops obsolete index entries", async () => {
    // Insert a doc at priority="p2", then update to priority="p5".
    // Both entries land on disk via the writer's diff-old-new emit,
    // so the by_priority/<p2-b32>/<doc>.json key is deleted and the
    // by_priority/<p5-b32>/<doc>.json key is added. Quick verify:
    // querying $gte:p4 returns the doc once (under its new p5); a
    // query $lte:p3 returns nothing (the p2 entry has been deleted
    // by the writer's diff, AND the matches() re-check would catch
    // any leftover anyway).
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_priority", on: "priority" }] },
    });
    await writer.commit({
      op: "I",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", priority: "p2" },
    });
    await writer.commit({
      op: "U",
      collection: COLL,
      docId: "t-1",
      body: { _id: "t-1", priority: "p5" },
    });
    const db = dbWithByPriority();
    const above = await db
      .table<{ _id: string; priority: string }>(COLL)
      .where({ priority: { $gte: "p4" } } as unknown as Predicate<{
        _id: string;
        priority: string;
      }>)
      .all();
    expect(above.map((r) => r._id)).toEqual(["t-1"]);
    const below = await db
      .table<{ _id: string; priority: string }>(COLL)
      .where({ priority: { $lte: "p3" } } as unknown as Predicate<{
        _id: string;
        priority: string;
      }>)
      .all();
    expect(below).toEqual([]);
  });

  test("numeric range falls back to full-scan and returns the right rows", async () => {
    // Seed 10 docs with age ∈ 1..10. Index on `age`. Query
    // $gte:5, $lte:8 — the planner refuses to route this (numeric-
    // range guard) and falls through to the full-scan path. Verify
    // the full-scan path returns exactly 4 docs (age ∈ {5,6,7,8}).
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_age", on: "age" }] },
    });
    for (let i = 1; i <= 10; i++) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `t-${i}`,
        body: { _id: `t-${i}`, age: i },
      });
    }
    const db = Db.create({
      storage,
      app: APP,
      tenant: TENANT,
      indexes: new Map([[COLL, [{ name: "by_age", on: "age" }]]]),
    });
    const rows = await db
      .table<{ _id: string; age: number }>(COLL)
      .where({ age: { $gte: 5, $lte: 8 } } as unknown as Predicate<{
        _id: string;
        age: number;
      }>)
      .all();
    expect(rows.map((r) => r.age).toSorted((a, b) => a - b)).toEqual([5, 6, 7, 8]);
  });

  test("range on non-last indexed field still returns correct rows via postFilter", async () => {
    // Composite [tenant, age]. Predicate {tenant:{$gt:"a"}, age:"012"}
    // — the planner treats `tenant` itself as the tail range slot
    // (no equality consumes it), pushes the age=012 into postFilter.
    // Verify result matches the in-memory full-scan.
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_tenant_age", on: ["tenant", "age"] }] },
    });
    const seed = [
      { id: "a1", tenant: "acme", age: "012" },
      { id: "a2", tenant: "acme", age: "099" },
      { id: "b1", tenant: "beta", age: "012" },
      { id: "z1", tenant: "zeta", age: "012" },
    ];
    for (const d of seed) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: d.id,
        body: { _id: d.id, tenant: d.tenant, age: d.age },
      });
    }
    const db = dbWithComposite();
    const rows = await db
      .table<{ _id: string; tenant: string; age: string }>(COLL)
      .where({ tenant: { $gt: "a" }, age: "012" } as unknown as Predicate<{
        _id: string;
        tenant: string;
        age: string;
      }>)
      .all();
    // All tenants are > "a" lexically. age must equal "012".
    expect(rows.map((r) => r._id).toSorted()).toEqual(["a1", "b1", "z1"]);
  });

  test("numeric range walk returns the right rows", async () => {
    // End-to-end smoke for the value-order-preserving numeric encoder.
    // Under the old byte-order-preserving encoder, `age=9` lex-sorted
    // ABOVE `age=10` (one byte 0x39 vs two bytes 0x31 0x30), so a
    // `$gte:10` walk could miss multi-digit rows or include `9`. With
    // the new encoder, `{$gte:10, $lt:30}` returns exactly [10,15,18,22].
    await provision(storage);
    const writer = new ServerWriter({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_age", on: "age" }] },
    });
    for (const age of [9, 10, 15, 18, 22, 30, 100]) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: `u-${age}`,
        body: { _id: `u-${age}`, age },
      });
    }
    const db = Db.create({
      storage,
      app: APP,
      tenant: TENANT,
      indexes: new Map([[COLL, [{ name: "by_age", on: "age" }]]]),
    });
    const rows = await db
      .table<{ _id: string; age: number }>(COLL)
      .where({ age: { $gte: 10, $lt: 30 } } as unknown as Predicate<{
        _id: string;
        age: number;
      }>)
      .all();
    expect(rows.map((r) => r.age).toSorted((a, b) => a - b)).toEqual([10, 15, 18, 22]);
  });
});
