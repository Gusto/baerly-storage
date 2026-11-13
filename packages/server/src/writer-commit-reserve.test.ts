/**
 * The committing create under the per-invocation request ledger: a
 * create the ledger refuses before sending is definitively not applied,
 * and an uncertain create whose readback the ledger refuses is
 * `AmbiguousCommit`.
 */

import {
  BaerlyError,
  createCurrentJson,
  MemoryStorage,
  RequestLedger,
  type RequestPool,
  type Storage,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import { describe, expect, test } from "vitest";
import { ledgeredStorage } from "../../../tests/fixtures/ledgered-storage.ts";
import { logStateCurrentJson } from "../../../tests/fixtures/log-state.ts";
import { createObservabilityContext, runWithContext } from "./observability/context.ts";
import { Writer } from "./writer.ts";

const CURRENT_KEY = "app/test/tenant/t/manifests/tickets/current.json";
const LOG_PREFIX = "app/test/tenant/t/manifests/tickets/log/";
const LOG_0 = `${LOG_PREFIX}0.json`;

const isLogCreate = (key: string, opts?: StoragePutOptions): boolean =>
  key.startsWith(LOG_PREFIX) && opts?.ifNoneMatch === "*";

/** Spend every request left on `pool`, as concurrent work in the same invocation would. */
const drain = (ledger: RequestLedger, pool: RequestPool): void => {
  while (ledger.remaining(pool) > 0) {
    ledger.acquire(pool);
  }
};

const POOLS: readonly RequestPool[] = ["internal", "external"];

const limitsFor = (pool: RequestPool, limit: number) =>
  pool === "internal"
    ? { internal: limit, external: Infinity }
    : { internal: limit, external: limit };

const commitInsert = async (storage: Storage, ledger: RequestLedger): Promise<unknown> => {
  const writer = new Writer({ storage, currentJsonKey: CURRENT_KEY });
  return await runWithContext(createObservabilityContext({ ledger }), async () => {
    try {
      return await writer.commit({
        op: "I",
        collection: "tickets",
        docId: "one",
        body: { _id: "one" },
      });
    } catch (error) {
      return error;
    }
  });
};

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
