import { afterEach, describe, expect, test, vi } from "vitest";
import { dateToSecs, delay } from "./time.ts";

describe("dateToSecs", () => {
  test("Mon, 3 Oct 2016 22:32:00 GMT", () => {
    expect(dateToSecs("Mon, 3 Oct 2016 22:32:00 GMT")).toBe(1475533920);
  });

  test("Mon, 3 Oct 2016 22:32:01 GMT", () => {
    expect(dateToSecs("Mon, 3 Oct 2016 22:32:01 GMT")).toBe(1475533921);
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
