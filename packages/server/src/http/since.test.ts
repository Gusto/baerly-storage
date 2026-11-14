/* eslint-disable no-underscore-dangle -- `_id` is the locked primary-key
   field on inserted docs. */

/**
 * Long-poll handler tests — `longPollSince` + `listEventsSince`.
 * Eight cases:
 *
 *   1. cursor validation (invalid shape → SchemaError).
 *   2. empty cursor + no current.json → empty events, fast.
 *   3. fast path: events already present → resolves immediately.
 *   4. blocks then unblocks mid-poll → resolves with new entry.
 *   5. idle timeout → empty events + same cursor.
 *   6. AbortSignal aborts promptly → empty events.
 *   7. pre-snapshot cursor → SchemaError.
 *   8. under a request ledger (Workers Free): idle polls end in an empty
 *      200, busy polls deliver a resumable prefix, an exhausted start
 *      refuses with a retriable MaintenancePending.
 *
 * Every test uses `pollIntervalMs: 25-50` and `timeoutMs: 100-2000`
 * so the suite stays well inside the 30 s default budget.
 */

import {
  BaerlyError,
  CF_FREE_EXTERNAL_REQUEST_LIMIT,
  CF_FREE_INTERNAL_REQUEST_LIMIT,
  type CurrentJson,
  createCurrentJson,
  formatCursor,
  MAINTENANCE_PENDING_RETRY_AFTER_SECONDS,
  MemoryStorage,
  RequestLedger,
  type RequestPool,
} from "@baerly/protocol";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ledgeredStorage } from "../../../../tests/fixtures/ledgered-storage.ts";
import { LOG_STATE_GENERATION, logStateCurrentJson } from "../../../../tests/fixtures/log-state.ts";
import { CallTally, totalCalls } from "../../../../tests/fixtures/request-counting-storage.ts";
import type { SinceResponse } from "../contract.ts";
import { Db } from "../db.ts";
import { createObservabilityContext, runWithContext } from "../observability/context.ts";
import { listEventsSince, longPollSince } from "./since.ts";

const APP = "test";
const TENANT = "t";
const TABLE = "tickets";

const currentJsonKey = (table = TABLE): string =>
  `app/${APP}/tenant/${TENANT}/manifests/${table}/current.json`;

