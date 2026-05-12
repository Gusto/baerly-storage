/* eslint-disable no-underscore-dangle -- `_raw` is the locked public symbol
   name on `Db` (see `../db.ts`); the pre-snapshot-cursor test reaches
   through it to surgically mutate `current.json` and delete a log entry.
   `_id` is the locked primary-key field on inserted docs. */

/**
 * Phase-6 long-poll handler tests — `longPollSince` + `listEventsSince`.
 * Seven cases from ticket 26 §4.7:
 *
 *   1. cursor validation (invalid shape → SchemaError).
 *   2. empty cursor + no current.json → empty events, fast.
 *   3. fast path: events already present → resolves immediately.
 *   4. blocks then unblocks mid-poll → resolves with new entry.
 *   5. idle timeout → empty events + same cursor.
 *   6. AbortSignal aborts promptly → empty events.
 *   7. pre-snapshot cursor → SchemaError.
 *
 * Every test uses `pollIntervalMs: 25-50` and `timeoutMs: 100-2000`
 * so the suite stays well inside the 30 s default budget.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  createCurrentJson,
  MemoryStorage,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { Db } from "../db";
import { listEventsSince, longPollSince } from "./since";

const APP = "test";
const TENANT = "t";
const TABLE = "tickets";

const currentJsonKey = (table = TABLE): string =>
  `app/${APP}/tenant/${TENANT}/manifests/${table}/current.json`;

const seedCurrent = (): CurrentJson => ({
  schema_version: CURRENT_JSON_SCHEMA_VERSION,
  snapshot: null,
  next_seq: 0,
  writer_fence: { epoch: 0, owner: "test", claimed_at: "" },
});

const makeDb = (
  storage: MemoryStorage = new MemoryStorage(),
): { db: Db; storage: MemoryStorage } => ({
  db: Db.create({ storage, app: APP, tenant: TENANT }),
  storage,
});

const provision = async (storage: MemoryStorage, table = TABLE): Promise<void> => {
  await createCurrentJson(storage, currentJsonKey(table), seedCurrent());
};

describe("longPollSince — cursor validation", () => {
  test("invalid cursor shape rejects with BaerlyError{SchemaError}", async () => {
    const { db } = makeDb();
    await expect(
      longPollSince({
        db,
        table: TABLE,
        cursor: "not-an-lsn",
        timeoutMs: 100,
        pollIntervalMs: 25,
      }),
    ).rejects.toMatchObject({
      name: "BaerlyError",
      code: "SchemaError",
    });
  });
});

describe("longPollSince — empty cursor + no current.json yet", () => {
  test("returns { events: [], next_cursor: '' } within the timeout", async () => {
    const { db } = makeDb();
    // No provision() — current.json doesn't exist.
    const start = Date.now();
    const result = await longPollSince({
      db,
      table: TABLE,
      cursor: "",
      timeoutMs: 100,
      pollIntervalMs: 25,
    });
    const elapsed = Date.now() - start;
    expect(result.events).toEqual([]);
    expect(result.next_cursor).toBe("");
    // Polls until timeout; we don't constrain a lower bound here
    // because the readCurrentJson() returns null instantly on every
    // tick, so the loop exits at the deadline.
    expect(elapsed).toBeLessThan(500);
  });
});

describe("longPollSince — fast path", () => {
  test("two pre-existing entries return immediately", async () => {
    const { db, storage } = makeDb();
    await provision(storage);
    await db.table(TABLE).insert({ title: "a" });
    await db.table(TABLE).insert({ title: "b" });

    const start = Date.now();
    const result = await longPollSince({
      db,
      table: TABLE,
      cursor: "",
      timeoutMs: 5_000,
      pollIntervalMs: 50,
    });
    const elapsed = Date.now() - start;

    expect(result.events).toHaveLength(2);
    expect(result.next_cursor).toBe(result.events[result.events.length - 1]!.lsn);
    expect(elapsed).toBeLessThan(500);
  });
});

describe("longPollSince — blocks then unblocks mid-poll", () => {
  test("scheduled insert lands inside the poll window", async () => {
    const { db, storage } = makeDb();
    await provision(storage);

    const start = Date.now();
    // Fire an insert after a short delay. The long-poll's tick
    // (every 50 ms) should pick it up.
    const insertAt = 200;
    const insertPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        void db
          .table(TABLE)
          .insert({ title: "inserted-mid-poll" })
          .then(() => resolve());
      }, insertAt);
    });

    const result = await longPollSince({
      db,
      table: TABLE,
      cursor: "",
      timeoutMs: 2_000,
      pollIntervalMs: 50,
    });
    await insertPromise;
    const elapsed = Date.now() - start;

    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.op).toBe("I");
    expect(result.next_cursor).toBe(result.events[0]!.lsn);
    // The insert fired at ~200 ms; the next tick after that lands
    // by ~250 ms with margin. Upper bound is well under the 2 s
    // timeout to prove the loop actually unblocked.
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(elapsed).toBeLessThan(1_500);
  });
});

describe("longPollSince — idle timeout", () => {
  test("returns empty events + same cursor after the budget", async () => {
    const { db, storage } = makeDb();
    await provision(storage);
    await db.table(TABLE).insert({ title: "seed" });

    // First poll catches up to the seed entry.
    const first = await longPollSince({
      db,
      table: TABLE,
      cursor: "",
      timeoutMs: 500,
      pollIntervalMs: 25,
    });
    expect(first.events).toHaveLength(1);
    const cursor = first.next_cursor;

    const start = Date.now();
    const second = await longPollSince({
      db,
      table: TABLE,
      cursor,
      timeoutMs: 300,
      pollIntervalMs: 25,
    });
    const elapsed = Date.now() - start;

    expect(second.events).toEqual([]);
    expect(second.next_cursor).toBe(cursor);
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1_000);
  });
});

describe("longPollSince — AbortSignal aborts promptly", () => {
  test("controller.abort() at t=100 ms resolves before the timeout", async () => {
    const { db, storage } = makeDb();
    await provision(storage);

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);

    const start = Date.now();
    const result = await longPollSince({
      db,
      table: TABLE,
      cursor: "",
      timeoutMs: 5_000,
      pollIntervalMs: 50,
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;

    expect(result.events).toEqual([]);
    expect(elapsed).toBeLessThan(500);
  });
});

describe("listEventsSince — pre-snapshot cursor → SchemaError", () => {
  test("cursor inside [0, log_seq_start) rejects", async () => {
    const { db, storage } = makeDb();
    await provision(storage);
    const { _id } = await db.table(TABLE).insert({ title: "to-be-folded" });
    expect(_id).toBeDefined();

    // Capture the lsn of the seed entry via a fast-path poll.
    const seed = await longPollSince({
      db,
      table: TABLE,
      cursor: "",
      timeoutMs: 500,
      pollIntervalMs: 25,
    });
    expect(seed.events).toHaveLength(1);
    const cursor = seed.events[0]!.lsn;

    // Delete the underlying log file via _raw.
    const logFileKey = `manifests/${TABLE}/log/${cursor}.json`;
    await db._raw.delete(logFileKey);

    // Bump current.json.log_seq_start to current.next_seq to mark
    // the entry as "folded" (the test takes the shortcut; the
    // production compactor goes through casUpdateCurrentJson).
    const cjKey = "manifests/" + TABLE + "/current.json";
    const cj = await db._raw.get(cjKey);
    expect(cj).not.toBeNull();
    const parsed = JSON.parse(new TextDecoder().decode(cj!.body)) as CurrentJson;
    const mutated: CurrentJson = {
      ...parsed,
      log_seq_start: parsed.next_seq,
    };
    await db._raw.put(cjKey, new TextEncoder().encode(JSON.stringify(mutated)));

    await expect(listEventsSince({ db, table: TABLE, cursor })).rejects.toMatchObject({
      name: "BaerlyError",
      code: "SchemaError",
    });
  });
});
