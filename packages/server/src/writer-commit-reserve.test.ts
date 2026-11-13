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
  COMMIT_RESOLUTION_RESERVE,
  createCurrentJson,
  encodeJsonBytes,
  type LogEntry,
  MemoryStorage,
  RequestLedger,
  type RequestPool,
  type Storage,
  type StoragePutOptions,
  type StoragePutResult,
  STORAGE_RETRY_MAX_ATTEMPTS,
} from "@baerly/protocol";
import { describe, expect, test, vi } from "vitest";
import { ledgeredStorage } from "../../../tests/fixtures/ledgered-storage.ts";
import { logStateCurrentJson } from "../../../tests/fixtures/log-state.ts";
import { Db } from "./db.ts";
import type { IndexDefinition } from "./indexes.ts";
import {
  createObservabilityContext,
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
    // Concurrent work spends the budget just before the create is sent.
    const storage: Storage = {
      ...ledgered,
      put: (key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> => {
        if (isLogCreate(key, opts)) {
          drain(ledger, pool);
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
        // The create lands, its acknowledgement is lost, and concurrent
        // work spends the rest of the budget before the adapter's resend.
        await super.put(key, body, opts);
        drain(ledger, pool);
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

  test("an acknowledged commit survives refused post-commit steps and a refused tick", async () => {
    const inner = await provisioned();
    const ledger = new RequestLedger(limitsFor(pool, 1000));
    const ledgered = ledgeredStorage(inner, pool);
    const storage: Storage = {
      ...ledgered,
      put: async (
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> => {
        const result = await ledgered.put(key, body, opts);
        if (isLogCreate(key, opts)) {
          // Concurrent work spends the reserve right after the commit.
          drain(ledger, pool);
        }
        return result;
      },
    };
    const ctx = createObservabilityContext({ ledger });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await commitInsert(storage, ledger, { ctx, force: true });

    errorLog.mockRestore();
    expect(result).toMatchObject({ entry: { seq: 0, doc_id: "one" } });
    await expect(inner.get(LOG_0)).resolves.not.toBeNull();
    expect(sumCounter(ctx, "db.write.post_commit_refused_total", "delete-floor-check")).toBe(1);
    expect(sumCounter(ctx, "db.write.delete_floor_check_skipped_total")).toBe(1);
  });
});

describe.each(POOLS)("a multi-row update stopped by the request ledger (%s pool)", (pool) => {
  test("keeps the rows before the refused one and commits nothing after it", async () => {
    const inner = new MemoryStorage();
    const seedDb = Db.create({ storage: inner, app: "test", tenant: "t" });
    await seedDb.collection("tickets").insert({ _id: "a", status: "open" });
    await seedDb.collection("tickets").insert({ _id: "b", status: "open" });

    const ledger = new RequestLedger(limitsFor(pool, 1000));
    const ledgered = ledgeredStorage(inner, pool);
    let creates = 0;
    const storage: Storage = {
      ...ledgered,
      put: async (
        key: string,
        body: Uint8Array,
        opts?: StoragePutOptions,
      ): Promise<StoragePutResult> => {
        const result = await ledgered.put(key, body, opts);
        if (isLogCreate(key, opts) && ++creates === 1) {
          // After the first row commits, leave less than the next row's
          // create plus its reserve.
          drain(ledger, pool, STORAGE_RETRY_MAX_ATTEMPTS + COMMIT_RESOLUTION_RESERVE - 1);
        }
        return result;
      },
    };
    const db = Db.create({ storage, app: "test", tenant: "t" });

    const err = await runWithContext(createObservabilityContext({ ledger }), async () => {
      try {
        await db.collection("tickets").where({ status: "open" }).update({ status: "closed" });
        return undefined;
      } catch (error) {
        return error;
      }
    });

    expect(err).toBeInstanceOf(BaerlyError);
    expect((err as BaerlyError).code).toBe("CapacityExceeded");
    expect((err as BaerlyError).retriable).toBe(false);
    expect(creates).toBe(1);
    const rows = await seedDb.collection("tickets").where({}).all();
    const byId = Object.fromEntries(rows.map((r) => [r["_id"], r["status"]]));
    expect(byId).toEqual({ a: "closed", b: "open" });
  });
});
