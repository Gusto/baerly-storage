/**
 * The committing create under the per-invocation request ledger: the
 * commit-resolution reserve (`COMMIT_RESOLUTION_RESERVE`) checked before
 * the index markers and again after a lost create race, a create the
 * ledger refuses before sending (definitively not applied), an uncertain
 * create whose readback the ledger refuses (`AmbiguousCommit`), refused
 * post-commit steps, and a multi-row update stopped part-way.
 */

import {
  BaerlyError,
  CF_FREE_EXTERNAL_REQUEST_LIMIT,
  CF_FREE_INTERNAL_REQUEST_LIMIT,
  COMMIT_RESOLUTION_RESERVE,
  createCurrentJson,
  encodeJsonBytes,
  type LogEntry,
  MemoryStorage,
  RequestLedger,
  type RequestPool,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StoragePutOptions,
  type StoragePutResult,
  STORAGE_RETRY_MAX_ATTEMPTS,
} from "@baerly/protocol";
import { describe, expect, test, vi } from "vitest";
import { ledgeredStorage } from "../../../tests/fixtures/ledgered-storage.ts";
import { logStateCurrentJson } from "../../../tests/fixtures/log-state.ts";
import { compact, type InternalCompactOptions } from "./compactor.ts";
import { Db } from "./db.ts";
import type { IndexDefinition } from "./indexes.ts";
import type { InternalBoundedMaintenanceOptions } from "./maintenance-options.ts";
import {
  createObservabilityContext,
  getCurrentContext,
  type ObservabilityContext,
  runWithContext,
} from "./observability/context.ts";
import { Writer } from "./writer.ts";

const CURRENT_KEY = "app/test/tenant/t/manifests/tickets/current.json";
const LOG_PREFIX = "app/test/tenant/t/manifests/tickets/log/";
const LOG_0 = `${LOG_PREFIX}0.json`;

const isLogCreate = (key: string, opts?: StoragePutOptions): boolean =>
  key.startsWith(LOG_PREFIX) && opts?.ifNoneMatch === "*";

/**
 * Spend the requests left on `pool` down to `keep`, as concurrent work in
 * the same invocation would.
 */
const drain = (ledger: RequestLedger, pool: RequestPool, keep = 0): void => {
  while (ledger.remaining(pool) > keep) {
    ledger.acquire(pool);
  }
};

/**
 * Spend every request the ledger has left, held ones included, as a call
 * outside every hold would (a required cache invalidation, or a platform
 * cap lower than the ledger's limit).
 */
const exhaust = (ledger: RequestLedger, pool: RequestPool): void => {
  while (ledger.remaining(pool) + ledger.held > 0) {
    ledger.chargeCacheCall(true);
  }
};

const sumCounter = (ctx: ObservabilityContext, name: string, phase?: string): number =>
  ctx.recorder
    .snapshot()
    .counters.filter(
      (c) => c.name === name && (phase === undefined || c.labels?.["phase"] === phase),
    )
    .reduce((acc, c) => acc + c.value, 0);

const POOLS: readonly RequestPool[] = ["internal", "external"];

const limitsFor = (pool: RequestPool, limit: number) =>
  pool === "internal"
    ? { internal: limit, external: Infinity }
    : { internal: limit, external: limit };

const BY_STATUS = { name: "by_status", on: "status" } satisfies IndexDefinition;
const BY_OWNER = { name: "by_owner", on: "owner" } satisfies IndexDefinition;

const commitInsert = async (
  storage: Storage,
  ledger: RequestLedger,
  opts: { indexes?: IndexDefinition[]; ctx?: ObservabilityContext; force?: boolean } = {},
): Promise<unknown> => {
  const writer = new Writer({
    storage,
    currentJsonKey: CURRENT_KEY,
    options: { indexes: opts.indexes ?? [] },
  });
  return await runWithContext(opts.ctx ?? createObservabilityContext({ ledger }), async () => {
    try {
      return await writer.commit({
        op: "I",
        collection: "tickets",
        docId: "one",
        body: { _id: "one", status: "open", owner: "ada" },
        ...(opts.force === true && { forceMaintenance: true }),
      });
    } catch (error) {
      return error;
    }
  });
};

