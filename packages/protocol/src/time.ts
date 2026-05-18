import { TIMESTAMP_BIT_WIDTH } from "./constants.ts";
import { uint2strDesc } from "./types.ts";

export const timestamp = (epoch: number = 0) => uint2strDesc(epoch, TIMESTAMP_BIT_WIDTH);

/**
 * Delay for `ms` milliseconds, with optional cancellation. If
 * `signal` aborts before the delay elapses, the returned promise
 * rejects with `signal.reason`. Used by `S3HttpStorage`'s retry
 * loop so shutdown can interrupt an in-flight backoff instead of
 * waiting for it to complete.
 */
export const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
