import { TIMESTAMP_BIT_WIDTH } from "./constants.ts";
import { BaerlyError } from "./errors.ts";
import { uint2strDesc } from "./types.ts";

/**
 * Encode an epoch-millis instant as a lexicographically-DEScending
 * base-32 key (newer sorts first). The load-bearing LSN ordering
 * primitive — see {@link uint2strDesc}.
 *
 * `epoch` is REQUIRED and validated. There is no default: an argless
 * call used to encode `0`, which descending-sorts as the most-ancient
 * instant and would silently invert ordering. A non-finite, negative,
 * or out-of-range `epoch` (e.g. a broken `Date.now()` returning `NaN`)
 * would corrupt the key silently rather than fail loud, so it throws
 * `Internal` instead — this is an invariant violation, not caller config
 * (the only legitimate argument is `Date.now()`).
 */
export const timestamp = (epoch: number): string => {
  if (!Number.isInteger(epoch) || epoch < 0 || epoch >= 2 ** TIMESTAMP_BIT_WIDTH) {
    throw new BaerlyError(
      "Internal",
      `timestamp(): epoch must be a non-negative integer < 2^${TIMESTAMP_BIT_WIDTH} (got ${epoch})`,
    );
  }
  return uint2strDesc(epoch, TIMESTAMP_BIT_WIDTH);
};

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