/** `MemoryStorage` that counts puts and records the ledger charge before the first. */
class PutCounting extends MemoryStorage {
  puts = 0;
  chargedBeforeFirstPut: number | undefined;
  ledger: RequestLedger | undefined;

  override async put(
    key: string,
    body: Uint8Array,
    opts?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    if (this.ledger !== undefined && this.chargedBeforeFirstPut === undefined) {
      // This put was charged already.
      this.chargedBeforeFirstPut = this.ledger.charged.internal - 1;
    }
    this.puts++;
    return super.put(key, body, opts);
  }
}

const provisioned = async (): Promise<PutCounting> => {
  const inner = new PutCounting();
  await createCurrentJson(inner, CURRENT_KEY, logStateCurrentJson());
  inner.puts = 0;
  return inner;
};

const foreignEntry = (seq: number): LogEntry => ({
  lsn: `0000000000000_PEERPEER_${String(seq)}`,
  commit_ts: new Date(0).toISOString(),
  op: "I",
  collection: "tickets",
  doc_id: "peer",
  session: "PEERPEER",
  seq,
  after: { _id: "peer" },
});

describe.each(POOLS)("Writer create under the request ledger (%s pool)", (pool) => {
  test("a create the ledger refuses before sending is CapacityExceeded, not applied", async () => {
    const inner = new MemoryStorage();
    await createCurrentJson(inner, CURRENT_KEY, logStateCurrentJson());
    const ledger = new RequestLedger(limitsFor(pool, 1000));
    const ledgered = ledgeredStorage(inner, pool);
    // A call outside the hold spends the budget just before the create.
    const storage: Storage = {
      ...ledgered,
      put: (key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> => {
        if (isLogCreate(key, opts)) {
          exhaust(ledger, pool);
        }
        return ledgered.put(key, body, opts);
      },
    };

    const err = await commitInsert(storage, ledger);

    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("CapacityExceeded");
    expect((err as BaerlyError).retriable).toBe(false);
    expect((err as BaerlyError).cause).toMatchObject({ refused: true, notApplied: true });
    await expect(inner.get(LOG_0)).resolves.toBeNull();
  });

  test("an uncertain create whose readback the ledger refuses is AmbiguousCommit with _id", async () => {
    const ledger = new RequestLedger(limitsFor(pool, 1000));
    class LandThenDrain extends MemoryStorage {
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        if (!isLogCreate(key, opts)) {
          return super.put(key, body, opts);
        }
        // The create lands, its acknowledgement is lost, and a call outside
        // the hold spends the rest of the budget before the adapter's resend.
        await super.put(key, body, opts);
        exhaust(ledger, pool);
        throw new BaerlyError("NetworkError", "lost create acknowledgement");
      }
    }
    const inner = new LandThenDrain();
    await createCurrentJson(inner, CURRENT_KEY, logStateCurrentJson());

    const err = await commitInsert(ledgeredStorage(inner, pool), ledger);

    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("AmbiguousCommit");
    expect((err as BaerlyError).retriable).toBe(false);
    expect((err as BaerlyError)._id).toBe("one");
    await expect(inner.get(LOG_0)).resolves.not.toBeNull();
  });
});

