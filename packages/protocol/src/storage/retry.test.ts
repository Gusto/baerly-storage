import { describe, expect, test } from "vitest";
import {
  STORAGE_RETRY_MAX_ATTEMPTS,
  STORAGE_RETRY_MAX_DELAY_MILLIS,
  STORAGE_RETRY_THROTTLE_BASE_MILLIS,
  STORAGE_RETRY_TRANSIENT_BASE_MILLIS,
} from "../constants.ts";
import { BaerlyError } from "../errors.ts";
import { retryStorageCall, storageRetryDelayMillis } from "./retry.ts";

/** A call that rejects with `errors[i]` on attempt i (the last one repeats). */
const sequence = (errors: readonly unknown[]) => {
  let calls = 0;
  const fn = async (): Promise<never> => {
    throw errors[Math.min(calls++, errors.length - 1)];
  };
  return { fn, calls: () => calls };
};

/** Records every backoff instead of sleeping. */
const recordingSleep = () => {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number): Promise<void> => {
      waits.push(ms);
    },
  };
};

const transient = () => new BaerlyError("NetworkError", "500", { cause: { status: 500 } });
const throttled = () =>
  new BaerlyError("NetworkError", "429", { cause: { status: 429, throttled: true } });
const hinted = (seconds: number) =>
  new BaerlyError("NetworkError", "429", {
    cause: {
      status: 429,
      throttled: true,
      retryAfterSeconds: seconds,
    },
  });

// Just under 1, so full jitter lands at (almost) its ceiling.
const NEAR_ONE = 1 - 2 ** -20;

