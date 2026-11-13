import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CF_CACHE_API_MAX_CALLS } from "../constants.ts";
import { BaerlyError } from "../errors.ts";
import {
  RequestLedger,
  currentRequestLedger,
  setRequestHoldResolver,
  setRequestLedgerResolver,
} from "./ledger.ts";
import { retryStorageCall } from "./retry.ts";

const noSleep = async (): Promise<void> => {};
const transient = () => new BaerlyError("NetworkError", "500", { cause: { status: 500 } });

/** Make `ledger` the active one for the duration of each test. */
let active: RequestLedger | undefined;
beforeEach(() => {
  active = undefined;
  setRequestLedgerResolver(() => active);
});
afterEach(() => {
  setRequestLedgerResolver(() => undefined);
});

describe("RequestLedger", () => {
  test("charges up to the limit and refuses the next request without charging it", () => {
    const ledger = new RequestLedger({ internal: 3, external: 2 });
    ledger.acquire("internal");
    ledger.acquire("internal");
    ledger.acquire("internal");
    expect(ledger.remaining("internal")).toBe(0);
    let refusal: unknown;
    try {
      ledger.acquire("internal");
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toMatchObject({
      code: "CapacityExceeded",
      cause: { refused: true, pool: "internal", limit: 3 },
    });
    expect(ledger.charged).toEqual({ internal: 3, external: 0, cache: 0 });
  });

  test("an external request is charged to both pools and needs room in both", () => {
    const ledger = new RequestLedger({ internal: 3, external: 2 });
    ledger.acquire("external");
    ledger.acquire("external");
    expect(ledger.charged).toEqual({ internal: 2, external: 2, cache: 0 });
    expect(() => ledger.acquire("external")).toThrow(/2 external storage calls/);
    // The internal pool still has one.
    ledger.acquire("internal");
    expect(() => ledger.acquire("internal")).toThrow(BaerlyError);

    const tightInternal = new RequestLedger({ internal: 1, external: 5 });
    tightInternal.acquire("internal");
    expect(tightInternal.remaining("external")).toBe(0);
    expect(() => tightInternal.acquire("external")).toThrow(BaerlyError);
  });

  test("the default limits count without refusing", () => {
    const ledger = new RequestLedger();
    for (let i = 0; i < 10_000; i++) {
      ledger.acquire("external");
    }
    expect(ledger.charged.external).toBe(10_000);
  });

  test(`a cache call is skipped past ${CF_CACHE_API_MAX_CALLS} calls or a full external pool`, () => {
    const ledger = new RequestLedger({ internal: 100, external: 100 });
    for (let i = 0; i < CF_CACHE_API_MAX_CALLS; i++) {
      expect(ledger.chargeCacheCall()).toBe(true);
    }
    expect(ledger.chargeCacheCall()).toBe(false);
    expect(ledger.charged).toEqual({
      internal: CF_CACHE_API_MAX_CALLS,
      external: CF_CACHE_API_MAX_CALLS,
      cache: CF_CACHE_API_MAX_CALLS,
    });

    const full = new RequestLedger({ internal: 100, external: 1 });
    full.acquire("external");
    expect(full.chargeCacheCall()).toBe(false);
    // A required call (invalidation) is charged past the limit, never skipped.
    expect(full.chargeCacheCall(true)).toBe(true);
    expect(full.charged).toEqual({ internal: 2, external: 2, cache: 1 });
  });

  test("the resolver supplies the active ledger", () => {
    expect(currentRequestLedger()).toBeUndefined();
    active = new RequestLedger();
    expect(currentRequestLedger()).toBe(active);
  });
});

describe("retryStorageCall charges the active ledger", () => {
  test("every attempt is charged, the hidden retries included", async () => {
    active = new RequestLedger();
    let calls = 0;
    await retryStorageCall(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw transient();
        }
        return "ok";
      },
      { sleep: noSleep },
    );
    expect(calls).toBe(3);
    expect(active.charged).toEqual({ internal: 3, external: 3, cache: 0 });
  });

  test("the pool option charges the internal pool only", async () => {
    active = new RequestLedger();
    await retryStorageCall(async () => "ok", { pool: "internal" });
    expect(active.charged).toEqual({ internal: 1, external: 0, cache: 0 });
  });

  test("a request past the limit is never issued", async () => {
    active = new RequestLedger({ internal: 2, external: 2 });
    let issued = 0;
    const call = () =>
      retryStorageCall(async () => {
        issued += 1;
        return "ok";
      });
    await call();
    await call();
    await expect(call()).rejects.toMatchObject({
      code: "CapacityExceeded",
      cause: { refused: true },
    });
    expect(issued).toBe(2);
  });

  test("a refused retry ends the loop without sending it", async () => {
    active = new RequestLedger({ internal: 2, external: 2 });
    let issued = 0;
    await expect(
      retryStorageCall(
        async () => {
          issued += 1;
          throw transient();
        },
        { sleep: noSleep },
      ),
    ).rejects.toMatchObject({ code: "CapacityExceeded" });
    expect(issued).toBe(2);
  });

  test("a create refused on its first attempt reports notApplied", async () => {
    active = new RequestLedger({ internal: 0, external: 0 });
    let issued = 0;
    const failure = (await retryStorageCall(
      async () => {
        issued += 1;
      },
      { conditionalCreate: true },
    ).catch((error: unknown) => error)) as BaerlyError;
    expect(issued).toBe(0);
    expect(failure).toMatchObject({
      code: "CapacityExceeded",
      cause: { refused: true, notApplied: true },
    });
  });

  test("a create refused after an uncertain attempt has an unknown fate", async () => {
    active = new RequestLedger({ internal: 1, external: 1 });
    const failure = (await retryStorageCall(
      async () => {
        throw transient();
      },
      { conditionalCreate: true, sleep: noSleep },
    ).catch((error: unknown) => error)) as BaerlyError;
    expect(failure).toMatchObject({ code: "NetworkError", cause: { refused: true } });
    expect(failure.cause).not.toHaveProperty("notApplied");
  });

  test("a Promise.all fan-out never issues past the limit", async () => {
    active = new RequestLedger({ internal: 5, external: 5 });
    let issued = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, () =>
        retryStorageCall(async () => {
          issued += 1;
          await new Promise((resolve) => setTimeout(resolve, 1));
          return "ok";
        }),
      ),
    );
    expect(issued).toBe(5);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(active.charged.external).toBe(5);
  });
});