describe.each(POOLS)("Writer commit-resolution reserve (%s pool)", (pool) => {
  const indexes = [BY_STATUS, BY_OWNER];
  // Every marker PUT and the create at full retries, plus the reserve.
  const needed = STORAGE_RETRY_MAX_ATTEMPTS * (indexes.length + 1) + COMMIT_RESOLUTION_RESERVE;

  /** Storage calls the commit charges before its first index-marker PUT. */
  const chargedBeforeMarkers = async (): Promise<number> => {
    const inner = await provisioned();
    const ledger = new RequestLedger();
    inner.ledger = ledger;
    await expect(
      commitInsert(ledgeredStorage(inner, pool), ledger, { indexes }),
    ).resolves.toMatchObject({ entry: { seq: 0 } });
    return inner.chargedBeforeFirstPut!;
  };

  test("a budget one short of the reserve refuses before any index-marker PUT", async () => {
    expect(COMMIT_RESOLUTION_RESERVE).toBe(6);
    const limit = (await chargedBeforeMarkers()) + needed - 1;
    const inner = await provisioned();

    const err = await commitInsert(
      ledgeredStorage(inner, pool),
      new RequestLedger(limitsFor(pool, limit)),
      { indexes },
    );

    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("CapacityExceeded");
    expect((err as BaerlyError).retriable).toBe(false);
    expect((err as BaerlyError).cause).toMatchObject({ refused: true, needed });
    expect(inner.puts).toBe(0);
  });

  test("a budget exactly covering the reserve commits", async () => {
    const limit = (await chargedBeforeMarkers()) + needed;
    const inner = await provisioned();

    await expect(
      commitInsert(ledgeredStorage(inner, pool), new RequestLedger(limitsFor(pool, limit)), {
        indexes,
      }),
    ).resolves.toMatchObject({ entry: { seq: 0, doc_id: "one" } });
  });

  test("a lost create race re-checks the reserve before the next create", async () => {
    // Unindexed: the pre-marker check needs the create plus the reserve.
    const firstCheck = STORAGE_RETRY_MAX_ATTEMPTS + COMMIT_RESOLUTION_RESERVE;
    const measure = await provisioned();
    const measureLedger = new RequestLedger();
    measure.ledger = measureLedger;
    await commitInsert(ledgeredStorage(measure, pool), measureLedger);
    const before = measure.chargedBeforeFirstPut!;

    class PeerWins extends PutCounting {
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        if (key === LOG_0 && isLogCreate(key, opts)) {
          // A peer's create lands first; ours meets it as a 412.
          await super.put(key, encodeJsonBytes(foreignEntry(0)), { ifNoneMatch: "*" });
        }
        return super.put(key, body, opts);
      }
    }
    const inner = new PeerWins();
    await createCurrentJson(inner, CURRENT_KEY, logStateCurrentJson());

    const err = await commitInsert(
      ledgeredStorage(inner, pool),
      new RequestLedger(limitsFor(pool, before + firstCheck)),
    );

    // The 412, the occupant readback and the forward probe spent three of
    // the reserved requests, so the next create no longer fits.
    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("CapacityExceeded");
    expect((err as BaerlyError).cause).toMatchObject({ refused: true });
    await expect(inner.get(`${LOG_PREFIX}1.json`)).resolves.toBeNull();
    const occupant = await inner.get(LOG_0);
    expect(JSON.parse(new TextDecoder().decode(occupant!.body))).toMatchObject({
      session: "PEERPEER",
    });
  });

  test("a rebased post-image after a lost race re-checks the reserve with its markers", async () => {
    const rebased = { _id: "one", status: "rebased", owner: "grace" };
    const commitRebasing = async (storage: Storage, ledger: RequestLedger): Promise<unknown> => {
      const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY, options: { indexes } });
      return await runWithContext(createObservabilityContext({ ledger }), async () => {
        try {
          return await writer.commit({
            op: "U",
            collection: "tickets",
            docId: "one",
            body: { _id: "one", status: "open", owner: "ada" },
            // A peer's entry in the window re-decides the post-image.
            admission: {
              fromSeq: 0,
              check: (window) => (window.length === 0 ? undefined : { body: rebased }),
            },
          });
        } catch (error) {
          return error;
        }
      });
    };
    const measure = await provisioned();
    const measureLedger = new RequestLedger();
    measure.ledger = measureLedger;
    await expect(
      commitRebasing(ledgeredStorage(measure, pool), measureLedger),
    ).resolves.toMatchObject({ entry: { seq: 0 } });

    class PeerWins extends PutCounting {
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        if (key === LOG_0 && isLogCreate(key, opts)) {
          await super.put(key, encodeJsonBytes(foreignEntry(0)), { ifNoneMatch: "*" });
        }
        return super.put(key, body, opts);
      }
    }
    const inner = new PeerWins();
    await createCurrentJson(inner, CURRENT_KEY, logStateCurrentJson());

    const err = await commitRebasing(
      ledgeredStorage(inner, pool),
      new RequestLedger(limitsFor(pool, measure.chargedBeforeFirstPut! + needed)),
    );

    // Two marker PUTs, the 412, the readback and the probe spent five; the
    // rebased body's two markers, its create and the reserve need 15.
    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("CapacityExceeded");
    expect((err as BaerlyError).cause).toMatchObject({ refused: true, needed });
    await expect(inner.get(`${LOG_PREFIX}1.json`)).resolves.toBeNull();
  });

  test("an uncertain create with full retries on its readback and floor read resolves within the reserve, despite concurrent work", async () => {
    // Unindexed: the hold is the create's 3 attempts plus the reserve's 6.
    const before = await (async () => {
      const measure = await provisioned();
      const measureLedger = new RequestLedger();
      measure.ledger = measureLedger;
      await commitInsert(ledgeredStorage(measure, pool), measureLedger);
      return measure.chargedBeforeFirstPut!;
    })();
    expect(STORAGE_RETRY_MAX_ATTEMPTS + COMMIT_RESOLUTION_RESERVE).toBe(9);
    const ledger = new RequestLedger(limitsFor(pool, before + 9));
    const transient = (what: string): BaerlyError =>
      new BaerlyError("NetworkError", `${what}: 500`, { cause: { status: 500 } });
    class EveryCallRetried extends MemoryStorage {
      creates = 0;
      readbacks = 0;
      floorReads = 0;
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        if (!isLogCreate(key, opts)) {
          return super.put(key, body, opts);
        }
        this.creates++;
        if (this.creates === 1) {
          // Concurrent work in the invocation spends all it may.
          drain(ledger, pool);
          throw transient("create");
        }
        if (this.creates === 2) {
          // Lands, but the reply is lost.
          await super.put(key, body, opts);
          throw transient("create");
        }
        // The third attempt meets the landed create as a 412.
        return super.put(key, body, opts);
      }
      override async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
        if (key === LOG_0 && this.creates > 0 && ++this.readbacks < 3) {
          throw transient("readback");
        }
        if (key === CURRENT_KEY && this.readbacks > 0 && ++this.floorReads < 3) {
          throw transient("floor read");
        }
        return super.get(key, opts);
      }
    }
    const inner = new EveryCallRetried();
    await createCurrentJson(inner, CURRENT_KEY, logStateCurrentJson());
    const ctx = createObservabilityContext({ ledger });

    const result = await commitInsert(ledgeredStorage(inner, pool), ledger, { ctx });

    expect(result).toMatchObject({ entry: { seq: 0, doc_id: "one" } });
    expect([inner.creates, inner.readbacks, inner.floorReads]).toEqual([3, 3, 3]);
    expect(sumCounter(ctx, "db.write.delete_floor_check_skipped_total")).toBe(0);
    expect(ledger.storageRemaining()).toBe(0);
  });

  test("steps after the commit run outside the hold: a refusal there leaves the commit acknowledged", async () => {
    const inner = await provisioned();
    const seed = new Writer({ storage: inner, currentJsonKey: CURRENT_KEY, options: { indexes } });
    await seed.commit({
      op: "I",
      collection: "tickets",
      docId: "one",
      body: { _id: "one", status: "open", owner: "ada" },
    });
    const ledger = new RequestLedger(limitsFor(pool, 1000));
    const ledgered = ledgeredStorage(inner, pool);
    let committed = false;
    const storage: Storage = {
      ...ledgered,
      put: async (
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> => {
        const result = await ledgered.put(key, body, opts);
        committed ||= isLogCreate(key, opts);
        return result;
      },
      get: (key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> => {
        if (committed && key === LOG_0) {
          // The pre-image walk's first read: concurrent work has spent
          // everything outside the (now released) hold.
          drain(ledger, pool);
        }
        return ledgered.get(key, opts);
      },
    };
    const ctx = createObservabilityContext({ ledger });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY, options: { indexes } });

    const result = await runWithContext(ctx, () =>
      writer.commit({
        op: "U",
        collection: "tickets",
        docId: "one",
        body: { _id: "one", status: "closed", owner: "ada" },
        forceMaintenance: true,
      }),
    );

    errorLog.mockRestore();
    expect(result).toMatchObject({ entry: { seq: 1, op: "U" } });
    expect(sumCounter(ctx, "db.write.post_commit_refused_total", "pre-image-read")).toBe(1);
    expect(sumCounter(ctx, "db.write.delete_floor_check_skipped_total")).toBe(0);
  });
});