const seedCurrent = (): CurrentJson => logStateCurrentJson();

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
        collection: TABLE,
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
      collection: TABLE,
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
    await db.collection(TABLE).insert({ title: "a" });
    await db.collection(TABLE).insert({ title: "b" });

    // Fast-path is checked synchronously before any setTimeout
    // scheduling. No `advanceTimersByTime` needed; if the test ever
    // depends on a tick, the unawaited timer would leak and surface
    // in the afterEach `useRealTimers` cleanup.
    const result = await longPollSince({
      db,
      collection: TABLE,
      cursor: "",
      timeoutMs: 5_000,
      pollIntervalMs: 50,
    });

    expect(result.events).toHaveLength(2);
    expect(result.next_cursor).toBe(
      formatCursor(LOG_STATE_GENERATION, result.events[result.events.length - 1]!.lsn),
    );
  });

  test("blocks then unblocks: insert lands on the next poll tick", async () => {
    const { db, storage } = makeDb();
    await provision(storage);

    const pollPromise = longPollSince({
      db,
      collection: TABLE,
      cursor: "",
      timeoutMs: 2_000,
      pollIntervalMs: 50,
    });

    // Advance past two empty ticks so the production loop has clearly
    // entered its waiting state.
    await vi.advanceTimersByTimeAsync(100);
    // Inject the event. The insert is real I/O against MemoryStorage
    // (no fake-timed delays inside it).
    await db.collection(TABLE).insert({ title: "inserted-mid-poll" });
    // Let the next tick observe the new event.
    await vi.advanceTimersByTimeAsync(100);

    const result = await pollPromise;
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.op).toBe("I");
    expect(result.next_cursor).toBe(formatCursor(LOG_STATE_GENERATION, result.events[0]!.lsn));
  });

  test("idle timeout: returns empty events + same cursor at deadline", async () => {
    const { db, storage } = makeDb();
    await provision(storage);
    await db.collection(TABLE).insert({ title: "seed" });

    // First poll: fast path catches the seed entry.
    const first = await longPollSince({
      db,
      collection: TABLE,
      cursor: "",
      timeoutMs: 500,
      pollIntervalMs: 25,
    });
    expect(first.events).toHaveLength(1);
    const cursor = first.next_cursor;

    const secondPromise = longPollSince({
      db,
      collection: TABLE,
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
      collection: TABLE,
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
    const { _id } = await db.collection(TABLE).insert({ title: "to-be-folded" });
    expect(_id).toBeDefined();

    // Capture the lsn of the seed entry via a fast-path poll.
    const seed = await longPollSince({
      db,
      collection: TABLE,
      cursor: "",
      timeoutMs: 500,
      pollIntervalMs: 25,
    });
    expect(seed.events).toHaveLength(1);
    // The full composite cursor, NOT the bare `lsn`. A bare lsn decodes
    // to the `NO_GENERATION` sentinel and would trip the generation
    // check instead — leaving this test green while no longer
    // exercising the folded-cursor path it exists to cover.
    const cursor = seed.next_cursor;

    // Bump current.json.log_seq_start past the seed entry (which lands
    // at seq 0) to mark it as "folded" (the test takes the shortcut; the
    // production compactor goes through casUpdateCurrentJson). The
    // physical `log/<seq>.json` file is left in place — the handler
    // decides "folded" by comparing the cursor's seq against
    // `log_seq_start`, not by probing for the file. Under single-write
    // commit the writer no longer advances `tail_hint`, so we set
    // `log_seq_start: 1` explicitly (the seed wrote exactly seq 0).
    const cjKey = currentJsonKey(TABLE);
    const cj = await storage.get(cjKey);
    expect(cj).not.toBeNull();
    const parsed = JSON.parse(new TextDecoder().decode(cj!.body)) as CurrentJson;
    const mutated: CurrentJson = {
      ...parsed,
      // tail_hint must stay >= log_seq_start (manifest invariant). The
      // seed wrote seq 0; mark it folded by lifting both to 1.
      tail_hint: 1,
      log_seq_start: 1,
    };
    await storage.put(cjKey, new TextEncoder().encode(JSON.stringify(mutated)));

    await expect(listEventsSince({ db, collection: TABLE, cursor })).rejects.toMatchObject({
      name: "BaerlyError",
      code: "SchemaError",
      // Pin WHICH rejection fired: `/v1/since` has two SchemaError
      // paths and a bare `code` assertion cannot tell them apart.
      message: expect.stringContaining("folded into a snapshot"),
    });
  });
});