describe("RequestLedger.storageRemaining", () => {
  test("is unbounded until a storage call is charged, then follows that call's pool", () => {
    const ledger = new RequestLedger({ internal: 10, external: 4 });
    ledger.chargeCacheCall();
    expect(ledger.storageRemaining()).toBe(Infinity);
    ledger.acquire("internal");
    // A cache call also charged `internal`: 10 - 2.
    expect(ledger.storageRemaining()).toBe(8);
  });

  test("an external storage call makes the stricter external pool the one that counts", () => {
    const ledger = new RequestLedger({ internal: 10, external: 4 });
    ledger.acquire("external");
    ledger.acquire("internal");
    expect(ledger.storageRemaining()).toBe(3);
  });

  test("a refused storage call still names its pool", () => {
    const ledger = new RequestLedger({ internal: 0, external: 0 });
    expect(() => ledger.acquire("internal")).toThrow(BaerlyError);
    expect(ledger.storageRemaining()).toBe(0);
  });
});

describe("RequestLedger.hold", () => {
  test("held requests are spendable only through the hold", () => {
    const ledger = new RequestLedger({ internal: 5, external: Infinity });
    ledger.acquire("internal");
    const hold = ledger.hold(3);
    expect(ledger.storageRemaining()).toBe(1);
    ledger.acquire("internal");
    expect(() => ledger.acquire("internal")).toThrow(BaerlyError);
    ledger.acquire("internal", hold);
    ledger.acquire("internal", hold);
    ledger.acquire("internal", hold);
    expect(hold.left).toBe(0);
    expect(() => ledger.acquire("internal", hold)).toThrow(BaerlyError);
  });

  test("release returns the unspent part, once", () => {
    const ledger = new RequestLedger({ internal: 10, external: 10 });
    const hold = ledger.hold(4);
    ledger.acquire("external", hold);
    expect(ledger.remaining("external")).toBe(6);
    hold.release();
    hold.release();
    expect(ledger.held).toBe(0);
    expect(ledger.remaining("external")).toBe(9);
  });

  test("a hold on another ledger does not lift this one's holds", () => {
    const ledger = new RequestLedger({ internal: 2, external: 2 });
    const other = new RequestLedger({ internal: 2, external: 2 }).hold(2);
    ledger.hold(2);
    expect(() => ledger.acquire("external", other)).toThrow(BaerlyError);
  });

  test("retryStorageCall charges the active hold, and an optional cache call cannot dip into it", async () => {
    const ledger = new RequestLedger({ internal: 3, external: 3 });
    active = ledger;
    const hold = ledger.hold(3);
    expect(ledger.chargeCacheCall()).toBe(false);
    setRequestHoldResolver(() => hold);
    try {
      await retryStorageCall(async () => "ok");
    } finally {
      setRequestHoldResolver(() => undefined);
    }
    expect(hold.left).toBe(2);
    expect(ledger.charged.external).toBe(1);
  });
});
