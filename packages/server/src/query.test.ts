/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol/src/collection-api.ts`'s `Collection<T>`
   declaration); reads expose it on rows. */

/**
 * Read terminals — `first`, `all`, `count` — against
 * `MemoryStorage`. No infra required.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  createCurrentJson,
  type DocumentData,
  MemoryStorage,
  BaerlyError,
  type PredicateWire,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { beforeEach, describe, expect, test } from "vitest";
import { compact, type InternalCompactOptions } from "./compactor.ts";
import { Db } from "./db.ts";
import { planQuery } from "./query-planner.ts";
import { runAllWithMeta, singleIdFromPredicate } from "./query.ts";

const wireOf = (clauses: PredicateWire["clauses"]): PredicateWire => ({ clauses });
import { Writer } from "./writer.ts";

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
  log_seq_start: 0,
  writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
  tail_bytes: 0,
  snapshot_bytes: 0,
  snapshot_rows: 0,
});

const makeDb = (storage: MemoryStorage): Db => Db.create({ storage, app: APP, tenant: TENANT });

const provision = async (storage: MemoryStorage, coll = COLL): Promise<void> => {
  await createCurrentJson(storage, currentJsonKey(coll), seedCurrent());
};

const commit = (storage: MemoryStorage, coll = COLL): Writer =>
  new Writer({ storage, currentJsonKey: currentJsonKey(coll) });

describe("Db.collection read terminals", () => {
  let storage: MemoryStorage;
  let db: Db;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = makeDb(storage);
  });

  test("case 1: empty table (next_seq=0) returns [], undefined, 0", async () => {
    await provision(storage);
    const t = db.collection(COLL);
    await expect(t.where({}).all()).resolves.toEqual([]);
    await expect(t.where({}).first()).resolves.toBeUndefined();
    await expect(t.count()).resolves.toBe(0);
  });

  test("case 2: missing current.json returns [], undefined, 0 (no throw)", async () => {
    // No provision call — current.json doesn't exist.
    const t = db.collection(COLL);
    await expect(t.where({}).all()).resolves.toEqual([]);
    await expect(t.where({}).first()).resolves.toBeUndefined();
    await expect(t.count()).resolves.toBe(0);
  });

  test("case 3: single insert via Writer is visible to all()", async () => {
    await provision(storage);
    const w = commit(storage);
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "doc-1",
      body: { _id: "doc-1", title: "hello" },
    });

    const rows = await db.collection(COLL).where({}).all();
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

    const q = db.collection(COLL).where({ status: "open" });
    const rows = await q.all();
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r["_id"]).toSorted()).toEqual(["a", "c"]);
    await expect(q.count()).resolves.toBe(2);
    const head = await q.first();
    expect(head).toBeDefined();
    expect((head as { status: string }).status).toBe("open");
  });

  test("case 5: .where().where() AND-merges via mergePredicateWires", async () => {
    await provision(storage);
    const w = commit(storage);
    await w.commit({ op: "I", collection: COLL, docId: "1", body: { _id: "1", a: 1, b: 2 } });
    await w.commit({ op: "I", collection: COLL, docId: "2", body: { _id: "2", a: 1, b: 3 } });
    await w.commit({ op: "I", collection: COLL, docId: "3", body: { _id: "3", a: 2, b: 2 } });

    const rows = await db.collection(COLL).where({ a: 1 }).where({ b: 2 }).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]!["_id"]).toBe("1");
  });

  test("case 6: .order() asc/desc on a monotonically-varying field", async () => {
    await provision(storage);
    const w = commit(storage);
    // Insert in a deliberately-unsorted order so the sort is doing work.
    await w.commit({ op: "I", collection: COLL, docId: "b", body: { _id: "b", n: 2 } });
    await w.commit({ op: "I", collection: COLL, docId: "a", body: { _id: "a", n: 1 } });
    await w.commit({ op: "I", collection: COLL, docId: "c", body: { _id: "c", n: 3 } });

    const asc = await db.collection(COLL).order({ n: "asc" }).all();
    expect(asc.map((r) => r["_id"])).toEqual(["a", "b", "c"]);
    const desc = await db.collection(COLL).order({ n: "desc" }).all();
    expect(desc.map((r) => r["_id"])).toEqual(["c", "b", "a"]);
  });

  test("case 7: .limit(n) truncates results", async () => {
    await provision(storage);
    const w = commit(storage);
    for (const id of ["a", "b", "c"]) {
      await w.commit({ op: "I", collection: COLL, docId: id, body: { _id: id, n: 1 } });
    }
    const rows = await db.collection(COLL).order({ _id: "asc" }).limit(2).all();
    expect(rows.map((r) => r["_id"])).toEqual(["a", "b"]);
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

    const rows = await db.collection(COLL).where({}).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ _id: "A", v: "v2" });
  });

  test("case 9: chain immutability — .where() returns a new object; original Collection is unchanged", async () => {
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

    const table = db.collection(COLL);
    const q1 = table.where({ status: "open" });
    // The Query returned is a fresh object — identity inequality with
    // the Collection it came from.
    expect(q1 as unknown).not.toBe(table as unknown);
    // Chaining another modifier on the ORIGINAL table sees no
    // predicate state from `q1` (frozen-state invariant).
    const all = await table.where({}).all();
    expect(all).toHaveLength(2);
    // And `q1` is still narrow.
    const open = await q1.all();
    expect(open).toHaveLength(1);
    expect(open[0]!["_id"]).toBe("1");
    // Two consecutive `.where` calls produce distinct Query objects.
    // (`_id` is excluded from `Path<T>` — use `.get(id)` for that
    // shape; here we just exercise the chain.)
    const q2 = q1.where({ status: "open" });
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
    const wA = new Writer({
      storage,
      currentJsonKey: `app/${APP}/tenant/alice/manifests/${COLL}/current.json`,
    });
    const wB = new Writer({
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

    const aRows = await dbA.collection(COLL).where({}).all();
    const bRows = await dbB.collection(COLL).where({}).all();
    expect(aRows.map((r) => r["_id"])).toEqual(["alice-doc"]);
    expect(bRows.map((r) => r["_id"])).toEqual(["bob-doc"]);
  });

  test("case 11: invalid table name throws InvalidConfig", async () => {
    // Empty name → InvalidConfig (constructed at .collection() call).
    expect(() => db.collection("")).toThrow(BaerlyError);
    try {
      db.collection("");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
    // Slash in name → InvalidConfig.
    try {
      db.collection("a/b");
    } catch (error) {
      expect((error as BaerlyError).code).toBe("InvalidConfig");
    }
  });

  test("case 12: malformed log entry surfaces as InvalidResponse", async () => {
    // Bootstrap current.json claiming one log entry exists, then plant
    // a non-JSON body at log/0.json. The reader walks [0, 1) and
    // chokes on the parse.
    await createCurrentJson(storage, currentJsonKey(COLL), seedCurrent(1));
    await storage.put(logKey(COLL, 0), new TextEncoder().encode("not-json{"));

    try {
      await db.collection(COLL).where({}).all();
      throw new Error("expected malformed log entry to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(BaerlyError);
      expect((error as BaerlyError).code).toBe("InvalidResponse");
    }
  });

  test("case 13: read skips log entries below log_seq_start", async () => {
    // Bootstrap a collection with one I entry at seq=0, then manually
    // CAS-write current.json with log_seq_start=1. The reader's bound
    // becomes [1, 1) so the read returns empty even though log/0.json
    // still exists on the bucket. Tests the reader's bound; a populated
    // read across this boundary would use snapshot consumption via
    // `compact()` in `./compactor.ts`.
    await provision(storage);
    const w = commit(storage);
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "doc-1",
      body: { _id: "doc-1", title: "hello" },
    });

    // Sanity: the row is visible before we advance log_seq_start.
    await expect(db.collection(COLL).where({}).all()).resolves.toHaveLength(1);

    // Manually advance log_seq_start to 1 (simulates a compactor run
    // that folded log/0.json into a snapshot).
    const { casUpdateCurrentJson } = await import("@baerly/protocol");
    await casUpdateCurrentJson(storage, currentJsonKey(COLL), (c) => ({
      ...c,
      log_seq_start: 1,
    }));

    // Reader now walks [1, 1) → empty.
    await expect(db.collection(COLL).where({}).all()).resolves.toEqual([]);
    await expect(db.collection(COLL).count()).resolves.toBe(0);
    await expect(db.collection(COLL).where({}).first()).resolves.toBeUndefined();
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
      tail_bytes: 0,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    });
    // Plant only the live log entry.
    const entry = {
      lsn: "fake-lsn",
      commit_ts: new Date().toISOString(),
      op: "I" as const,
      collection: COLL,
      doc_id: "live",
      session: "fakesess1",
      seq: 2,
      after: { _id: "live", v: 1 },
    };
    await storage.put(logKey(COLL, 2), new TextEncoder().encode(JSON.stringify(entry)));

    const rows = await db.collection(COLL).where({}).all();
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
    const before = await db.collection(COLL).order({ _id: "asc" }).all();
    expect(before).toHaveLength(50);

    const res = await compact({ storage, currentJsonKey: currentJsonKey(COLL) }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 100,
    } as InternalCompactOptions);
    expect(res.written).toBe(true);
    expect(res.logSeqStartAfter).toBe(50);

    const after = await db.collection(COLL).order({ _id: "asc" }).all();
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
    const res = await compact({ storage, currentJsonKey: currentJsonKey(COLL) }, {
      minEntriesToCompact: 10,
      maxEntriesPerRun: 100,
    } as InternalCompactOptions);
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

    const rows = await db.collection(COLL).where({}).all();
    expect(rows).toHaveLength(50);
    expect(rows.filter((r) => r["phase"] === "pre")).toHaveLength(40);
    expect(rows.filter((r) => r["phase"] === "post")).toHaveLength(10);
  });

  test("case 18: read sees the new pointer after a writer advances next_seq", async () => {
    // Invariant: a concurrent commit between two reads advances
    // `current.json`; the second read observes a new manifest pointer
    // and reports `fresh:true`. Every read carries `fresh:true` by
    // definition — reads always GET `current.json` fresh.
    await provision(storage);
    const w = commit(storage);
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "doc-1",
      body: { _id: "doc-1", title: "hello" },
    });

    const ctx = db.collectionReadContext(COLL);
    const baseState = {
      wire: undefined,
      order: undefined,
      limit: undefined,
    } as const;

    const r1 = await runAllWithMeta<DocumentData>(ctx, baseState);
    await w.commit({
      op: "I",
      collection: COLL,
      docId: "doc-2",
      body: { _id: "doc-2", title: "world" },
    });
    const r2 = await runAllWithMeta<DocumentData>(ctx, baseState);

    expect(r1.fresh).toBe(true);
    expect(r2.fresh).toBe(true);
    expect(r2.manifestPointer).not.toBe(r1.manifestPointer);
    expect(r1.rows.map((r) => r["_id"])).toEqual(["doc-1"]);
    expect(r2.rows.map((r) => r["_id"]).toSorted()).toEqual(["doc-1", "doc-2"]);
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
      config: {
        collections: { [COLL]: { indexes: [{ name: "by_status", on: "status" }] } },
      },
    });

  const dbWithComposite = (): Db =>
    Db.create({
      storage,
      app: APP,
      tenant: TENANT,
      config: {
        collections: {
          [COLL]: { indexes: [{ name: "by_status_priority", on: ["status", "priority"] }] },
        },
      },
    });

  test("auto-routes a single-field equality predicate to the declared index", async () => {
    await provision(storage);
    const writer = new Writer({
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
    const rows = await db.collection(COLL).where({ status: "open" }).all();
    const ids = rows.map((r) => r["_id"]).toSorted();
    expect(ids).toEqual(["t-1", "t-2"]);
  });

  test("returns empty result when the index prefix is empty (no matches)", async () => {
    await provision(storage);
    const writer = new Writer({
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
    const rows = await db.collection(COLL).where({ status: "wip" }).all();
    expect(rows).toEqual([]);
  });

  test("applies the predicate residue when the predicate has multiple keys", async () => {
    // The planner routes through `by_status` at prefix-length 1; the
    // post-fetch `matches(...)` re-check filters by `assignee`.
    await provision(storage);
    const writer = new Writer({
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
    const rows = await db.collection(COLL).where({ status: "open", assignee: "alice" }).all();
    expect(rows.map((r) => r["_id"])).toEqual(["t-1"]);
  });

  test("respects .limit() applied after the index walk", async () => {
    await provision(storage);
    const writer = new Writer({
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
    const rows = await db.collection(COLL).where({ status: "open" }).limit(2).all();
    expect(rows).toHaveLength(2);
  });

  test("composite index routes a two-field equality predicate through the walk path", async () => {
    // [status, priority] index, full walk (length 2 of 2). Each
    // yielded key has tail `<docId>.json` (single segment).
    await provision(storage);
    const writer = new Writer({
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
    const rows = await db.collection(COLL).where({ status: "open", priority: "p2" }).all();
    expect(rows.map((r) => r["_id"])).toEqual(["t-1"]);
  });

  test("composite index walked at partial prefix returns the right docs", async () => {
    // [status, priority] index, walked at partial-prefix length 1
    // (`status` only). Each yielded key has tail
    // `<priority-b32>/<docId>.json` — TWO segments. This exercises
    // the multi-segment doc-id extraction in `runIndexWalkPlan`.
    await provision(storage);
    const writer = new Writer({
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
    const rows = await db.collection(COLL).where({ status: "open" }).all();
    expect(rows.map((r) => r["_id"]).toSorted()).toEqual(["t-1", "t-2", "t-3"]);
  });

  test("composite [a,b,c] index walked at prefix [a,b] returns the right docs", async () => {
    // Three-field index walked at length 2 of 3. Each yielded key
    // has tail `<c-b32>/<docId>.json` — TWO segments — exercising
    // the same multi-segment extraction as the [status, priority]
    // case but with a deeper tail. Fixture: 3 (a,b) groups × 3 c-
    // values × ~1 doc/c = ~9 docs; assert just the 3 docs whose
    // (a,b) = (1,2).
    await provision(storage);
    const writer = new Writer({
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
      config: {
        collections: { [COLL]: { indexes: [{ name: "by_a_b_c", on: ["a", "b", "c"] }] } },
      },
    });
    const rows = await db.collection(COLL).where({ a: 1, b: 2 }).all();
    expect(rows.map((r) => r["_id"]).toSorted()).toEqual(["x-1", "x-2", "x-3"]);
  });

  test("mixed predicate with an operator clause walks the index and in-memory-filters the operator", async () => {
    // The planner routes on the equality clause; the operator clause
    // lands on the post-fetch matches() re-check.
    await provision(storage);
    const writer = new Writer({
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
      .collection(COLL)
      .where((q) => q.eq("status", "open").gt("priority", "p2"))
      .all();
    expect(rows.map((r) => r["_id"])).toEqual(["t-3"]);
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
      .collection(COLL)
      .where((q) => q.gte("count", 3).lt("count", 7))
      .all();
    expect(rows.map((r) => r["count"] as number).toSorted((a, b) => a - b)).toEqual([3, 4, 5, 6]);
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
      .collection(COLL)
      .where((q) => q.in("priority", ["p1", "p2"]))
      .all();
    expect(rows.map((r) => r["_id"]).toSorted()).toEqual(["t-p1", "t-p2"]);
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
      .collection(COLL)
      .where((q) => q.gte("created_at", "2026-01-01").lt("created_at", "2026-02-01"))
      .all();
    expect(rows.map((r) => r["_id"]).toSorted()).toEqual(["2026-01-01", "2026-01-15"]);
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
      .collection(COLL)
      .where((q) => q.eq("status", "open").lt("count", 10))
      .all();
    expect(rows.map((r) => r["_id"])).toEqual(["t-1"]);
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
      .collection(COLL)
      .where((q) => q.gte("count", 2))
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
      body: { _id: "t-1", count: "5" } as unknown as DocumentData,
    });
    const rows = await db
      .collection(COLL)
      .where((q) => q.gte("count", 1))
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
      config: {
        collections: { [COLL]: { indexes: [{ name: "by_priority", on: "priority" }] } },
      },
    });

  const dbWithByStatus = (): Db =>
    Db.create({
      storage,
      app: APP,
      tenant: TENANT,
      config: {
        collections: { [COLL]: { indexes: [{ name: "by_status", on: "status" }] } },
      },
    });

  const dbWithComposite = (): Db =>
    Db.create({
      storage,
      app: APP,
      tenant: TENANT,
      config: {
        collections: {
          [COLL]: { indexes: [{ name: "by_tenant_age", on: ["tenant", "age"] }] },
        },
      },
    });

  test("single-field range walk over string-typed field returns the slice", async () => {
    // Seed docs with `priority` ∈ {p1..p9}. Index on `priority`.
    // Walk inclusive lower / exclusive upper [p3, p7).
    await provision(storage);
    const writer = new Writer({
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
      .collection(COLL)
      .where((q) => q.gte("priority", "p3").lt("priority", "p7"))
      .all();
    expect(rows.map((r) => r["priority"]).toSorted()).toEqual(["p3", "p4", "p5", "p6"]);
  });

  test("exclusive lower bound walk skips the lower-bound bucket via sentinel", async () => {
    await provision(storage);
    const writer = new Writer({
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
    // q.gt is exclusive — should NOT include p2.
    const rows = await db
      .collection(COLL)
      .where((q) => q.gt("priority", "p2"))
      .all();
    expect(rows.map((r) => r["priority"]).toSorted()).toEqual(["p3", "p4", "p5"]);
  });

  test("inclusive upper bound walk includes the upper-bound bucket", async () => {
    await provision(storage);
    const writer = new Writer({
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
      .collection(COLL)
      .where((q) => q.lte("priority", "p3"))
      .all();
    expect(rows.map((r) => r["priority"]).toSorted()).toEqual(["p1", "p2", "p3"]);
  });

  test("composite eq+range walk constrains to the matching slice", async () => {
    // Seed (tenant, age) where `age` is string-typed (zero-padded
    // values) so the composite eq+range walks over byte-order-stable
    // strings that match what `encodeIndexValue` produces — keeps the
    // assertion focused on the eq+range slicing rather than on the
    // numeric encoder's lex/value-order behaviour, which has its own
    // dedicated smoke test below.
    await provision(storage);
    const writer = new Writer({
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
      .collection(COLL)
      .where((q) => q.eq("tenant", "acme").gte("age", "012").lt("age", "099"))
      .all();
    expect(rows.map((r) => r["_id"]).toSorted()).toEqual(["a1", "a2", "a3"]);
  });

  test("$in multi-walk returns the union of matching docs", async () => {
    await provision(storage);
    const writer = new Writer({
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
      .collection(COLL)
      .where((q) => q.in("status", ["open", "done"]))
      .all();
    expect(rows.map((r) => r["_id"]).toSorted()).toEqual(["t-1", "t-3", "t-4"]);
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
    const writer = new Writer({
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
      .collection(COLL)
      .where((q) => q.gte("priority", "p4"))
      .all();
    expect(above.map((r) => r["_id"])).toEqual(["t-1"]);
    const below = await db
      .collection(COLL)
      .where((q) => q.lte("priority", "p3"))
      .all();
    expect(below).toEqual([]);
  });

  test("range on non-last indexed field still returns correct rows via postFilter", async () => {
    // Composite [tenant, age]. Predicate {tenant:{$gt:"a"}, age:"012"}
    // — the planner treats `tenant` itself as the tail range slot
    // (no equality consumes it), pushes the age=012 into postFilter.
    // Verify result matches the in-memory full-scan.
    await provision(storage);
    const writer = new Writer({
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
      .collection(COLL)
      .where((q) => q.gt("tenant", "a").eq("age", "012"))
      .all();
    // All tenants are > "a" lexically. age must equal "012".
    expect(rows.map((r) => r["_id"]).toSorted()).toEqual(["a1", "b1", "z1"]);
  });

  test("numeric range walk returns the right rows", async () => {
    // End-to-end smoke for the value-order-preserving numeric encoder.
    // Under the old byte-order-preserving encoder, `age=9` lex-sorted
    // ABOVE `age=10` (one byte 0x39 vs two bytes 0x31 0x30), so a
    // `$gte:10` walk could miss multi-digit rows or include `9`. With
    // the new encoder, `{$gte:10, $lt:30}` returns exactly [10,15,18,22].
    //
    // Pin the planner choice first so a regression that fell back to
    // full-scan (e.g. by reintroducing a `containsNumber` guard) would
    // trip this test instead of silently passing on the executor's
    // correctness — the surrounding cascade already covers that.
    await provision(storage);
    const writer = new Writer({
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
    const indexes = [{ name: "by_age", on: "age" }] as const;
    const plan = planQuery(
      wireOf([
        { op: "gte", field: "age", value: 10 },
        { op: "lt", field: "age", value: 30 },
      ]),
      indexes,
    );
    expect(plan.kind).toBe("index-walk");
    if (plan.kind === "index-walk") {
      expect(plan.indexName).toBe("by_age");
    }
    const db = Db.create({
      storage,
      app: APP,
      tenant: TENANT,
      config: { collections: { [COLL]: { indexes: [...indexes] } } },
    });
    const rows = await db
      .collection(COLL)
      .where((q) => q.gte("age", 10).lt("age", 30))
      .all();
    expect(rows.map((r) => r["age"] as number).toSorted((a, b) => a - b)).toEqual([10, 15, 18, 22]);
  });

  test("$in multi-walk returns the union of all values' docs", async () => {
    // Pin the union semantics of the parallel-batched $in walk. The
    // batched fan-out replaced a sequential per-value loop; if a
    // regression dropped a value or duplicated a doc this would trip.
    //
    // Seed via `Writer` directly for setup convenience —
    // equivalent to a `Db.create({ config })` path now that the
    // production wiring threads `config.collections[].indexes`.
    await provision(storage);
    const writer = new Writer({
      storage,
      currentJsonKey: currentJsonKey(COLL),
      options: { indexes: [{ name: "by_team", on: "team" }] },
    });
    for (const [id, team] of [
      ["a", "platform"],
      ["b", "infra"],
      ["c", "platform"],
      ["d", "data"],
      ["e", "growth"],
    ] as const) {
      await writer.commit({
        op: "I",
        collection: COLL,
        docId: id,
        body: { _id: id, team },
      });
    }
    const indexes = [{ name: "by_team", on: "team" }] as const;
    const plan = planQuery(
      wireOf([{ op: "in", field: "team", value: ["platform", "infra", "data"] }]),
      indexes,
    );
    expect(plan.kind).toBe("index-walk");
    if (plan.kind === "index-walk") {
      expect(plan.indexName).toBe("by_team");
      expect(plan.inOn?.values).toEqual(["platform", "infra", "data"]);
    }
    const db = Db.create({
      storage,
      app: APP,
      tenant: TENANT,
      config: { collections: { [COLL]: { indexes: [...indexes] } } },
    });
    const rows = await db
      .collection(COLL)
      .where((q) => q.in("team", ["platform", "infra", "data"]))
      .all();
    expect(rows.map((r) => r["_id"]).toSorted()).toEqual(["a", "b", "c", "d"]);
  });
});

/**
 * Detector unit tests for `singleIdFromPredicate` — the pure helper
 * the runRead fast-path consults. Locks the recognise-rule (exactly
 * one root key whose name is `_id` and whose value is a string) so
 * future predicate-shape changes can't silently widen or narrow
 * the short-circuit. Positive branches enable the fast-path;
 * negative branches MUST fall through to the scan path (the JSDoc
 * on `singleIdFromPredicate` and the integration test below rely on
 * exact-shape-only detection).
 */
describe("singleIdFromPredicate", () => {
  // The fast-path takes the kernel-internal wire shape; the wire
  // validator never sees these inputs (the byId / runByIdWithMeta /
  // runInsert paths mint them directly), so the detector accepts the
  // `_id` field even though `validateWire` would reject it on the
  // public path.
  test("positive: { clauses: [{op:'eq', field:'_id', value:'x'}] } → 'x'", () => {
    expect(singleIdFromPredicate(wireOf([{ op: "eq", field: "_id", value: "x" }]))).toBe("x");
  });

  test("positive: empty-string value passes the detector", () => {
    // Empty string passes the detector; lookup will always miss
    // because insert replaces empty _id with UUIDv7.
    expect(singleIdFromPredicate(wireOf([{ op: "eq", field: "_id", value: "" }]))).toBe("");
  });

  test("negative: undefined → undefined (no predicate, full scan)", () => {
    expect(singleIdFromPredicate(undefined)).toBeUndefined();
  });

  test("negative: empty clause list (match-all) → undefined", () => {
    expect(singleIdFromPredicate(wireOf([]))).toBeUndefined();
  });

  test("negative: single non-_id clause → undefined", () => {
    expect(
      singleIdFromPredicate(wireOf([{ op: "eq", field: "status", value: "open" }])),
    ).toBeUndefined();
  });

  test("negative: multi-clause wire including _id → undefined", () => {
    expect(
      singleIdFromPredicate(
        wireOf([
          { op: "eq", field: "_id", value: "x" },
          { op: "eq", field: "status", value: "open" },
        ]),
      ),
    ).toBeUndefined();
  });

  test("negative: non-eq op on _id → undefined", () => {
    expect(
      singleIdFromPredicate(wireOf([{ op: "in", field: "_id", value: ["x"] }])),
    ).toBeUndefined();
  });

  test("negative: non-string value on _id clause → undefined", () => {
    expect(singleIdFromPredicate(wireOf([{ op: "eq", field: "_id", value: 42 }]))).toBeUndefined();
  });
});

/**
 * PK-lookup fast-path integration. Confirms `.get(id)` against a
 * 100-entry collection hits the `singleIdFromPredicate` short-
 * circuit in `runRead` — one in-memory `docs.get(id)` lookup
 * instead of an `Array.from(docs.values()).filter(matches)` pass
 * over all 100 entries. Verified two ways: the counting `Storage`
 * proxy proves no extra log GETs over the scan-equivalent baseline
 * (so the fast-path doesn't accidentally regress on IO), and the
 * negative branches (multi-key, operator-shaped, non-_id) round-
 * trip through the scan path with identical observable results.
 *
 * Consistency note: the short-circuit returns the snapshot-time
 * view; concurrent commits on a different snapshot are invisible —
 * same semantics as the scan path on the same snapshot. Don't file
 * a phantom "fast-path returns stale data" bug — the snapshot is
 * the consistency boundary, not the predicate evaluator. See
 * `docs/spec/causal-consistency-checking.md`.
 */
describe("Query.first / Collection.get — PK-lookup fast-path", () => {
  /**
   * Hand-rolled `Storage` proxy counting `get`s on log entries (so
   * we can pin "the fast-path doesn't issue extra GETs"). Lives in
   * the test to keep it scoped — the broader counting harness in
   * `tests/fixtures/counting-storage.ts` only counts Class A ops
   * (PUT/DELETE/LIST), not GETs.
   */
  interface GetCountingStorage {
    readonly storage: Storage;
    readonly logGets: number;
  }
  const wrapGetCounter = (inner: Storage): GetCountingStorage => {
    let logGets = 0;
    const wrapped: Storage = {
      get: (key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> => {
        if (key.includes("/log/")) {
          logGets++;
        }
        return inner.get(key, opts);
      },
      put: (key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> =>
        inner.put(key, body, opts),
      delete: (key: string, opts?: { signal?: AbortSignal }): Promise<void> =>
        inner.delete(key, opts),
      list: function (
        prefix: string,
        opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
      ): AsyncIterable<StorageListEntry> {
        return inner.list(prefix, opts);
      },
    };
    return {
      storage: wrapped,
      get logGets() {
        return logGets;
      },
    };
  };

  const seedNDocs = async (
    n: number,
  ): Promise<{
    storage: MemoryStorage;
    target: { _id: string; n: number };
  }> => {
    const s = new MemoryStorage();
    await createCurrentJson(s, currentJsonKey(COLL), seedCurrent());
    const w = new Writer({ storage: s, currentJsonKey: currentJsonKey(COLL) });
    let target: { _id: string; n: number } | undefined;
    for (let i = 0; i < n; i++) {
      const id = `doc-${i.toString().padStart(3, "0")}`;
      const body = { _id: id, n: i };
      await w.commit({ op: "I", collection: COLL, docId: id, body });
      if (i === Math.floor(n / 2)) {
        target = body;
      }
    }
    if (target === undefined) {
      throw new Error("seedNDocs: target unset");
    }
    return { storage: s, target };
  };

  test("Collection.get(id) returns the right doc against a 100-entry collection", async () => {
    const { storage, target } = await seedNDocs(100);
    const db = Db.create({ storage, app: APP, tenant: TENANT });
    const row = await db.collection(COLL).get(target._id);
    expect(row).toBeDefined();
    expect(row).toEqual(target);
  });

  test("Collection.get(id) on a miss returns undefined (snapshot.get lookup, no row)", async () => {
    const { storage } = await seedNDocs(100);
    const db = Db.create({ storage, app: APP, tenant: TENANT });
    const row = await db.collection(COLL).get("no-such-id");
    expect(row).toBeUndefined();
  });

  test("Query.first() on { _id: 'doc-050' } returns target without extra log GETs vs scan", async () => {
    // Seed once into a shared inner store, then mount two independent
    // counters — one wrapping a `.get(id)` call, one wrapping a
    // semantically-equivalent scan (`.where({_id: ...}).first()`).
    // The fast-path branch consumes the same snapshot+log fold as
    // the scan, so the IO count must match: this regression-pins
    // "the fast-path doesn't regress GETs on the wire."
    const { storage, target } = await seedNDocs(100);

    const fastCounter = wrapGetCounter(storage);
    const dbFast = Db.create({ storage: fastCounter.storage, app: APP, tenant: TENANT });
    const fastRow = await dbFast.collection(COLL).get(target._id);
    const fastLogGets = fastCounter.logGets;

    const scanCounter = wrapGetCounter(storage);
    const dbScan = Db.create({ storage: scanCounter.storage, app: APP, tenant: TENANT });
    // Single-key non-`_id` predicate — falls through `singleIdFromPredicate`
    // to the scan path and walks the same log range.
    const scanRows = await dbScan.collection(COLL).where({ n: target.n }).all();
    const scanLogGets = scanCounter.logGets;

    expect(fastRow).toEqual(target);
    expect(scanRows).toHaveLength(1);
    expect(scanRows[0]).toEqual(target);
    // Fast-path must not issue MORE log GETs than the scan path —
    // both fold the same `[log_seq_start, next_seq)` range. (Equal
    // is the expected case today; "less than or equal" is the
    // forward-compat assertion.)
    expect(fastLogGets).toBeLessThanOrEqual(scanLogGets);
  });

  test("negative: single-key non-_id predicate falls through to scan and returns the match", async () => {
    const { storage, target } = await seedNDocs(100);
    const db = Db.create({ storage, app: APP, tenant: TENANT });
    const rows = await db.collection(COLL).where({ n: target.n }).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(target);
  });

  test("negative: non-_id callback predicate threads to scan and matches the doc", async () => {
    const { storage, target } = await seedNDocs(100);
    const db = Db.create({ storage, app: APP, tenant: TENANT });
    // The public `.where(...)` surface rejects `_id` at the wire
    // validator now (use `.get(id)` to hit it). A callback-form
    // predicate on a non-`_id` field still routes through the scan
    // path; the result is the doc that satisfies the equality.
    const rows = await db
      .collection(COLL)
      .where((q) => q.eq("n", target.n))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(target);
  });
});
