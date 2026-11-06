/**
 * Total attempts (first try included) the client makes for one GET
 * before surfacing the last failure. Matches the 3-attempt cap the
 * storage adapters use (`STORAGE_RETRY_MAX_ATTEMPTS` in
 * `@baerly/protocol`; AWS SDK standard mode and the Google SRE book
 * both cap at 3). Client-side retry tuning, not a wire-protocol value,
 * so it lives here rather than in `@baerly/protocol`'s `constants.ts`
 * (same reasoning as `subscription-retry.ts`).
 *
 * @see ./request.ts
 */
export const REQUEST_RETRY_MAX_ATTEMPTS: number = 3;

/**
 * Full-jitter backoff base, in milliseconds: retry `n` (0-based) waits
 * `random() * min(REQUEST_RETRY_MAX_DELAY_MILLIS, base * 2^n)`. Larger
 * than the storage adapters' 50 ms transient base because the failure
 * here came from a proxy or the network in front of the server, where
 * an early resend mostly adds load to something already struggling.
 */
export const REQUEST_RETRY_BASE_MILLIS: number = 250;

/**
 * Upper bound, in milliseconds, on one jittered backoff, and the
 * ceiling on a server `Retry-After` the client will wait out. A hint
 * above it is not honoured by clamping (the retry would arrive early
 * and likely fail again); the GET fails as it would without retry, so
 * a hostile or misconfigured proxy cannot park a caller.
 */
export const REQUEST_RETRY_MAX_DELAY_MILLIS: number = 10_000;

/**
 * Total attempts (first try included) the client makes for one request
 * answered with an enveloped `MaintenancePending` before it surfaces that
 * error (main-7 slice 3, S6b), on every verb. Every refused write has
 * already dispatched one bounded fold, so the third attempt lands behind
 * two fold passes; a backlog that needs more keeps draining on the
 * caller's later writes. The same 3-attempt cap as
 * {@link REQUEST_RETRY_MAX_ATTEMPTS} and `STORAGE_RETRY_MAX_ATTEMPTS`, so
 * the client has one retry budget, not one per failure class.
 *
 * Lives here rather than in `@baerly/protocol`'s `constants.ts`, like the
 * values above: importing that module adds its whole chunk (~17 KB raw,
 * ~0.7 KB min-gz) to the browser client for two numbers. The server's
 * hint is `MAINTENANCE_PENDING_RETRY_AFTER_SECONDS` there.
 */
export const MAINTENANCE_PENDING_CLIENT_MAX_ATTEMPTS: number = 3;

/**
 * Longest wait, in milliseconds, the client honours for one
 * `MaintenancePending` retry hint (`Retry-After`, or `error.retryAfter`).
 * As with {@link REQUEST_RETRY_MAX_DELAY_MILLIS}, a larger hint ends the
 * retries rather than being clamped, so a hostile or misconfigured server
 * cannot park a caller. The React subscription pool, which never gives
 * up, clamps its wait to this instead.
 */
export const MAINTENANCE_PENDING_CLIENT_MAX_WAIT_MILLIS: number = 10_000;

/**
 * Parse a `Retry-After` header (RFC 9110 §10.2.3: delta-seconds or an
 * HTTP-date) into milliseconds to wait. `undefined` when absent or
 * unparseable; a past date or `0` is `0`.
 */
export const parseRetryAfterMillis = (
  value: string | null,
  now: number = Date.now(),
): number | undefined => {
  const text = value?.trim();
  if (text === undefined || text === "") {
    return undefined;
  }
  if (/^\d+$/.test(text)) {
    return Number(text) * 1000;
  }
  // An HTTP-date always names its day and month; `Date.parse` alone
  // would accept junk like "1.5" or "-1" as a year-2001 date.
  const at = /[a-z]/i.test(text) ? Date.parse(text) : Number.NaN;
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
};

/**
 * Sleep `ms`, rejecting with `signal.reason` the moment `signal` aborts.
 * Local rather than `@baerly/protocol`'s `delay`: importing that pulls
 * `time.ts` and its key-encoding closure into the browser client bundle.
 */
export const sleep = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/** Jittered exponential wait before retry `retryIndex` (0-based). */
export const backoffMillis = (retryIndex: number): number =>
  Math.random() *
  Math.min(REQUEST_RETRY_MAX_DELAY_MILLIS, REQUEST_RETRY_BASE_MILLIS * 2 ** retryIndex);
