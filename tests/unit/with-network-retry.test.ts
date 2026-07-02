import { describe, expect, test } from "vitest";
import { BaerlyError } from "@baerly/protocol";
import { MAX_NETWORK_RETRIES, withNetworkRetry } from "../fixtures/randomized-cascade.ts";

// withNetworkRetry rides out the node-minio Toxiproxy flips the cascade
// runs under. Its branches — retry only on NetworkError, bounded attempts,
// propagate everything else — are load-bearing (an unbounded or
// wrong-predicate retry would hang or mask real failures), so pin them
// deterministically here rather than leaning on the probabilistic cascade.

const networkError = (): BaerlyError => new BaerlyError("NetworkError", "toxiproxy flip");

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
        throw new BaerlyError("Conflict", "someone else won the slot");
      }),
    ).rejects.toMatchObject({ code: "Conflict" });
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
    await expect(
      withNetworkRetry(async () => {
        calls++;
        throw networkError();
      }),
    ).rejects.toMatchObject({ code: "NetworkError" });
    // One initial attempt + MAX_NETWORK_RETRIES retries.
    expect(calls).toBe(MAX_NETWORK_RETRIES + 1);
  });
});