const ticketsConfig = { collections: { tickets: { indexes: [BY_STATUS, BY_OWNER] } } };

/** Seed rows `a` and `b`, open and indexed, outside any ledger. */
const seededTickets = async <S extends MemoryStorage>(inner: S): Promise<S> => {
  const seedDb = Db.create({ storage: inner, app: "test", tenant: "t", config: ticketsConfig });
  await seedDb.collection("tickets").insert({ _id: "a", status: "open", owner: "ada" });
  await seedDb.collection("tickets").insert({ _id: "b", status: "open", owner: "bob" });
  return inner;
};

const statuses = async (inner: MemoryStorage): Promise<Record<string, unknown>> => {
  const db = Db.create({ storage: inner, app: "test", tenant: "t", config: ticketsConfig });
  const rows = await db.collection("tickets").where({}).all();
  return Object.fromEntries(rows.map((r) => [r["_id"], r["status"]]));
};

const closeAll = async (storage: Storage, ctx: ObservabilityContext): Promise<unknown> => {
  const db = Db.create({ storage, app: "test", tenant: "t", config: ticketsConfig });
  return await runWithContext(ctx, async () => {
    try {
      return await db.collection("tickets").where({ status: "open" }).update({ status: "closed" });
    } catch (error) {
      return error;
    }
  });
};

