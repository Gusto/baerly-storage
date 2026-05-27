/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on inserted docs. */

/**
 * Long-poll handler tests — `longPollSince` + `listEventsSince`.
 * Seven cases:
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
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Db } from "../db.ts";
import { listEventsSince, longPollSince } from "./since.ts";

const APP = "test";
const TENANT = "t";
const TABLE = "tickets";

const currentJsonKey = (table = TABLE): string =>
  `app/${APP}/tenant/${TENANT}/manifests/${table}/current.json`;

const seedCurrent = (): CurrentJson => ({
  schema_version: CURRENT_JSON_SCHEMA_VERSION,
  snapshot: null,
  next_seq: 0,
  log_seq_start: 0,
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

// The next four describe blocks drive `longPollSince`'s polling loop
// under `vi.useFakeTimers()`. Every wall-clock elapsed assertion was
// load-sensitive — on a busy CI runner the actual elapsed time can
// drift past the bound even when the production code behaves
// correctly. Fake timers replace `setTimeout` / `Date.now` (the only
// timing primitives `longPollSince` reaches for); storage reads still
// go through real microtasks, so `await storage.put(...)` keeps
// working. We advance time explicitly with
// `vi.advanceTimersByTimeAsync` instead of asserting on `Date.now()`.
describe("longPollSince — fake-timer cases", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("empty cursor + no current.json: resolves with empty events at deadline", async () => {
    const { db } = makeDb();
    const promise = longPollSince({
      db,
      table: TABLE,
      cursor: "",
      timeoutMs: 100,
      pollIntervalMs: 25,
    });
    // Drive the poll loop past its deadline. `runAllTimersAsync` keeps
    // firing scheduled timers until the queue empties, so the loop
    // either resolves with new events or hits its own deadline check.
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.events).toEqual([]);
    expect(result.next_cursor).toBe("");
  });

  test("fast path: two pre-existing entries return without polling", async () => {
    const { db, storage } = makeDb();
    await provision(storage);
    await db.table(TABLE).insert({ title: "a" });
    await db.table(TABLE).insert({ title: "b" });

    // Fast-path is checked synchronously before any setTimeout
    // scheduling. No `advanceTimersByTime` needed; if the test ever
    // depends on a tick, the unawaited timer would leak and surface
    // in the afterEach `useRealTimers` cleanup.
    const result = await longPollSince({
      db,
      table: TABLE,
      cursor: "",
      timeoutMs: 5_000,
      pollIntervalMs: 50,
    });

    expect(result.events).toHaveLength(2);
    expect(result.next_cursor).toBe(result.events[result.events.length - 1]!.lsn);
  });

  test("blocks then unblocks: insert lands on the next poll tick", async () => {
    const { db, storage } = makeDb();
    await provision(storage);

    const pollPromise = longPollSince({
      db,
      table: TABLE,
      cursor: "",
      timeoutMs: 2_000,
      pollIntervalMs: 50,
    });

    // Advance past two empty ticks so the production loop has clearly
    // entered its waiting state.
    await vi.advanceTimersByTimeAsync(100);
    // Inject the event. The insert is real I/O against MemoryStorage
    // (no fake-timed delays inside it).
    await db.table(TABLE).insert({ title: "inserted-mid-poll" });
    // Let the next tick observe the new event.
    await vi.advanceTimersByTimeAsync(100);

    const result = await pollPromise;
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.op).toBe("I");
    expect(result.next_cursor).toBe(result.events[0]!.lsn);
  });

  test("idle timeout: returns empty events + same cursor at deadline", async () => {
    const { db, storage } = makeDb();
    await provision(storage);
    await db.table(TABLE).insert({ title: "seed" });

    // First poll: fast path catches the seed entry.
    const first = await longPollSince({
      db,
      table: TABLE,
      cursor: "",
      timeoutMs: 500,
      pollIntervalMs: 25,
    });
    expect(first.events).toHaveLength(1);
    const cursor = first.next_cursor;

    const secondPromise = longPollSince({
      db,
      table: TABLE,
      cursor,
      timeoutMs: 300,
      pollIntervalMs: 25,
    });
    // Drive the loop to (and past) its deadline. No new entries → it
    // resolves with `events: [], next_cursor: cursor`.
    await vi.runAllTimersAsync();
    const second = await secondPromise;

    expect(second.events).toEqual([]);
    expect(second.next_cursor).toBe(cursor);
  });

  test("AbortSignal: controller.abort() resolves the poll with empty events", async () => {
    const { db, storage } = makeDb();
    await provision(storage);

    const controller = new AbortController();
    const pollPromise = longPollSince({
      db,
      table: TABLE,
      cursor: "",
      timeoutMs: 5_000,
      pollIntervalMs: 50,
      signal: controller.signal,
    });

    // Drive a couple of empty ticks so the loop is parked on a
    // setTimeout, then abort.
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    // Flush microtasks so the abort listener resolves the promise.
    await vi.advanceTimersByTimeAsync(0);

    const result = await pollPromise;
    expect(result.events).toEqual([]);
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

    // Bump current.json.log_seq_start to current.next_seq to mark
    // the entry as "folded" (the test takes the shortcut; the
    // production compactor goes through casUpdateCurrentJson). The
    // physical `log/<seq>.json` file is left in place — the handler
    // decides "folded" by comparing the cursor's seq against
    // `log_seq_start`, not by probing for the file.
    const cjKey = currentJsonKey(TABLE);
    const cj = await storage.get(cjKey);
    expect(cj).not.toBeNull();
    const parsed = JSON.parse(new TextDecoder().decode(cj!.body)) as CurrentJson;
    const mutated: CurrentJson = {
      ...parsed,
      log_seq_start: parsed.next_seq,
    };
    await storage.put(cjKey, new TextEncoder().encode(JSON.stringify(mutated)));

    await expect(listEventsSince({ db, table: TABLE, cursor })).rejects.toMatchObject({
      name: "BaerlyError",
      code: "SchemaError",
    });
  });
});

describe("longPollSince — cursor advances past the digit boundary", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Regression: log files are named `log/<seq>.json`. With 12 entries
  // (`0.json` … `11.json`) the lex order is `0, 1, 10, 11, 2, …, 9`
  // — list-with-startAfter on integer filenames silently drops half
  // the tail, and lsn-shaped cursor keys leak some-but-not-all real
  // keys back into every poll. Either bug puts the long-poll's fast
  // path into a tight loop on the second poll; both are caught by
  // asserting that a second poll with the first poll's cursor lands
  // on the idle-timeout path.
  test("12 entries: second poll with returned cursor idles to deadline", async () => {
    const { db, storage } = makeDb();
    await provision(storage);
    for (let i = 0; i < 12; i++) {
      await db.table(TABLE).insert({ title: `row-${i}` });
    }

    // First poll: fast path picks up all 12 entries.
    const first = await longPollSince({
      db,
      table: TABLE,
      cursor: "",
      timeoutMs: 500,
      pollIntervalMs: 25,
    });
    expect(first.events).toHaveLength(12);
    const cursor = first.next_cursor;
    expect(cursor).toBe(first.events[11]!.lsn);

    // Second poll: nothing new committed, so the handler must hit
    // its deadline with an empty batch and the SAME cursor. Today's
    // broken handler fast-paths a non-empty batch and the assertion
    // below trips.
    const secondPromise = longPollSince({
      db,
      table: TABLE,
      cursor,
      timeoutMs: 300,
      pollIntervalMs: 25,
    });
    await vi.runAllTimersAsync();
    const second = await secondPromise;

    expect(second.events).toEqual([]);
    expect(second.next_cursor).toBe(cursor);
  });
});
