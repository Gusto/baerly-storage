import { afterEach, expect, test, vi } from "vitest";
import {
  retryDelay,
  SUBSCRIPTION_RETRY_INITIAL_MILLIS,
  SUBSCRIPTION_RETRY_MAX_MILLIS,
} from "./subscription-retry.ts";

const boundFor = (attempt: number): number =>
  Math.min(SUBSCRIPTION_RETRY_MAX_MILLIS, SUBSCRIPTION_RETRY_INITIAL_MILLIS * 2 ** attempt);

afterEach(() => {
  vi.restoreAllMocks();
});

test("the delay floor doubles per attempt and then saturates", () => {
  // `Math.random() === 0` returns the bottom of each jitter band, which
  // is the bound's own doubling made visible.
  vi.spyOn(Math, "random").mockReturnValue(0);
  const floors: number[] = [];
  for (let attempt = 0; attempt < 8; attempt += 1) {
    floors.push(retryDelay(attempt));
  }

  expect(floors).toEqual([125, 250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
});

test("no attempt exceeds the cap, however long the table stays wedged", () => {
  // `2 ** 1024` overflows to Infinity. A wedged table reaches high
  // attempt counts by design, so the saturating arm has to hold there
  // rather than only across the handful of attempts a pool test walks.
  for (const attempt of [8, 16, 64, 1_024]) {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(retryDelay(attempt), `attempt ${attempt} floor`).toBe(SUBSCRIPTION_RETRY_MAX_MILLIS / 2);

    // `(1 - ε/2) * 5000` rounds back to `5000` in float64, so the top
    // of the band is the cap itself rather than one below it.
    vi.spyOn(Math, "random").mockReturnValue(1 - Number.EPSILON / 2);
    expect(retryDelay(attempt), `attempt ${attempt} ceiling`).toBe(SUBSCRIPTION_RETRY_MAX_MILLIS);
  }
});

test("every unstubbed draw lands in the top half of its bound", () => {
  // Half the bound is fixed so a wedged table backs off monotonically;
  // half is random so a fleet that lost the same server does not
  // re-converge into one synchronised retry wave. Drawn for real
  // because every other test here pins `Math.random`.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const bound = boundFor(attempt);
    for (let draw = 0; draw < 50; draw += 1) {
      const delay = retryDelay(attempt);
      expect(delay, `attempt ${attempt}`).toBeGreaterThanOrEqual(bound / 2);
      expect(delay, `attempt ${attempt}`).toBeLessThanOrEqual(bound);
    }
  }
});
