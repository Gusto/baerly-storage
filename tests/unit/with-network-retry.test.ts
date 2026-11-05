import { describe, expect, test } from "vitest";
import { BaerlyError } from "@baerly/protocol";
import {
  MAX_NETWORK_RETRIES,
  NETWORK_RETRY_BASE_MS,
  withNetworkRetry,
} from "../fixtures/randomized-cascade.ts";
import { isUnacknowledgedCommitError } from "../fixtures/session-guarantees.ts";

// withNetworkRetry rides out the node-minio Toxiproxy flips the cascade
// runs under. Its branches — retry only on the chosen predicate, bounded
// attempts, propagate everything else — are load-bearing (an unbounded or
// wrong-predicate retry would hang or mask real failures), so pin them
// deterministically here rather than leaning on the probabilistic cascade.

const networkError = (): BaerlyError => new BaerlyError("NetworkError", "toxiproxy flip");

/** Records backoff waits instead of sleeping, so the bounded case stays fast. */
const recordingSleep = (): { waits: number[]; sleep: (ms: number) => Promise<void> } => {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    },
  };
};

describe("withNetworkRetry", () => {
  test("returns the op result without retrying on success", async () => {
    let calls = 0;
    const result = await withNetworkRetry(async () => {
      calls++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(calls).toBe(1);
  });

  test("retries a transient NetworkError, then returns", async () => {
    let calls = 0;
    const result = await withNetworkRetry(async () => {
      calls++;
      if (calls < 3) {
        throw networkError();
      }
      return calls;
    });
    expect(result).toBe(3);
    expect(calls).toBe(3);
  });

  test("propagates a non-NetworkError immediately (no retry)", async () => {
    let calls = 0;
    await expect(
      withNetworkRetry(async () => {
        calls++;
        throw new BaerlyError("WriteConflict", "someone else won the slot");
      }),
    ).rejects.toMatchObject({ code: "WriteConflict" });
    expect(calls).toBe(1);
  });

  test("propagates a plain assertion error immediately (no retry)", async () => {
    let calls = 0;
    await expect(
      withNetworkRetry(async () => {
        calls++;
        throw new Error("parity mismatch");
      }),
    ).rejects.toThrow("parity mismatch");
    expect(calls).toBe(1);
  });

  test("gives up after MAX_NETWORK_RETRIES and throws the last NetworkError", async () => {
    let calls = 0;
    const { waits, sleep } = recordingSleep();
    await expect(
      withNetworkRetry(
        async () => {
          calls++;
          throw networkError();
        },
        { sleep },
      ),
    ).rejects.toMatchObject({ code: "NetworkError" });
    // One initial attempt + MAX_NETWORK_RETRIES retries.
    expect(calls).toBe(MAX_NETWORK_RETRIES + 1);
    // Linear backoff, one wait per retry.
    expect(waits).toEqual(
      Array.from({ length: MAX_NETWORK_RETRIES }, (_, i) => NETWORK_RETRY_BASE_MS * (i + 1)),
    );
  });

  test("the backoff spans many 100 ms Toxiproxy ticks", () => {
    const span = (NETWORK_RETRY_BASE_MS * MAX_NETWORK_RETRIES * (MAX_NETWORK_RETRIES + 1)) / 2;
    expect(span).toBeGreaterThanOrEqual(2_000);
  });

  test("retryOn widens the predicate to unacknowledged commits", async () => {
    let calls = 0;
    const { sleep } = recordingSleep();
    const result = await withNetworkRetry(
      async () => {
        calls++;
        if (calls === 1) {
          throw new BaerlyError("AmbiguousCommit", "fate unknown");
        }
        return calls;
      },
      { retryOn: isUnacknowledgedCommitError, sleep },
    );
    expect(result).toBe(2);
  });
});
