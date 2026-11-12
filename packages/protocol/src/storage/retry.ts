import {
  STORAGE_RETRY_MAX_ATTEMPTS,
  STORAGE_RETRY_MAX_DELAY_MILLIS,
  STORAGE_RETRY_THROTTLE_BASE_MILLIS,
  STORAGE_RETRY_TRANSIENT_BASE_MILLIS,
} from "../constants.ts";
import { BaerlyError, isWriteConflict, type BaerlyErrorCode } from "../errors.ts";
import { delay } from "../time.ts";

/**
 * Permanent {@link BaerlyError} codes that end `retryStorageCall` at
 * once. These represent caller- or environment-level faults where
 * retrying cannot succeed: `AccessDenied` (403 — credentials/policy),
 * `InvalidConfig` (bad bucket / unsupported credential type),
 * `InvalidResponse` (server returned unparseable data), and
 * `WriteConflict` (a precondition was rejected). `NetworkError` is
 * intentionally absent — it covers transient transport faults and stays
 * retryable.
 *
 * Storage-layer set, distinct from `RETRIABLE_CODES` in `errors.ts`. A
 * blind re-PUT of the same request re-loses a rejected precondition, so
 * this layer never resends it. `WriteConflict` is still retriable for the
 * logical caller: it re-reads and issues a new request, which is what
 * `retriable` means.
 */
export const PERMANENT_STORAGE_ERROR_CODES: ReadonlySet<BaerlyErrorCode> = new Set<BaerlyErrorCode>(
  ["AccessDenied", "InvalidConfig", "InvalidResponse", "WriteConflict"],
);

/** Options for {@link retryStorageCall}. */
export interface StorageRetryOptions {
  /**
   * Retries after the first attempt: a non-negative integer, else the
   * call rejects with `InvalidConfig` before any attempt. Default
   * `STORAGE_RETRY_MAX_ATTEMPTS - 1`; `0` makes exactly one attempt.
   */
  readonly retries?: number;
  /**
   * Backoff base override in ms, applied to every failure class. Omit
   * for the default policy: `STORAGE_RETRY_TRANSIENT_BASE_MILLIS` after
   * a transient failure, `STORAGE_RETRY_THROTTLE_BASE_MILLIS` after a
   * throttle.
   */
  readonly backoffMs?: number;
  /**
   * Set for an `If-None-Match: "*"` create. An attempt that failed
   * transiently may still have landed, so a later permanent rejection
   * other than `WriteConflict` (for example a 403) cannot prove the
   * create is not durable; it is reported as `NetworkError` carrying the original
   * error as its cause, per the `Storage.put` contract. When every
   * attempt was throttled (`cause.throttled`) or refused
   * (`cause.refused`, which also ends the loop), nothing was applied, so
   * the final `NetworkError`'s cause carries `notApplied: true`.
   */
  readonly conditionalCreate?: boolean;
  /** Jitter source in `[0, 1)`. Test seam; defaults to `Math.random`. */
  readonly random?: () => number;
  /** Backoff sleep. Test seam; defaults to `delay`. */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** `true` when an attempt's rejection proves that attempt was not applied. */
const isThrottled = (e: unknown): boolean =>
  e instanceof BaerlyError && (e.cause as { throttled?: boolean } | undefined)?.throttled === true;

/**
 * `true` when an attempt was refused before it was issued and a resend
 * in the same invocation is refused too (the Workers subrequest limit).
 * Like a throttle it proves the attempt was not applied; unlike one it
 * ends the loop at once.
 */
const isRefused = (e: unknown): boolean =>
  e instanceof BaerlyError && (e.cause as { refused?: boolean } | undefined)?.refused === true;

const retryAfterMillis = (e: unknown): number | undefined => {
  if (!(e instanceof BaerlyError)) {
    return undefined;
  }
  const seconds = (e.cause as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds;
  return seconds === undefined ? undefined : seconds * 1000;
};

/**
 * The wait before retry `retryIndex` (0-based) after `error`.
 *
 * A server `Retry-After` hint (`cause.retryAfterSeconds`) wins, clamped
 * to `STORAGE_RETRY_MAX_DELAY_MILLIS`. Otherwise full jitter:
 * `random() * min(cap, base * 2^retryIndex)`, with the throttle base for
 * an error whose cause carries `throttled: true` and the transient base
 * for everything else, unless `backoffMs` overrides both.
 */
export const storageRetryDelayMillis = (
  error: unknown,
  retryIndex: number,
  opts: Pick<StorageRetryOptions, "backoffMs" | "random"> = {},
): number => {
  const hintMs = retryAfterMillis(error);
  if (hintMs !== undefined) {
    return Math.min(hintMs, STORAGE_RETRY_MAX_DELAY_MILLIS);
  }
  const base =
    opts.backoffMs ??
    (isThrottled(error) ? STORAGE_RETRY_THROTTLE_BASE_MILLIS : STORAGE_RETRY_TRANSIENT_BASE_MILLIS);
  const ceiling = Math.min(STORAGE_RETRY_MAX_DELAY_MILLIS, base * 2 ** retryIndex);
  return (opts.random ?? Math.random)() * ceiling;
};

/**
 * Run one storage request under the single adapter retry policy: at most
 * `retries + 1` attempts (default {@link STORAGE_RETRY_MAX_ATTEMPTS}),
 * one counter for throttles and transient failures alike, full-jitter
 * backoff between attempts (see {@link storageRetryDelayMillis}). A
 * {@link PERMANENT_STORAGE_ERROR_CODES} failure, or an error whose cause
 * carries `refused: true`, ends the loop at once.
 *
 * Every adapter wraps each request — one object call, or one `list`
 * page — in exactly one `retryStorageCall`, so a failing call costs at
 * most `retries + 1` requests. Callers above the `Storage` boundary must
 * not add their own blind resend loop on top.
 */
export const retryStorageCall = async <T>(
  fn: () => Promise<T>,
  opts: StorageRetryOptions = {},
): Promise<T> => {
  const retries = opts.retries ?? STORAGE_RETRY_MAX_ATTEMPTS - 1;
  // A non-integer cap would end the loop between attempts and drop the
  // real error; reject it before any request is sent.
  if (!Number.isSafeInteger(retries) || retries < 0) {
    throw new BaerlyError(
      "InvalidConfig",
      `storage retries must be a non-negative integer, got ${String(retries)}`,
    );
  }
  const sleep = opts.sleep ?? delay;
  // Set once an attempt of a conditional create ends with an unknown outcome.
  let uncertain = false;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof BaerlyError && PERMANENT_STORAGE_ERROR_CODES.has(error.code)) {
        if (opts.conditionalCreate === true && uncertain && !isWriteConflict(error)) {
          throw new BaerlyError(
            "NetworkError",
            `${error.message} (an earlier attempt of this conditional create may have landed)`,
            { cause: error },
          );
        }
        throw error;
      }
      const refused = isRefused(error);
      if (!isThrottled(error) && !refused) {
        uncertain = true;
      }
      // The attempt cap and a refusal end here, through the one final-attempt
      // path, so a create whose every attempt was throttled or refused always
      // reports `notApplied`.
      if (attempt >= retries || refused) {
        if (opts.conditionalCreate === true && !uncertain && error instanceof BaerlyError) {
          throw new BaerlyError(error.code, error.message, {
            cause: {
              ...(error.cause as object),
              notApplied: true,
            },
          });
        }
        throw error;
      }
      await sleep(storageRetryDelayMillis(error, attempt, opts));
    }
  }
  throw new BaerlyError("Internal", "storage retry loop exited without returning or throwing");
};
