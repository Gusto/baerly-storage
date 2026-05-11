/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol/src/db.ts`'s `Table<T>`
   declaration); reads expose it on rows. */

/**
 * Phase-4 read terminals — examples per ticket 09 §5. All 12 cases
 * exercise the read path against `MemoryStorage`; no infra required.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  createCurrentJson,
  MemoryStorage,
  MPS3Error,
} from "@baerly/protocol";
import { beforeEach, describe, expect, test } from "vitest";
import { compact } from "./compactor";
import { Db } from "./db";
import { ServerWriter } from "./server-writer";

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
    expect(() => db.table("")).toThrow(MPS3Error);
    try {
      db.table("");
    } catch (err) {
      expect((err as MPS3Error).code).toBe("InvalidConfig");
    }
    // Slash in name → InvalidConfig.
    try {
      db.table("a/b");
    } catch (err) {
      expect((err as MPS3Error).code).toBe("InvalidConfig");
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
      expect(err).toBeInstanceOf(MPS3Error);
      expect((err as MPS3Error).code).toBe("InvalidResponse");
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
});