describe("listEventsSince — truncated generation → SchemaError", () => {
  /**
   * Seed one entry, take a real cursor for it, then rewrite
   * `current.json` the way `baerly admin restore --force` does:
   * `snapshot: null`, a new `generation`, and `log_seq_start` /
   * `tail_hint` reseeded to one past the highest SURVIVING log object.
   *
   * `--force` takes the reseed from LISTed log keys, so a
   * budget-bounded GC sweep that cleared the top of the old range
   * leaves the floor BELOW where it was. That is the deliberate floor
   * exemption (invariant 12) and the reason a bare seq comparison
   * cannot detect this.
   */
  const truncateTo = async (
    storage: MemoryStorage,
    args: { floor: number; generation: string | undefined },
  ): Promise<void> => {
    const cjKey = currentJsonKey(TABLE);
    const cj = await storage.get(cjKey);
    expect(cj).not.toBeNull();
    const parsed = JSON.parse(new TextDecoder().decode(cj!.body)) as CurrentJson;
    const reseeded: CurrentJson = {
      ...parsed,
      snapshot: null,
      tail_hint: args.floor,
      log_seq_start: args.floor,
      ...(args.generation === undefined
        ? { generation: undefined }
        : { generation: args.generation }),
    };
    await storage.put(cjKey, new TextEncoder().encode(JSON.stringify(reseeded)));
  };

  /**
   * Commit one entry (it lands at the probed tail, i.e. the current
   * floor) and return the composite cursor a client would hold for it.
   */
  const seedCursor = async (db: Db): Promise<string> => {
    const { _id } = await db.collection(TABLE).insert({ title: "pre-restore" });
    expect(_id).toBeDefined();
    const seed = await longPollSince({
      db,
      collection: TABLE,
      cursor: "",
      timeoutMs: 500,
      pollIntervalMs: 25,
    });
    expect(seed.events).toHaveLength(1);
    return seed.next_cursor;
  };

  test("the issue #73 scenario: reseed BELOW the old floor is rejected", async () => {
    const { db, storage } = makeDb();
    // Old floor 12, so the cursor's entry sits at seq 12 — above the
    // floor the truncate is about to install.
    await createCurrentJson(
      storage,
      currentJsonKey(TABLE),
      logStateCurrentJson({ tail_hint: 12, log_seq_start: 12 }),
    );
    const cursor = await seedCursor(db);

    // GC left `log/8` and `log/9` behind (lex order `0,1,10,11,2,…`),
    // so `--force` reseeds to 10 — BELOW the old floor of 12.
    await truncateTo(storage, { floor: 10, generation: "ffffffffffff" });

    // Before this change the cursor's seq (12) cleared `12 < 10 === false`
    // and the stream resumed at 13, silently skipping the restored rows
    // in [10, 13). Now it is rejected outright.
    await expect(listEventsSince({ db, collection: TABLE, cursor })).rejects.toMatchObject({
      name: "BaerlyError",
      code: "SchemaError",
      message: expect.stringContaining("generation that no longer exists"),
    });
  });

  test("reseed landing exactly ON the old floor is still rejected", async () => {
    const { db, storage } = makeDb();
    await createCurrentJson(
      storage,
      currentJsonKey(TABLE),
      logStateCurrentJson({ tail_hint: 12, log_seq_start: 12 }),
    );
    const cursor = await seedCursor(db);

    // The case a floor-regression check would miss: the floor does not
    // move, so nothing about the seq arithmetic looks wrong. Only the
    // generation distinguishes the old collection from the new one.
    await truncateTo(storage, { floor: 12, generation: "ffffffffffff" });

    await expect(listEventsSince({ db, collection: TABLE, cursor })).rejects.toMatchObject({
      name: "BaerlyError",
      code: "SchemaError",
      message: expect.stringContaining("generation that no longer exists"),
    });
  });

  test("a manifest with no generation accepts a bare-lsn cursor", async () => {
    const { db, storage } = makeDb();
    // Both sides read as `NO_GENERATION`: a manifest written before the
    // field existed, resumed with a cursor minted before the composite
    // shape existed. Nothing was truncated, so this must NOT reject.
    await createCurrentJson(
      storage,
      currentJsonKey(TABLE),
      logStateCurrentJson({ generation: undefined }),
    );
    const { _id } = await db.collection(TABLE).insert({ title: "legacy" });
    expect(_id).toBeDefined();

    const seed = await longPollSince({
      db,
      collection: TABLE,
      cursor: "",
      timeoutMs: 500,
      pollIntervalMs: 25,
    });
    expect(seed.events).toHaveLength(1);
    expect(seed.next_cursor).toBe(formatCursor(undefined, seed.events[0]!.lsn));

    // A pre-upgrade client echoing the bare lsn keeps working.
    await expect(
      listEventsSince({ db, collection: TABLE, cursor: seed.events[0]!.lsn }),
    ).resolves.toEqual([]);
  });

  test("a cursor round-trips against an unchanged generation", async () => {
    const { db, storage } = makeDb();
    await provision(storage);
    const cursor = await seedCursor(db);

    await expect(listEventsSince({ db, collection: TABLE, cursor })).resolves.toEqual([]);
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
      await db.collection(TABLE).insert({ title: `row-${i}` });
    }

    // First poll: fast path picks up all 12 entries.
    const first = await longPollSince({
      db,
      collection: TABLE,
      cursor: "",
      timeoutMs: 500,
      pollIntervalMs: 25,
    });
    expect(first.events).toHaveLength(12);
    const cursor = first.next_cursor;
    expect(cursor).toBe(formatCursor(LOG_STATE_GENERATION, first.events[11]!.lsn));

    // Second poll: nothing new committed, so the handler must hit
    // its deadline with an empty batch and the SAME cursor. Today's
    // broken handler fast-paths a non-empty batch and the assertion
    // below trips.
    const secondPromise = longPollSince({
      db,
      collection: TABLE,
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

/**
 * `longPollSince` under a per-invocation request ledger, as on Workers
 * Free with storage reached through `fetch` (S3 over HTTP): 45 external
 * calls for the whole request. Each test runs the poll inside a context
 * carrying the ledger, and advances the fake clock from inside it too,
 * so the poll's timer callbacks charge the same ledger.
 */
describe("longPollSince — under a request ledger", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The Workers Free limits: 900 internal, 45 external. */
  const freeLedger = (): RequestLedger =>
    new RequestLedger({
      internal: CF_FREE_INTERNAL_REQUEST_LIMIT,
      external: CF_FREE_EXTERNAL_REQUEST_LIMIT,
    });

  /** A provisioned collection with `rows` unfolded log entries, written with no ledger. */
  const seeded = async (rows: number, tailHint = 0): Promise<MemoryStorage> => {
    const { db, storage } = makeDb();
    await provision(storage);
    await runWithContext(
      createObservabilityContext({ maintenance: { disabled: true } }),
      async () => {
        for (let i = 0; i < rows; i++) {
          await db.collection(TABLE).insert({ title: `row-${i}` });
        }
      },
    );
    if (tailHint > 0) {
      // A hint lagging the true tail, as between maintenance refreshes.
      const cj = await storage.get(currentJsonKey());
      const parsed = JSON.parse(new TextDecoder().decode(cj!.body)) as CurrentJson;
      await storage.put(
        currentJsonKey(),
        new TextEncoder().encode(JSON.stringify({ ...parsed, tail_hint: tailHint })),
      );
    }
    return storage;
  };

  /** The cursor a client holds after reading the entry at `seq`. */
  const cursorAt = async (storage: MemoryStorage, seq: number): Promise<string> => {
    const { db } = makeDb(storage);
    const all = await listEventsSince({ db, collection: TABLE, cursor: "" });
    return formatCursor(LOG_STATE_GENERATION, all[seq]!.lsn);
  };

  const seqs = (polled: Polled): number[] => polled.result!.events.map((e) => e.seq);

  interface Polled {
    readonly result: SinceResponse | undefined;
    readonly error: unknown;
    /** Fake-clock milliseconds from the call to its settlement. */
    readonly elapsedMs: number;
    readonly ledger: RequestLedger;
    /** Calls that reached storage. */
    readonly issued: number;
  }

  /**
   * One `/v1/since` request: a fresh ledger, storage behind it charged to
   * `pool`, the clock advanced in `stepMs` steps until the poll settles.
   */
  const poll = async (
    storage: MemoryStorage,
    cursor: string,
    opts: {
      ledger?: RequestLedger;
      pool?: RequestPool;
      timeoutMs?: number;
      pollIntervalMs?: number;
      stepMs?: number;
    } = {},
  ): Promise<Polled> => {
    const ledger = opts.ledger ?? freeLedger();
    const issued = new CallTally();
    const db = Db.create({
      storage: ledgeredStorage(storage, opts.pool ?? "external", issued),
      app: APP,
      tenant: TENANT,
    });
    const stepMs = opts.stepMs ?? 50;
    return runWithContext(createObservabilityContext({ ledger }), async () => {
      const start = Date.now();
      const outcome: { settled?: { result?: SinceResponse; error?: unknown; at: number } } = {};
      void longPollSince({
        db,
        collection: TABLE,
        cursor,
        ...(opts.timeoutMs !== undefined && { timeoutMs: opts.timeoutMs }),
        ...(opts.pollIntervalMs !== undefined && { pollIntervalMs: opts.pollIntervalMs }),
      }).then(
        (result) => {
          outcome.settled = { result, at: Date.now() };
        },
        (error: unknown) => {
          outcome.settled = { error, at: Date.now() };
        },
      );
      // Settle the fast path, then step the clock until the poll ends.
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; outcome.settled === undefined && i < 10_000; i++) {
        await vi.advanceTimersByTimeAsync(stepMs);
      }
      const settled = outcome.settled;
      expect(settled).toBeDefined();
      return {
        result: settled!.result,
        error: settled!.error,
        elapsedMs: settled!.at - start,
        ledger,
        issued: totalCalls(issued.read()),
      };
    });
  };

  /** The cursor of the newest entry: a caught-up client's steady state. */
  const caughtUp = async (storage: MemoryStorage, pool?: RequestPool): Promise<string> => {
    const polled = await poll(storage, "", pool === undefined ? {} : { pool });
    return polled.result!.next_cursor;
  };

  test("an idle poll at the default timeout and interval ends in an empty 200, not a refusal", async () => {
    const storage = await seeded(1);
    // The client's steady state: it holds the cursor of the newest entry.
    const first = await poll(storage, "");
    expect(first.result?.events).toHaveLength(1);
    const cursor = first.result!.next_cursor;

    // 25 s at 1 s needs ~26 idle cycles; 45 external calls cover ~22.
    const idle = await poll(storage, cursor, { stepMs: 100 });
    expect(idle.error).toBeUndefined();
    expect(idle.result).toEqual({ events: [], next_cursor: cursor });
    // It held for most of the budget, not one cycle.
    expect(idle.elapsedMs).toBeGreaterThanOrEqual(20_000);
    // 22 cycles of two: the ledger, not the 25 s timeout, ends it.
    expect(idle.issued).toBe(CF_FREE_EXTERNAL_REQUEST_LIMIT - 1);
    expect(idle.ledger.charged.external).toBe(idle.issued);

    // And it keeps syncing: the next request delivers a new write.
    const { db } = makeDb(storage);
    await runWithContext(
      createObservabilityContext({ maintenance: { disabled: true } }),
      async () => {
        await db.collection(TABLE).insert({ title: "after-idle" });
      },
    );
    const next = await poll(storage, cursor);
    expect(next.result?.events.map((e) => (e.after as { title: string }).title)).toEqual([
      "after-idle",
    ]);
  });

  test("an idle poll on the R2 binding's internal pool also ends in an empty 200", async () => {
    const storage = await seeded(1);
    const cursor = await caughtUp(storage, "internal");
    // 900 internal calls outlast the 25 s default at 1 s: the timeout ends it.
    const idle = await poll(storage, cursor, { pool: "internal", stepMs: 500 });
    expect(idle.result).toEqual({ events: [], next_cursor: cursor });
    expect(idle.elapsedMs).toBeGreaterThanOrEqual(25_000);
    // 26 cycles of two (t = 0, 1, …, 25 s), far inside the 900.
    expect(idle.issued).toBe(52);
    expect(idle.ledger.charged.internal).toBe(idle.issued);
    expect(idle.ledger.charged.external).toBe(0);
  });

  test("a busy poll delivers a prefix within the budget and the next request resumes exactly", async () => {
    const rows = 100;
    const storage = await seeded(rows);
    const seen: string[] = [];
    let cursor = "";
    let requests = 0;
    while (seen.length < rows) {
      const polled = await poll(storage, cursor);
      expect(polled.error).toBeUndefined();
      expect(polled.result!.events.length).toBeGreaterThan(0);
      // A prefix comes back on the fast path, without waiting.
      expect(polled.elapsedMs).toBe(0);
      expect(polled.ledger.charged.external).toBeLessThanOrEqual(CF_FREE_EXTERNAL_REQUEST_LIMIT);
      expect(polled.ledger.charged.external).toBe(polled.issued);
      seen.push(...polled.result!.events.map((e) => (e.after as { title: string }).title));
      cursor = polled.result!.next_cursor;
      requests += 1;
    }
    // In order, each exactly once.
    expect(seen).toEqual(Array.from({ length: rows }, (_, i) => `row-${i}`));
    expect(requests).toBe(3);
    // Caught up: the next request idles.
    const idle = await poll(storage, cursor, { timeoutMs: 3_000 });
    expect(idle.result).toEqual({ events: [], next_cursor: cursor });
  });

  test("a ledger exhausted at the start refuses with MaintenancePending and a Retry-After", async () => {
    const storage = await seeded(1);
    const ledger = freeLedger();
    for (let i = 0; i < CF_FREE_EXTERNAL_REQUEST_LIMIT - 1; i++) {
      ledger.acquire("external");
    }
    const polled = await poll(storage, "", { ledger });
    expect(polled.error).toMatchObject({
      name: "BaerlyError",
      code: "MaintenancePending",
      retriable: true,
      retryAfter: MAINTENANCE_PENDING_RETRY_AFTER_SECONDS,
    });
    // Refused before any storage call.
    expect(polled.issued).toBe(0);
    expect(polled.elapsedMs).toBe(0);
  });

  test.each([2, 3, 5])(
    "with room for %i calls, an empty batch never returns before one poll interval",
    async (room) => {
      const storage = await seeded(1);
      const cursor = await caughtUp(storage);
      const ledger = new RequestLedger({
        internal: CF_FREE_INTERNAL_REQUEST_LIMIT,
        external: room,
      });
      const polled = await poll(storage, cursor, { ledger, stepMs: 10 });
      expect(polled.result).toEqual({ events: [], next_cursor: cursor });
      expect(polled.elapsedMs).toBeGreaterThanOrEqual(1_000);
      expect(polled.ledger.charged.external).toBe(polled.issued);
      expect(polled.issued).toBeLessThanOrEqual(room);
    },
  );

  test("a refusal inside a cycle ends the poll with what it has, never an error", async () => {
    const storage = await seeded(1);
    const cursor = await caughtUp(storage);
    // Every log GET fails, so the adapter retries the probe until the
    // ledger refuses an attempt: room 3 is current.json plus two probe
    // attempts, and the third is refused mid-cycle.
    const failing: MemoryStorage = Object.assign(Object.create(storage) as MemoryStorage, {
      get: (key: string, opts?: Parameters<MemoryStorage["get"]>[1]) =>
        key.includes("/log/")
          ? Promise.reject(new BaerlyError("NetworkError", "injected"))
          : storage.get(key, opts),
    });
    const ledger = new RequestLedger({ internal: CF_FREE_INTERNAL_REQUEST_LIMIT, external: 3 });
    const polled = await poll(failing, cursor, { ledger, stepMs: 10 });
    expect(polled.error).toBeUndefined();
    expect(polled.result).toEqual({ events: [], next_cursor: cursor });
    expect(polled.elapsedMs).toBeGreaterThanOrEqual(1_000);
    expect(polled.issued).toBe(3);
    expect(polled.ledger.charged.external).toBe(3);
  });

  test("a refusal on the probe's last slot still delivers the entries read before it", async () => {
    // One throttled GET on the first probe slot spends a retry, so the
    // probe's last planned slot is refused by the ledger.
    const inner = await seeded(60);
    let failed = false;
    const throttled: MemoryStorage = Object.assign(Object.create(inner) as MemoryStorage, {
      get: (key: string, opts?: Parameters<MemoryStorage["get"]>[1]) => {
        if (!failed && key.endsWith("/log/0.json")) {
          failed = true;
          return Promise.reject(new BaerlyError("NetworkError", "injected"));
        }
        return inner.get(key, opts);
      },
    });
    const first = await poll(throttled, "");
    expect(first.error).toBeUndefined();
    expect(failed).toBe(true);
    // current.json, two attempts at slot 0, slots 1..42: 45 calls.
    expect(first.issued).toBe(CF_FREE_EXTERNAL_REQUEST_LIMIT);
    expect(seqs(first)).toEqual(Array.from({ length: 43 }, (_, i) => i));
    // The next request resumes exactly at the refused slot.
    const next = await poll(inner, first.result!.next_cursor);
    expect(seqs(next)[0]).toBe(43);
  });

  test.each([
    ["behind", 4, Array.from({ length: 25 }, (_, i) => 5 + i), 1 + 5 + 20 + 1],
    ["ahead of", 20, Array.from({ length: 9 }, (_, i) => 21 + i), 1 + 9 + 1],
  ])(
    "a cursor %s a lagging tail_hint gets every later entry, each read once",
    async (_label, cursorSeq, expected, calls) => {
      const storage = await seeded(30, 10);
      const polled = await poll(storage, await cursorAt(storage, cursorSeq));
      expect(seqs(polled)).toEqual(expected);
      // Entries below the hint by seq, then the probe from the later of
      // the hint and the cursor, then the empty slot that ends it.
      expect(polled.issued).toBe(calls);
      expect(polled.ledger.charged.external).toBe(calls);
    },
  );

  test("an idle poll ahead of a lagging tail_hint costs two calls per cycle", async () => {
    const storage = await seeded(30, 10);
    const cursor = await cursorAt(storage, 29);
    const idle = await poll(storage, cursor, { stepMs: 100 });
    expect(idle.result).toEqual({ events: [], next_cursor: cursor });
    // 22 cycles of two, as with the hint at the tail.
    expect(idle.issued).toBe(CF_FREE_EXTERNAL_REQUEST_LIMIT - 1);
  });

  test("a busy poll behind a lagging tail_hint resumes exactly across requests", async () => {
    const rows = 100;
    const storage = await seeded(rows, 37);
    const seen: number[] = [];
    let cursor = "";
    while (seen.length < rows) {
      const polled = await poll(storage, cursor);
      expect(polled.issued).toBeLessThanOrEqual(CF_FREE_EXTERNAL_REQUEST_LIMIT);
      seen.push(...seqs(polled));
      cursor = polled.result!.next_cursor;
    }
    expect(seen).toEqual(Array.from({ length: rows }, (_, i) => i));
  });
});