describe("retryStorageCall attempt cap", () => {
  test(`a call failing forever makes STORAGE_RETRY_MAX_ATTEMPTS (${STORAGE_RETRY_MAX_ATTEMPTS}) attempts`, async () => {
    const { fn, calls } = sequence([transient()]);
    const { sleep, waits } = recordingSleep();
    await expect(retryStorageCall(fn, { sleep })).rejects.toMatchObject({ code: "NetworkError" });
    expect(calls()).toBe(STORAGE_RETRY_MAX_ATTEMPTS);
    expect(calls()).toBe(3);
    // One backoff between consecutive attempts, none after the last.
    expect(waits).toHaveLength(STORAGE_RETRY_MAX_ATTEMPTS - 1);
  });

  test("throttles and transient failures share the one counter", async () => {
    const { fn, calls } = sequence([throttled(), transient(), throttled(), transient()]);
    const { sleep } = recordingSleep();
    await expect(retryStorageCall(fn, { sleep })).rejects.toMatchObject({ code: "NetworkError" });
    expect(calls()).toBe(3);
  });

  test("retries: 0 makes exactly one attempt, even when throttled", async () => {
    const { fn, calls } = sequence([throttled()]);
    const { sleep, waits } = recordingSleep();
    await expect(retryStorageCall(fn, { retries: 0, sleep })).rejects.toMatchObject({
      code: "NetworkError",
    });
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  test("an explicit retries makes retries + 1 attempts", async () => {
    const { fn, calls } = sequence([transient()]);
    const { sleep } = recordingSleep();
    await expect(retryStorageCall(fn, { retries: 4, sleep })).rejects.toBeInstanceOf(BaerlyError);
    expect(calls()).toBe(5);
  });

  test("a success on the last attempt resolves", async () => {
    let calls = 0;
    const { sleep } = recordingSleep();
    const fn = async (): Promise<string> => {
      calls++;
      if (calls < STORAGE_RETRY_MAX_ATTEMPTS) {
        throw transient();
      }
      return "ok";
    };
    await expect(retryStorageCall(fn, { sleep })).resolves.toBe("ok");
    expect(calls).toBe(STORAGE_RETRY_MAX_ATTEMPTS);
  });

  test("a permanent code ends the loop on the first attempt", async () => {
    const { fn, calls } = sequence([new BaerlyError("AccessDenied", "403")]);
    const { sleep, waits } = recordingSleep();
    await expect(retryStorageCall(fn, { sleep })).rejects.toMatchObject({ code: "AccessDenied" });
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  test.each([1.5, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "retries: %s is rejected as InvalidConfig before any attempt",
    async (retries) => {
      const { fn, calls } = sequence([transient()]);
      const { sleep } = recordingSleep();
      await expect(retryStorageCall(fn, { retries, sleep })).rejects.toMatchObject({
        code: "InvalidConfig",
      });
      expect(calls()).toBe(0);
    },
  );
});

describe("retryStorageCall backoff", () => {
  test("transient failures back off with full jitter under the 50 ms base: ceilings 50, 100", async () => {
    const { fn } = sequence([transient()]);
    const { sleep, waits } = recordingSleep();
    await retryStorageCall(fn, { sleep, random: () => NEAR_ONE }).catch(() => undefined);
    expect(STORAGE_RETRY_TRANSIENT_BASE_MILLIS).toBe(50);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeCloseTo(50, 2);
    expect(waits[1]).toBeCloseTo(100, 2);
  });

  test("throttles back off under the 1 s base: ceilings 1000, 2000", async () => {
    const { fn } = sequence([throttled()]);
    const { sleep, waits } = recordingSleep();
    await retryStorageCall(fn, { sleep, random: () => NEAR_ONE }).catch(() => undefined);
    expect(STORAGE_RETRY_THROTTLE_BASE_MILLIS).toBe(1000);
    expect(waits).toHaveLength(2);
    expect(waits[0]).toBeCloseTo(1000, 1);
    expect(waits[1]).toBeCloseTo(2000, 1);
  });

  test("the jitter draw scales the wait linearly from 0", async () => {
    for (const r of [0, 0.25, 0.5]) {
      const { fn } = sequence([transient()]);
      const { sleep, waits } = recordingSleep();
      await retryStorageCall(fn, { sleep, random: () => r }).catch(() => undefined);
      expect(waits).toEqual([r * 50, r * 100]);
    }
  });

  test("the exponential ceiling is capped at STORAGE_RETRY_MAX_DELAY_MILLIS (20 s)", () => {
    expect(STORAGE_RETRY_MAX_DELAY_MILLIS).toBe(20_000);
    expect(storageRetryDelayMillis(throttled(), 4, { random: () => NEAR_ONE })).toBeCloseTo(
      16_000,
      0,
    );
    expect(storageRetryDelayMillis(throttled(), 5, { random: () => NEAR_ONE })).toBeCloseTo(
      20_000,
      0,
    );
    expect(storageRetryDelayMillis(transient(), 30, { random: () => NEAR_ONE })).toBeCloseTo(
      20_000,
      0,
    );
  });

  test("backoffMs overrides both bases", () => {
    const opts = { backoffMs: 10, random: () => NEAR_ONE };
    expect(storageRetryDelayMillis(transient(), 1, opts)).toBeCloseTo(20, 3);
    expect(storageRetryDelayMillis(throttled(), 1, opts)).toBeCloseTo(20, 3);
    expect(storageRetryDelayMillis(throttled(), 0, { backoffMs: 0, random: () => NEAR_ONE })).toBe(
      0,
    );
  });

  test("a Retry-After hint replaces the jittered wait", async () => {
    const { fn } = sequence([hinted(5), hinted(0)]);
    const { sleep, waits } = recordingSleep();
    await retryStorageCall(fn, { sleep, random: () => 0 }).catch(() => undefined);
    expect(waits).toEqual([5000, 0]);
  });

  test("a Retry-After hint is clamped to STORAGE_RETRY_MAX_DELAY_MILLIS", () => {
    expect(storageRetryDelayMillis(hinted(60), 0)).toBe(STORAGE_RETRY_MAX_DELAY_MILLIS);
  });

  test("an error that is not a BaerlyError backs off as transient", () => {
    expect(
      storageRetryDelayMillis(new TypeError("fetch failed"), 0, { random: () => NEAR_ONE }),
    ).toBeCloseTo(50, 2);
  });
});

describe("retryStorageCall with conditionalCreate", () => {
  const run = (fn: () => Promise<never>) =>
    retryStorageCall(fn, { conditionalCreate: true, sleep: async () => {} }).catch(
      (error: unknown) => error,
    );

  test("an all-throttled create reports notApplied and stays a retriable NetworkError", async () => {
    const { fn, calls } = sequence([throttled()]);
    const failure = (await run(fn)) as BaerlyError;
    expect(failure).toMatchObject({
      code: "NetworkError",
      cause: { status: 429, throttled: true, notApplied: true },
    });
    expect(failure.retriable).toBe(true);
    expect(calls()).toBe(STORAGE_RETRY_MAX_ATTEMPTS);
  });

  test("an all-throttled create capped at retries: 0 still reports notApplied", async () => {
    const { fn } = sequence([throttled()]);
    const failure = await retryStorageCall(fn, { retries: 0, conditionalCreate: true }).catch(
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: "NetworkError", cause: { notApplied: true } });
  });

  test("a throttle after an uncertain attempt does not report notApplied", async () => {
    const { fn } = sequence([transient(), throttled()]);
    const failure = (await run(fn)) as BaerlyError;
    expect(failure).toMatchObject({ code: "NetworkError" });
    expect(failure.cause).not.toHaveProperty("notApplied");
  });

  test("an uncertain final attempt does not report notApplied", async () => {
    const { fn } = sequence([throttled(), throttled(), transient()]);
    const failure = (await run(fn)) as BaerlyError;
    expect(failure.cause).not.toHaveProperty("notApplied");
  });

  test("a first-attempt AccessDenied stays definitive", async () => {
    const { fn, calls } = sequence([new BaerlyError("AccessDenied", "403")]);
    await expect(run(fn)).resolves.toMatchObject({ code: "AccessDenied" });
    expect(calls()).toBe(1);
  });

  test("an AccessDenied after an uncertain attempt becomes NetworkError", async () => {
    const denied = new BaerlyError("AccessDenied", "403");
    const { fn } = sequence([new TypeError("ack lost"), denied]);
    await expect(run(fn)).resolves.toMatchObject({ code: "NetworkError", cause: denied });
  });

  test("an AccessDenied after only throttled attempts stays definitive", async () => {
    const { fn } = sequence([throttled(), new BaerlyError("AccessDenied", "403")]);
    await expect(run(fn)).resolves.toMatchObject({ code: "AccessDenied" });
  });

  test("a precondition failure after an uncertain attempt is rethrown as-is, for the caller's readback", async () => {
    const preconditionFailed = new BaerlyError("WriteConflict", "412");
    const { fn } = sequence([new TypeError("ack lost"), preconditionFailed]);
    await expect(run(fn)).resolves.toBe(preconditionFailed);
  });

  test("without conditionalCreate an all-throttled call carries no notApplied", async () => {
    const { fn } = sequence([throttled()]);
    const failure = (await retryStorageCall(fn, { sleep: async () => {} }).catch(
      (error: unknown) => error,
    )) as BaerlyError;
    expect(failure.cause).not.toHaveProperty("notApplied");
  });

  test("without conditionalCreate a post-retry AccessDenied is unchanged", async () => {
    const { fn } = sequence([new TypeError("ack lost"), new BaerlyError("AccessDenied", "403")]);
    await expect(retryStorageCall(fn, { sleep: async () => {} })).rejects.toMatchObject({
      code: "AccessDenied",
    });
  });
});
