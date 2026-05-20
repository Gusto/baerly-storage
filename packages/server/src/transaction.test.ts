/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol/src/table-api.ts`'s `Table<T>`
   declaration); tests read it from emitted log entries. */

/**
 * `Db.transaction(table, body)` — single-attempt commitBatch.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  createCurrentJson,
  type LogEntry,
  MemoryStorage,
  BaerlyError,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { beforeEach, describe, expect, test } from "vitest";
import { Db } from "./db.ts";

const APP = "test";
const TENANT = "t";
const TABLE = "tickets";
const currentJsonKey = (table = TABLE): string =>
  `app/${APP}/tenant/${TENANT}/manifests/${table}/current.json`;
const logKey = (seq: number, table = TABLE): string =>
  `app/${APP}/tenant/${TENANT}/manifests/${table}/log/${seq}.json`;

const seedCurrent = (): CurrentJson => ({
  schema_version: CURRENT_JSON_SCHEMA_VERSION,
  snapshot: null,
  next_seq: 0,
  log_seq_start: 0,
  writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
});

const decodeJson = <T>(bytes: Uint8Array): T => JSON.parse(new TextDecoder().decode(bytes)) as T;

const readEntry = async (storage: MemoryStorage, seq: number): Promise<LogEntry> => {
  const got = await storage.get(logKey(seq));
  if (got === null) {
    throw new Error(`log entry ${seq} missing`);
  }
  return decodeJson<LogEntry>(got.body);
};

const readCurrent = async (storage: MemoryStorage): Promise<CurrentJson> => {
  const got = await storage.get(currentJsonKey());
  if (got === null) {
    throw new Error("current.json missing");
  }
  return decodeJson<CurrentJson>(got.body);
};

const makeDb = (storage: MemoryStorage): Db => Db.create({ storage, app: APP, tenant: TENANT });

const provision = async (storage: MemoryStorage, table = TABLE): Promise<void> => {
  await createCurrentJson(storage, currentJsonKey(table), seedCurrent());
};

/**
 * Test-only `MemoryStorage` subclass that injects a CAS failure on
 * the FIRST `If-Match` PUT of a tracked `current.json` key. Local to
 * this test file — NOT exported from `@baerly/server`. Mirrors the
 * pattern in `server-writer.test.ts`.
 */
class InstrumentedStorage extends MemoryStorage {
  failNextCasOnce = false;
  casAttempts = 0;
  readonly trackedKey: string;

  constructor(trackedKey: string) {
    super();
    this.trackedKey = trackedKey;
  }

  override async put(
    key: string,
    body: Uint8Array,
    opts?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    if (key === this.trackedKey && opts?.ifMatch !== undefined) {
      this.casAttempts += 1;
      if (this.failNextCasOnce) {
        this.failNextCasOnce = false;
        throw new BaerlyError("Conflict", `simulated CAS 412 on ${key}: precondition failed`);
      }
    }
    return super.put(key, body, opts);
  }
}

describe("Db.transaction", () => {
  let storage: MemoryStorage;
  let db: Db;

  beforeEach(() => {
    storage = new MemoryStorage();
    db = makeDb(storage);
  });

  test("commits one insert under one CAS", async () => {
    await provision(storage);

    await db.transaction(TABLE, async (tx) => {
      await tx.insert({ _id: "doc-1", title: "hello" });
    });

    const persisted = await readCurrent(storage);
    expect(persisted.next_seq).toBe(1);

    const entry = await readEntry(storage, 0);
    expect(entry.op).toBe("I");
    expect(entry.collection).toBe(TABLE);
    expect(entry.doc_id).toBe("doc-1");
    expect(entry.schema_version).toBe(0);
    expect(entry.seq).toBe(0);
    expect(entry.session).toHaveLength(6);
    expect(entry.new).toEqual({ _id: "doc-1", title: "hello" });
    expect(entry.patch).toEqual({ _id: "doc-1", title: "hello" });
  });

  test("two inserts share one session id and contiguous seq numbers", async () => {
    await provision(storage);

    await db.transaction(TABLE, async (tx) => {
      await tx.insert({ _id: "a", v: 1 });
      await tx.insert({ _id: "b", v: 2 });
    });

    const persisted = await readCurrent(storage);
    expect(persisted.next_seq).toBe(2);

    const e0 = await readEntry(storage, 0);
    const e1 = await readEntry(storage, 1);
    expect(e0.seq).toBe(0);
    expect(e1.seq).toBe(1);
    expect(e0.doc_id).toBe("a");
    expect(e1.doc_id).toBe("b");
    // One session id per transaction, shared across every entry.
    expect(e0.session).toBe(e1.session);
    expect(e0.session).toHaveLength(6);
  });

  test("mixed I + U + D in one transaction lands in input order under one CAS", async () => {
    await provision(storage);

    // Pre-seed an existing doc so the update + delete have something
    // to act on — the read inside the tx body sees LIVE state.
    await db.table(TABLE).insert({ _id: "existing", v: "v0" });
    const beforeTx = await readCurrent(storage);
    expect(beforeTx.next_seq).toBe(1);

    await db.transaction(TABLE, async (tx) => {
      await tx.insert({ _id: "new-doc", v: "n" });
      const updated = await tx.where({ _id: "existing" }).update({ v: "v1" });
      expect(updated.modified).toBe(1);
      const deleted = await tx.where({ _id: "existing" }).delete();
      expect(deleted.deleted).toBe(1);
    });

    const persisted = await readCurrent(storage);
    // 1 pre-seed + 3 tx entries = 4
    expect(persisted.next_seq).toBe(4);

    const i = await readEntry(storage, 1);
    const u = await readEntry(storage, 2);
    const d = await readEntry(storage, 3);
    expect(i.op).toBe("I");
    expect(u.op).toBe("U");
    expect(d.op).toBe("D");
    expect(i.doc_id).toBe("new-doc");
    expect(u.doc_id).toBe("existing");
    expect(d.doc_id).toBe("existing");
    // All three transaction entries share one session id.
    expect(u.session).toBe(i.session);
    expect(d.session).toBe(i.session);
    // Delete entries carry neither `new` nor `patch` (PATCH_ONLY +
    // op === "D" — `ServerWriter.validateInput` rejects a body).
    expect(d.new).toBeUndefined();
    expect(d.patch).toBeUndefined();
    // U carries `new === patch` under per-doc-replace.
    expect(u.new).toEqual({ _id: "existing", v: "v1" });
    expect(u.patch).toEqual({ _id: "existing", v: "v1" });
  });

  test("reads inside the tx see live state (e.g. an insert from before the tx)", async () => {
    await provision(storage);
    await db.table(TABLE).insert({ _id: "pre", v: "p" });

    let observed: { _id: string; v: string } | undefined;
    await db.transaction<{ _id: string; v: string }>(TABLE, async (tx) => {
      observed = await tx.where({ _id: "pre" }).first();
    });
    expect(observed).toEqual({ _id: "pre", v: "p" });
  });

  test("reads do not see this transaction's buffered writes (no read-your-writes)", async () => {
    await provision(storage);

    let observedAfterBufferedInsert: { _id: string } | undefined;
    let bufferedCount = 0;
    await db.transaction<{ _id: string; v: number }>(TABLE, async (tx) => {
      await tx.insert({ _id: "buffered", v: 99 });
      // Live read does NOT see the buffered insert — current.json is
      // untouched until the post-body commitBatch.
      observedAfterBufferedInsert = await tx.where({ _id: "buffered" }).first();
      bufferedCount = await tx.count();
    });
    expect(observedAfterBufferedInsert).toBeUndefined();
    expect(bufferedCount).toBe(0);

    // After the tx commits, the doc IS visible.
    const after = await db
      .table<{ _id: string; v: number }>(TABLE)
      .where({ _id: "buffered" })
      .first();
    expect(after).toEqual({ _id: "buffered", v: 99 });
  });

  test("empty body is a no-op (current.json untouched)", async () => {
    await provision(storage);
    const before = await readCurrent(storage);
    expect(before.next_seq).toBe(0);

    await db.transaction(TABLE, async () => {
      // no-op
    });

    const after = await readCurrent(storage);
    expect(after.next_seq).toBe(0);

    // No log entries written.
    const log0 = await storage.get(logKey(0));
    expect(log0).toBeNull();
  });

  test("single-attempt: CAS loss throws Conflict (exactly ONE attempt, no retry)", async () => {
    const instrumented = new InstrumentedStorage(currentJsonKey());
    await provision(instrumented);
    instrumented.failNextCasOnce = true;
    const dbI = Db.create({ storage: instrumented, app: APP, tenant: TENANT });

    let thrown: unknown;
    try {
      await dbI.transaction(TABLE, async (tx) => {
        await tx.insert({ _id: "doomed" });
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(BaerlyError);
    expect((thrown as BaerlyError).code).toBe("Conflict");
    // Single-attempt: exactly ONE CAS PUT was issued (no retry).
    expect(instrumented.casAttempts).toBe(1);

    // current.json was NOT advanced.
    const persisted = await readCurrent(instrumented);
    expect(persisted.next_seq).toBe(0);
  });

  test("body throw skips the commit (no LogEntry, current.json untouched)", async () => {
    await provision(storage);
    const boom = new Error("boom");

    let thrown: unknown;
    try {
      await db.transaction(TABLE, async (tx) => {
        await tx.insert({ _id: "never" });
        throw boom;
      });
    } catch (error) {
      thrown = error;
    }

    // The body's error is re-thrown AS-IS — identity preserved.
    expect(thrown).toBe(boom);

    const persisted = await readCurrent(storage);
    expect(persisted.next_seq).toBe(0);

    const log0 = await storage.get(logKey(0));
    expect(log0).toBeNull();
  });

  test("LogEntry shape parity: tx entries share one session id; direct mutation has a different session", async () => {
    await provision(storage);

    await db.transaction(TABLE, async (tx) => {
      await tx.insert({ _id: "tx-doc", v: 1 });
    });
    await db.table(TABLE).insert({ _id: "direct-doc", v: 2 });

    const txEntry = await readEntry(storage, 0);
    const directEntry = await readEntry(storage, 1);

    // Same field set in both entries (PATCH_ONLY, op:I, per-doc-replace).
    const keysOf = (e: LogEntry): string[] => Object.keys(e).toSorted();
    expect(keysOf(txEntry)).toEqual(keysOf(directEntry));

    // Sessions differ between a transaction and a direct mutation.
    expect(txEntry.session).not.toBe(directEntry.session);
    expect(txEntry.session).toHaveLength(6);
    expect(directEntry.session).toHaveLength(6);

    // Both carry the locked I-entry shape (`new === patch`).
    expect(txEntry.new).toEqual({ _id: "tx-doc", v: 1 });
    expect(txEntry.patch).toEqual({ _id: "tx-doc", v: 1 });
    expect(directEntry.new).toEqual({ _id: "direct-doc", v: 2 });
    expect(directEntry.patch).toEqual({ _id: "direct-doc", v: 2 });
  });

  test("cross-table mutation inside a tx is a compile-time error", async () => {
    await provision(storage);
    await provision(storage, "other");

    // The body callback receives `Table<T>`, not `Db`. Reaching for
    // a different table via the outer `db` is the bug path; this
    // file isn't permitted to call `db.table("other")` from inside
    // the body in a way TypeScript accepts as a same-shape write
    // through the `tx` argument. We document the intent here with a
    // `@ts-expect-error` directive: the body parameter is a Table,
    // so it has no `.table(...)` member.
    await db
      .transaction(TABLE, async (tx) => {
        // @ts-expect-error — Table<T> has no `table()` accessor; the
        //   only mutation surface is the bound `tx`.
        await tx.table("other").insert({ _id: "x" });
      })
      .catch(() => {
        // Runtime path: the bad call throws because `tx.table` is not
        // a function. The compile-time check is the load-bearing
        // assertion — vitest doesn't run the `@ts-expect-error`
        // branch, but tsgo --noEmit catches it.
      });
  });
});
