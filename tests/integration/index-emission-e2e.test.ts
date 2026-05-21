/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on document shapes (see `@baerly/protocol/src/table-api.ts`'s `Table<T>`
   declaration); tests reference it by name. */

/**
 * Regression — production `Db.create({ indexes })` → write path must
 * emit secondary-index PUTs.
 *
 * The writer-side index-emission block in `Writer` is correct in
 * isolation, but for a while the production `Db → Writer` wiring
 * dropped `indexes` on the floor: declaring an index gave a *write*
 * path that never populated the index, while the *read* path queried
 * an index that was never written. Reads silently missed rows.
 *
 * This file exercises ALL FOUR production write entry points reachable
 * from `Db`:
 *
 *   1. `db.table(coll).insert({...})`
 *   2. `db.table(coll).update(id, {...})`
 *   3. `db.table(coll).delete(id)`
 *   4. `db.transaction(coll, async (tx) => { ... })`
 *
 * After each verb, list keys under `<tablePrefix>/index/<indexName>/`
 * and assert set-equality against the oracle `allIndexKeysFor(...)`
 * applied to the live row set. The test runs on `MemoryStorage`, no
 * infra gating.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  createCurrentJson,
  type DocumentData,
  type IndexDefinition,
  MemoryStorage,
} from "@baerly/protocol";
import { beforeEach, describe, expect, test } from "vitest";
import { allIndexKeysFor, Db } from "@baerly/server";

const APP = "test";
const TENANT = "t";
const COLL = "tickets";

const TABLE_PREFIX = `app/${APP}/tenant/${TENANT}/manifests/${COLL}`;
const BY_STATUS: IndexDefinition = { name: "by_status", on: "status" };
const INDEXES: ReadonlyArray<IndexDefinition> = [BY_STATUS];

interface Ticket extends DocumentData {
  _id: string;
  status: string;
}

/**
 * List every key on storage under every declared index's prefix.
 */
const listIndexKeys = async (storage: MemoryStorage): Promise<Set<string>> => {
  const out = new Set<string>();
  for (const def of INDEXES) {
    for await (const entry of storage.list(`${TABLE_PREFIX}/index/${def.name}/`)) {
      out.add(entry.key);
    }
  }
  return out;
};

/**
 * Oracle: the union of `allIndexKeysFor(...)` across every live row.
 */
const expectedIndexKeys = (live: ReadonlyMap<string, Ticket>): Set<string> => {
  const out = new Set<string>();
  for (const row of live.values()) {
    for (const k of allIndexKeysFor(TABLE_PREFIX, INDEXES, row, row._id)) {
      out.add(k);
    }
  }
  return out;
};

const assertIndexParity = async (
  storage: MemoryStorage,
  live: ReadonlyMap<string, Ticket>,
): Promise<void> => {
  const actual = await listIndexKeys(storage);
  const expected = expectedIndexKeys(live);
  expect([...actual].toSorted()).toEqual([...expected].toSorted());
};

const makeDb = (storage: MemoryStorage): Db =>
  Db.create({
    storage,
    app: APP,
    tenant: TENANT,
    indexes: new Map([[COLL, [BY_STATUS]]]),
  });

/**
 * Bootstrap the collection's `current.json`. `Writer` requires
 * the manifest to exist before any commit; `Db.create` itself is
 * zero-I/O so we do this once per test.
 */
const provision = async (storage: MemoryStorage): Promise<void> => {
  await createCurrentJson(storage, `${TABLE_PREFIX}/current.json`, {
    schema_version: CURRENT_JSON_SCHEMA_VERSION,
    snapshot: null,
    next_seq: 0,
    log_seq_start: 0,
    writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
  });
};

describe("Db → Writer index emission (e2e)", () => {
  let storage: MemoryStorage;
  let db: Db;

  beforeEach(async () => {
    storage = new MemoryStorage();
    db = makeDb(storage);
    await provision(storage);
  });

  test("table.insert emits the projected index key", async () => {
    const t = db.table<Ticket>(COLL);
    await t.insert({ _id: "t-1", status: "open" });

    await assertIndexParity(storage, new Map([["t-1", { _id: "t-1", status: "open" }]]));
  });

  test("query.update rewrites the index key when the indexed field changes", async () => {
    const t = db.table<Ticket>(COLL);
    await t.insert({ _id: "t-1", status: "open" });

    await t.update("t-1", { status: "closed" });

    await assertIndexParity(storage, new Map([["t-1", { _id: "t-1", status: "closed" }]]));
  });

  test("query.delete tombstones the index key", async () => {
    const t = db.table<Ticket>(COLL);
    await t.insert({ _id: "t-1", status: "open" });
    await t.insert({ _id: "t-2", status: "open" });

    await t.delete("t-1");

    await assertIndexParity(storage, new Map([["t-2", { _id: "t-2", status: "open" }]]));
  });

  test("db.transaction emits index keys for every buffered mutation", async () => {
    const t = db.table<Ticket>(COLL);
    // Pre-seed two docs so the tx body's delete has a row to act on.
    await t.insert({ _id: "a", status: "open" });
    await t.insert({ _id: "b", status: "open" });

    await db.transaction<Ticket>(COLL, async (tx) => {
      await tx.insert({ _id: "c", status: "in-progress" });
      await tx.delete("a");
    });

    await assertIndexParity(
      storage,
      new Map([
        ["b", { _id: "b", status: "open" }],
        ["c", { _id: "c", status: "in-progress" }],
      ]),
    );
  });
});
