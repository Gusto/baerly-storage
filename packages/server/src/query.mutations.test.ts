/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol/src/collection-api.ts`'s `Collection<T>` /
   `Query<T>` declarations); tests surface and assert on it by name. */

/**
 * Mutation terminals — `Collection.insert`, `Query.update`,
 * `Collection.replace`, `Query.delete`. MemoryStorage-only, pure-unit; no
 * infra required.
 *
 * The matrix this file covers:
 *  - Insert auto-id, caller-supplied id, duplicate-id Conflict,
 *    LogEntry shape parity.
 *  - Update single/multi-match, RFC 7386 null-delete, return shape,
 *    zero-match no-op.
 *  - Replace happy-path overwrite, `NotFound` on missing id,
 *    matched-row `_id` preservation when `doc._id` differs.
 *  - Delete tombstone shape (no after/before/key_old), return shape,
 *    post-delete visibility.
 *  - Per-row CAS retry semantics: forced contention succeeds within
 *    budget; exhausted budget surfaces Conflict.
 *
 * Fast-check property tests are explicitly OUT OF SCOPE — cross-
 * adapter coverage lives in `tests/integration/randomized.test.ts`.
 */

import {
  type Collection,
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  createCurrentJson,
  type DocumentData,
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
const COLL = "tickets";

const currentJsonKey = (coll: string = COLL): string =>
  `app/${APP}/tenant/${TENANT}/manifests/${coll}/current.json`;
const logKey = (seq: number, coll: string = COLL): string =>
  `app/${APP}/tenant/${TENANT}/manifests/${coll}/log/${seq}.json`;

const seedCurrent = (tail_hint = 0): CurrentJson => ({
  schema_version: CURRENT_JSON_SCHEMA_VERSION,
  snapshot: null,
  tail_hint,
  log_seq_start: 0,
  writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
  tail_bytes: 0,
  snapshot_bytes: 0,
  snapshot_rows: 0,
});

const provision = async (storage: MemoryStorage, coll: string = COLL): Promise<void> => {
  await createCurrentJson(storage, currentJsonKey(coll), seedCurrent());
};

const readLogEntry = async (storage: MemoryStorage, seq: number): Promise<LogEntry> => {
  const got = await storage.get(logKey(seq));
  if (got === null) {
    throw new Error(`expected log entry at seq ${seq}`);
  }
  return JSON.parse(new TextDecoder().decode(got.body)) as LogEntry;
};

interface TicketDoc extends DocumentData {
  _id: string;
  title: string;
  status: string;
}

describe("Collection.insert", () => {
  let storage: MemoryStorage;
  let db: Db;

  beforeEach(async () => {
    storage = new MemoryStorage();
    db = Db.create({ storage, app: APP, tenant: TENANT });
    await provision(storage);
  });

  test("auto-id mints UUIDv7 _id; doc visible via Collection.get(_id)", async () => {
    const t = db.collection(COLL) as Collection<TicketDoc>;
    const { _id } = await t.insert({ title: "hello", status: "open" });
    expect(typeof _id).toBe("string");
    // UUIDv7 wire format: 8-4-4-4-12 hex groups.
    expect(_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const found = await t.get(_id);
    expect(found).toEqual({ _id, title: "hello", status: "open" });
  });

  test("caller-supplied _id is honoured verbatim", async () => {
    const t = db.collection(COLL) as Collection<TicketDoc>;
    const { _id } = await t.insert({ _id: "custom-id-42", title: "x", status: "open" });
    expect(_id).toBe("custom-id-42");
    const found = await t.get("custom-id-42");
    expect(found).toBeDefined();
    expect(found!._id).toBe("custom-id-42");
  });

  test("duplicate _id on insert throws Conflict", async () => {
    const t = db.collection(COLL) as Collection<TicketDoc>;
    await t.insert({ _id: "dup", title: "first", status: "open" });
    let thrown: unknown;
    try {
      await t.insert({ _id: "dup", title: "second", status: "open" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BaerlyError);
    expect((thrown as BaerlyError).code).toBe("Conflict");
    // Cardinality / id should appear in the message so callers can
    // distinguish "duplicate id" from a generic CAS conflict.
    expect((thrown as BaerlyError).message).toContain("dup");
  });

  test("predicates do not gate insert: chain-bound Collection.insert still runs", async () => {
    // The locked `Query<T>` surface does not declare `insert`; the
    // public insert path is on `Collection<T>`. Confirm a chain that
    // restricts reads via `.where(...)` does not affect the insert
    // path — every insert goes through the table-level handle.
    const table = db.collection(COLL) as Collection<TicketDoc>;
    // Build a narrowing chain (we never consume it for the insert),
    // then insert through the table directly. The doc lands and is
    // visible regardless of the chain.
    const narrowed = table.where({ status: "closed" });
    expect(narrowed).toBeDefined();
    const { _id } = await table.insert({ title: "x", status: "open" });
    const rows = await table.where({}).all();
    expect(rows.map((r) => r._id)).toContain(_id);
  });

  test("LogEntry shape: I op carries after === {...doc, _id}", async () => {
    const t = db.collection(COLL) as Collection<TicketDoc>;
    await t.insert({ _id: "L1", title: "logged", status: "open" });
    const entry = await readLogEntry(storage, 0);
    expect(entry.op).toBe("I");
    expect(entry.collection).toBe(COLL);
    expect(entry.doc_id).toBe("L1");
    expect(entry.after).toEqual({ _id: "L1", title: "logged", status: "open" });
    // `PATCH_ONLY` replica_identity (today's default) carries no
    // pre-image fields on any op.
    expect(entry.before).toBeUndefined();
    expect(entry.key_old).toBeUndefined();
  });
});

describe("Query.update", () => {
  let storage: MemoryStorage;
  let db: Db;

  beforeEach(async () => {
    storage = new MemoryStorage();
    db = Db.create({ storage, app: APP, tenant: TENANT });
    await provision(storage);
  });

  test("applies merge patch on a single match; returns { modified: 1 }", async () => {
    const t = db.collection(COLL) as Collection<TicketDoc>;
    await t.insert({ _id: "u1", title: "old", status: "open" });
    const result = await t.update("u1", { title: "new" });
    expect(result).toEqual({ modified: 1 });
    const after = await t.get("u1");
    expect(after).toEqual({ _id: "u1", title: "new", status: "open" });
  });

  test("applies merge patch on multiple matches; returns { modified: N }", async () => {
    const t = db.collection(COLL) as Collection<TicketDoc>;
    await t.insert({ _id: "a", title: "1", status: "open" });
    await t.insert({ _id: "b", title: "2", status: "open" });
    await t.insert({ _id: "c", title: "3", status: "closed" });
    const result = await t.where({ status: "open" }).update({ status: "in-progress" });
    expect(result).toEqual({ modified: 2 });
    const open = await t.where({ status: "open" }).all();
    expect(open).toHaveLength(0);
    const progress = await t.where({ status: "in-progress" }).all();
    expect(progress.map((r) => r._id).toSorted()).toEqual(["a", "b"]);
    // c is untouched.
    const closed = await t.where({ status: "closed" }).all();
    expect(closed).toHaveLength(1);
    expect(closed[0]!._id).toBe("c");
  });

  test("RFC 7386 null deletes a field from the post-image", async () => {
    // Use the bare `DocumentData` shape rather than an
    // `interface ... extends` with an optional `flag` — the locked
    // `DocumentValue` value type does not include `undefined`, so an
    // optional-key extension doesn't satisfy the index signature.
    const t = db.collection(COLL) as Collection<TicketDoc>;
    await t.insert({ _id: "n1", title: "x", flag: true });
    // `null` per RFC 7386 deletes the key. The locked patch type is
    // `Partial<T>` (no `null` at the type level); test the runtime
    // contract via cast.
    await t.update("n1", { flag: null as unknown as DocumentData });
    const after = await t.get("n1");
    expect(after).toBeDefined();
    expect(after!["_id"]).toBe("n1");
    expect(after!["title"]).toBe("x");
    expect("flag" in after!).toBe(false);
  });

  test("zero matches: returns { modified: 0 } and emits no LogEntry", async () => {
    const t = db.collection(COLL) as Collection<TicketDoc>;
    await t.insert({ _id: "only", title: "x", status: "open" });
    const beforeNextSeq = (await storage.get(currentJsonKey()))!;
    const beforeCurrent: CurrentJson = JSON.parse(
      new TextDecoder().decode(beforeNextSeq.body),
    ) as CurrentJson;
    const result = await t.update("nope", { title: "y" });
    expect(result).toEqual({ modified: 0 });
    const afterRaw = (await storage.get(currentJsonKey()))!;
    const afterCurrent: CurrentJson = JSON.parse(
      new TextDecoder().decode(afterRaw.body),
    ) as CurrentJson;
    // tail_hint is unchanged when no rows match — no commit was issued.
    expect(afterCurrent.tail_hint).toBe(beforeCurrent.tail_hint);
  });

  test("emits one op:'U' LogEntry per affected doc with after as full post-image", async () => {
    const t = db.collection(COLL) as Collection<TicketDoc>;
    await t.insert({ _id: "e1", title: "t1", status: "open" });
    await t.insert({ _id: "e2", title: "t2", status: "open" });
    // current tail_hint is 2 after the two inserts; updates start at seq 2.
    await t.where({ status: "open" }).update({ status: "done" });
    const e2 = await readLogEntry(storage, 2);
    const e3 = await readLogEntry(storage, 3);
    for (const entry of [e2, e3]) {
      expect(entry.op).toBe("U");
      expect(entry.collection).toBe(COLL);
      expect(entry.after).toBeDefined();
      // PATCH_ONLY → no pre-image.
      expect(entry.before).toBeUndefined();
      expect(entry.key_old).toBeUndefined();
    }
  });
});

describe("Collection.replace", () => {
  let storage: MemoryStorage;
  let db: Db;

  beforeEach(async () => {
    storage = new MemoryStorage();
    db = Db.create({ storage, app: APP, tenant: TENANT });
    await provision(storage);
  });

  test("happy path: whole-document overwrite", async () => {
    const t = db.collection(COLL) as Collection<TicketDoc>;
    await t.insert({ _id: "r1", title: "old", status: "open" });
    await t.replace("r1", {
      _id: "r1",
      title: "completely-new",
      status: "archived",
    });
    const after = await t.get("r1");
    expect(after).toEqual({ _id: "r1", title: "completely-new", status: "archived" });
  });

  test("missing id: throws NotFound", async () => {
    const t = db.collection(COLL) as Collection<TicketDoc>;
    let thrown: unknown;
    try {
      await t.replace("missing", {
        _id: "missing",
        title: "x",
        status: "open",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BaerlyError);
    expect((thrown as BaerlyError).code).toBe("NotFound");
  });

  test("preserves the row's _id even when doc carries a different one", async () => {
    const t = db.collection(COLL) as Collection<TicketDoc>;
    await t.insert({ _id: "keep-me", title: "v1", status: "open" });
    await t.replace("keep-me", {
      _id: "different-id",
      title: "v2",
      status: "open",
    });
    // The requested id wins; the replaced doc lives under "keep-me".
    const after = await t.get("keep-me");
    expect(after).toBeDefined();
    expect(after!._id).toBe("keep-me");
    expect(after!.title).toBe("v2");
    // No row landed at "different-id".
    const ghost = await t.get("different-id");
    expect(ghost).toBeUndefined();
  });
});

describe("Query.delete", () => {
  let storage: MemoryStorage;
  let db: Db;

  beforeEach(async () => {
    storage = new MemoryStorage();
    db = Db.create({ storage, app: APP, tenant: TENANT });
    await provision(storage);
  });

  test("tombstones N matches; returns { deleted: N }; rows no longer visible", async () => {
    const t = db.collection(COLL) as Collection<TicketDoc>;
    await t.insert({ _id: "d1", title: "x", status: "open" });
    await t.insert({ _id: "d2", title: "y", status: "open" });
    await t.insert({ _id: "d3", title: "z", status: "closed" });
    const result = await t.where({ status: "open" }).delete();
    expect(result).toEqual({ deleted: 2 });
    const remaining = await t.where({}).all();
    expect(remaining.map((r) => r._id)).toEqual(["d3"]);
  });

  test("LogEntry shape: D op has no after / before / key_old", async () => {
    const t = db.collection(COLL) as Collection<TicketDoc>;
    await t.insert({ _id: "tomb", title: "soon-gone", status: "open" });
    await t.delete("tomb");
    // seq 0 is the insert; seq 1 is the delete.
    const entry = await readLogEntry(storage, 1);
    expect(entry.op).toBe("D");
    expect(entry.doc_id).toBe("tomb");
    expect(entry.collection).toBe(COLL);
    // PATCH_ONLY replica_identity + D op → none of these fields land.
    expect(entry.after).toBeUndefined();
    expect(entry.before).toBeUndefined();
    expect(entry.key_old).toBeUndefined();
  });

  test("zero matches: returns { deleted: 0 } and emits no LogEntry", async () => {
    const t = db.collection(COLL) as Collection<TicketDoc>;
    await t.insert({ _id: "k", title: "stays", status: "open" });
    const beforeRaw = (await storage.get(currentJsonKey()))!;
    const beforeNextSeq = (JSON.parse(new TextDecoder().decode(beforeRaw.body)) as CurrentJson)
      .tail_hint;
    const result = await t.delete("absent");
    expect(result).toEqual({ deleted: 0 });
    const afterRaw = (await storage.get(currentJsonKey()))!;
    const afterNextSeq = (JSON.parse(new TextDecoder().decode(afterRaw.body)) as CurrentJson)
      .tail_hint;
    expect(afterNextSeq).toBe(beforeNextSeq);
  });
});

// ---------------------------------------------------------------------
// Single-attempt CAS semantics (forced contention via InstrumentedStorage)
// ---------------------------------------------------------------------

/**
 * `MemoryStorage` subclass that injects CAS failures on the
 * collection's `current.json` to exercise the writer's internal
 * retry loop from the verb-call surface. Mirrors the pattern in
 * `writer.test.ts`. Kept local to this file — not exported.
 */
class InstrumentedStorage extends MemoryStorage {
  failNextNCas = 0;
  failEveryCas = false;
  casAttempts = 0;
  /** The `current.json` key this instance is configured to police. */
  watchedKey = currentJsonKey();

  override async put(
    key: string,
    body: Uint8Array,
    opts?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    if (key === this.watchedKey && opts?.ifMatch !== undefined) {
      this.casAttempts += 1;
      if (this.failEveryCas) {
        throw new BaerlyError("Conflict", `simulated CAS 412 on ${key}: precondition failed`);
      }
      if (this.failNextNCas > 0) {
        this.failNextNCas -= 1;
        throw new BaerlyError("Conflict", `simulated CAS 412 on ${key}: precondition failed`);
      }
    }
    return super.put(key, body, opts);
  }
}

describe("Per-row CAS semantics (internal retries inside Writer)", () => {
  test("forced CAS contention within budget: mutation eventually lands", async () => {
    const storage = new InstrumentedStorage();
    await provision(storage);
    const db = Db.create({ storage, app: APP, tenant: TENANT });
    const t = db.collection(COLL) as Collection<TicketDoc>;

    // First commit (`I` op) has no CAS pressure injected so the
    // seed doc is set up cleanly. Then arm two failures so the
    // next `commit()` (the update) must retry twice and succeed
    // on attempt 3 — well under the 8-attempt budget. The verb
    // itself does NOT loop; Writer does internally.
    await t.insert({ _id: "x", title: "v0", status: "open" });
    const insertAttempts = storage.casAttempts;
    storage.failNextNCas = 2;
    const result = await t.update("x", { title: "v1" });
    expect(result).toEqual({ modified: 1 });
    expect(storage.casAttempts).toBe(insertAttempts + 3); // 2 fails + 1 win
    const after = await t.get("x");
    expect(after).toEqual({ _id: "x", title: "v1", status: "open" });
  });

  test("budget-exhausted CAS contention: verb surfaces Conflict without double-looping", async () => {
    const storage = new InstrumentedStorage();
    await provision(storage);
    const db = Db.create({ storage, app: APP, tenant: TENANT });
    const t = db.collection(COLL) as Collection<TicketDoc>;
    // Seed cleanly (no CAS pressure on the I).
    await t.insert({ _id: "loser", title: "v0", status: "open" });
    const baseAttempts = storage.casAttempts;
    // Every subsequent CAS fails — the writer's 8-attempt budget will
    // be exhausted on the update and the verb must surface Conflict.
    // CRITICAL: the verb must NOT loop again; total CAS attempts on
    // the update equals exactly the writer's budget (8).
    storage.failEveryCas = true;
    let thrown: unknown;
    try {
      await t.update("loser", { title: "v1" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(BaerlyError);
    expect((thrown as BaerlyError).code).toBe("Conflict");
    // The writer's default retry budget is 8 attempts; the verb
    // itself does NOT add another layer.
    expect(storage.casAttempts - baseAttempts).toBe(8);
  });
});