describe.each(POOLS)("a multi-row indexed update under the request ledger (%s pool)", (pool) => {
  test("stopped by the budget, keeps the rows before the refused one and commits nothing after it", async () => {
    const inner = await seededTickets(new MemoryStorage());
    const ledger = new RequestLedger(limitsFor(pool, 1000));
    const ledgered = ledgeredStorage(inner, pool);
    // Row b's two markers and its create, with retries, plus the reserve.
    const rowNeeds = 3 * STORAGE_RETRY_MAX_ATTEMPTS + COMMIT_RESOLUTION_RESERVE;
    let creates = 0;
    let manifestReads = 0;
    const storage: Storage = {
      ...ledgered,
      put: async (
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> => {
        const result = await ledgered.put(key, body, opts);
        if (isLogCreate(key, opts) && key.includes("/log/")) {
          creates++;
        }
        return result;
      },
      get: (key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> => {
        // After row a's create: its floor check, then row b's Step 1 read.
        if (key === CURRENT_KEY && creates === 1 && ++manifestReads === 2) {
          // Row b's manifest read and tail probe leave one short of its hold.
          drain(ledger, pool, 2 + rowNeeds - 1);
        }
        return ledgered.get(key, opts);
      },
    };

    const err = await closeAll(storage, createObservabilityContext({ ledger }));

    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("CapacityExceeded");
    expect((err as BaerlyError).retriable).toBe(false);
    expect(creates).toBe(1);
    await expect(statuses(inner)).resolves.toEqual({ a: "closed", b: "open" });
  });

  test("a write tick running in waitUntil cannot spend the next row's reserve into AmbiguousCommit", async () => {
    const ledger = new RequestLedger(limitsFor(pool, 1000));
    // `ctx.waitUntil`: each tick runs in the context it was dispatched
    // from, concurrently with the request's later work.
    const ticks: Array<() => Promise<void>> = [];
    const dispatchedHolds: unknown[] = [];
    const ctx = createObservabilityContext({
      ledger,
      maintenance: {
        dispatch: (task) => {
          const from = getCurrentContext()!;
          // Dispatched outside the commit hold, so the tick's own calls
          // never draw on the next row's reserve.
          dispatchedHolds.push(from.hold);
          ticks.push(async () => {
            await runWithContext(from, task);
            // Whatever the fold left, other work outside the hold takes.
            runWithContext(from, () => drain(ledger, pool));
          });
        },
        // Fold after every write, as Free + S3's early fold does.
        // An adapter-only trigger, as `maintenance.ts` reads it.
        options: { foldAtTailEntries: 1 } as InternalBoundedMaintenanceOptions,
      },
    });
    let creates = 0;
    let ticksRun = 0;
    let unheldAfterTick: number | undefined;
    let armed = false;
    class LostAckOnRowB extends MemoryStorage {
      override async put(
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> {
        if (!armed || !isLogCreate(key, opts) || !key.includes("/log/") || ++creates !== 2) {
          return super.put(key, body, opts);
        }
        // Row b's create: row a's tick runs now, then the create lands
        // and its reply is lost, so resolving it needs the readback.
        for (const tick of ticks.splice(0)) {
          await tick();
          ticksRun++;
          unheldAfterTick = ledger.remaining(pool);
        }
        await super.put(key, body, opts);
        throw new BaerlyError("NetworkError", "lost create acknowledgement");
      }
    }
    const lossy = await seededTickets(new LostAckOnRowB());
    armed = true;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await closeAll(ledgeredStorage(lossy, pool), ctx);

    errorLog.mockRestore();
    expect(result).toEqual({ modified: 2 });
    expect(ticksRun).toBe(1);
    // The tick and the work behind it left nothing outside row b's hold.
    expect(unheldAfterTick).toBe(0);
    // Row a's create, row b's create, and the adapter's one retry of b's
    // lost-ack create (answered 412 by the landed entry), then the readback.
    expect(creates).toBe(3);
    // One dispatch per row, none from inside a commit hold.
    expect(dispatchedHolds).toEqual([undefined, undefined]);
    await expect(statuses(lossy)).resolves.toEqual({ a: "closed", b: "closed" });
  });
});

describe("index-count limit on Workers Free over fetch", () => {
  const KEY = "app/rc/tenant/t/manifests/docs/current.json";

  /**
   * Update one doc, changing all `indexes` indexed fields, at a pending
   * tail of `tail` entries over a folded snapshot, under the Free external
   * ledger. Returns the error code, or "ok".
   */
  const updateAt = async (tail: number, indexes: number): Promise<string> => {
    const inner = new MemoryStorage();
    const defs = Array.from({ length: indexes }, (_, k) => ({ name: `by_f${k}`, on: `f${k}` }));
    const coll = (storage: Storage) =>
      Db.create({
        storage,
        app: "rc",
        tenant: "t",
        config: { collections: { docs: { indexes: defs } } },
      }).collection("docs");
    const body = (id: string) => ({
      _id: id,
      ...Object.fromEntries(defs.map((d) => [d.on, "a"])),
    });
    const noTick = createObservabilityContext({ maintenance: { dispatch: () => {} } });
    await runWithContext(noTick, async () => {
      for (let i = 0; i < 10; i++) {
        await coll(inner).insert(body(`s${i}`));
      }
    });
    await compact({ storage: inner, currentJsonKey: KEY }, {
      maxEntriesPerRun: 10,
      minEntriesToCompact: 1,
    } as InternalCompactOptions);
    await runWithContext(noTick, async () => {
      for (let i = 0; i < tail; i++) {
        await coll(inner).insert(body(`t${i}`));
      }
    });
    const ledger = new RequestLedger({
      internal: CF_FREE_INTERNAL_REQUEST_LIMIT,
      external: CF_FREE_EXTERNAL_REQUEST_LIMIT,
    });
    const ctx = createObservabilityContext({ ledger, maintenance: { dispatch: () => {} } });
    return await runWithContext(ctx, async () => {
      try {
        await coll(ledgeredStorage(inner, "external")).update(
          "s1",
          Object.fromEntries(defs.map((d) => [d.on, "z"])),
        );
        return "ok";
      } catch (error) {
        return (error as BaerlyError).code;
      }
    });
  };

  // Published in docs/about/workload-fit.md: an update changing 9 indexed
  // fields is refused once 5 or more writes are pending. The update reads
  // 5 + tail calls before its hold; the hold is 3 x (markers + 1) + 6.
  test("an update changing 9 indexed fields is refused from a 5-entry tail; at 4 it commits", async () => {
    const indexes = 9;
    const needed = (tail: number): number =>
      5 + tail + STORAGE_RETRY_MAX_ATTEMPTS * (indexes + 1) + COMMIT_RESOLUTION_RESERVE;
    // The first tail at which the 9-index update no longer fits.
    let firstRefusedTail = 0;
    while (needed(firstRefusedTail) <= CF_FREE_EXTERNAL_REQUEST_LIMIT) {
      firstRefusedTail += 1;
    }
    expect(firstRefusedTail).toBe(5);
    await expect(updateAt(firstRefusedTail - 1, indexes)).resolves.toBe("ok");
    await expect(updateAt(firstRefusedTail, indexes)).resolves.toBe("CapacityExceeded");
  });
});
