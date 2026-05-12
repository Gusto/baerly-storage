import { TIMESTAMP_BIT_WIDTH } from "./constants";
import { uint2strDesc } from "./types";

/**
 * Minimal subset of the host config that {@link adjustClock} needs.
 * Kept local to avoid a layering violation: the protocol package must
 * not depend on the higher-level `Baerly` config shape. The host's
 * `ResolvedBaerlyConfig` is structurally compatible.
 */
interface AdaptiveClockConfig {
  adaptiveClock: boolean;
  clockOffset: number;
  log: (...args: unknown[]) => void;
}

export const timestamp = (epoch: number = 0) => uint2strDesc(epoch, TIMESTAMP_BIT_WIDTH);

/**
 * Converts timestamps like LastModified to their seconds since UTC epoch
 */
export const dateToSecs = (dateTimestamp: string): number => {
  return Math.floor(new Date(dateTimestamp).getTime() / 1000);
};

export const measure = async <Result>(work: Promise<Result>): Promise<[Result, number]> => {
  const start = Date.now();
  return [await work, Date.now() - start];
};

export const adjustClock = (
  responsePromise: Promise<Response>,
  config: AdaptiveClockConfig,
): Promise<Response> => {
  if (config.adaptiveClock) {
    return measure(responsePromise).then(([response, latency]) => {
      if (response.status !== 200) return response;
      const date_str = response.headers.get("date");
      if (date_str) {
        let error = 0;
        const server_time = new Date(date_str).getTime();
        const local_time = Date.now() + config.clockOffset;

        if (local_time < server_time - latency) {
          error = server_time - local_time - latency;
        } else if (local_time > server_time + 1000 + latency) {
          error = server_time + 1000 - local_time + latency;
        }

        if (error > 0)
          // Only allow positive clock adjustments for now
          config.clockOffset = config.clockOffset + error;

        if (error > 0) {
          config.log(
            "latency",
            latency,
            "error",
            error,
            "local_time",
            local_time,
            "server_time",
            server_time,
            "config.clockOffset",
            config.clockOffset,
          );
        }
      }
      return response;
    });
  }
  return responsePromise;
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
