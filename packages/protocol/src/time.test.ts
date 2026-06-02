import { afterEach, describe, expect, test, vi } from "vitest";
import { TIMESTAMP_BIT_WIDTH } from "./constants.ts";
import { BaerlyError } from "./errors.ts";
import { delay, timestamp } from "./time.ts";
import { str2uintDesc } from "./types.ts";

describe("timestamp", () => {
  test("round-trips a real Date.now() instant", () => {
    const now = Date.now();
    expect(str2uintDesc(timestamp(now), TIMESTAMP_BIT_WIDTH)).toBe(now);
  });

  test("newer instants sort lexicographically BEFORE older ones (descending)", () => {
    expect(timestamp(2000) < timestamp(1000)).toBe(true);
  });

  test.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -1],
    ["non-integer", 1.5],
    ["out of range", 2 ** TIMESTAMP_BIT_WIDTH],
  ])("throws loud on a %s epoch instead of silently corrupting the key", (_label, epoch) => {
    // Assert code="Internal" (kills L21 StringLiteral→"") and message contains the epoch
    // (kills L22 StringLiteral→``): checking only `toThrowError(BaerlyError)` misses both.
    let caught: unknown;
    try {
      timestamp(epoch);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BaerlyError);
    const err = caught as BaerlyError;
    expect(err.code).toBe("Internal");
    expect(err.message).toContain(String(epoch));
  });

  test("0 encodes the most-ancient instant (why there is no argless default)", () => {
    // Guards the regression: an argless `timestamp()` used to default to
    // 0, which descending-sorts as the LARGEST key — silently inverting
    // ordering. 0 is still a *valid* explicit argument; it's the implicit
    // default that was the foot-gun.
    expect(timestamp(0) > timestamp(Date.now())).toBe(true);
  });
});

describe("delay", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("resolves after roughly the requested time", async () => {
    vi.useFakeTimers();
    let resolved = false;
    const promise = delay(1000).then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await promise;
    expect(resolved).toBe(true);
  });

  test("rejects immediately if the signal is already aborted", async () => {
    const reason = new Error("already aborted");
    const controller = new AbortController();
    controller.abort(reason);
    await expect(delay(1000, controller.signal)).rejects.toBe(reason);
  });

  test("rejects with signal.reason if aborted during the wait, and clears the timer", async () => {
    vi.useFakeTimers();
    const reason = new Error("aborted mid-wait");
    const controller = new AbortController();
    const promise = delay(1000, controller.signal);
    promise.catch(() => {});

    await vi.advanceTimersByTimeAsync(500);
    controller.abort(reason);
    await expect(promise).rejects.toBe(reason);

    // No leaked timer: advancing past the original deadline must not
    // schedule any further work, and there should be no pending timers.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
  });
});
