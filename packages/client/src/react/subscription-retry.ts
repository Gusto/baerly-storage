import { BaerlyError } from "@baerly/protocol";
import { MAINTENANCE_PENDING_CLIENT_MAX_WAIT_MILLIS } from "../request-retry.ts";

/**
 * Initial upper bound, in milliseconds, for the React client's
 * `/v1/since` retry delay. Equal jitter selects a delay from half this
 * value through this value, then the bound doubles after each
 * consecutive retriable failure.
 *
 * Client-side retry tuning, not a wire-protocol value, so it lives
 * here rather than in `@baerly/protocol`'s `constants.ts` — putting it
 * there would both widen the shared barrel that server, adapters, cli,
 * and dev all import for a single React-only consumer, and hand the
 * client that module's unrelated runtime closure.
 *
 * @see ./subscription-pool.ts
 */
export const SUBSCRIPTION_RETRY_INITIAL_MILLIS: number = 250;

/**
 * Maximum upper bound, in milliseconds, for the React client's
 * `/v1/since` retry delay. The equal-jitter calculation never returns
 * a delay above this cap.
 *
 * @see ./subscription-pool.ts
 */
export const SUBSCRIPTION_RETRY_MAX_MILLIS: number = 10_000;

/**
 * Equal-jitter backoff delay for the `attempt`-th consecutive
 * retriable `/v1/since` failure, counting from zero.
 *
 * The upper bound doubles per attempt from
 * {@link SUBSCRIPTION_RETRY_INITIAL_MILLIS} and saturates at
 * {@link SUBSCRIPTION_RETRY_MAX_MILLIS}; the returned delay is drawn
 * uniformly from the top half of that bound. Half the bound is fixed
 * so a wedged table still backs off monotonically, and half is random
 * so a fleet of clients that lost the same server does not re-converge
 * into a synchronised retry wave.
 */
export const retryDelay = (attempt: number): number => {
  const upperBound = Math.min(
    SUBSCRIPTION_RETRY_MAX_MILLIS,
    SUBSCRIPTION_RETRY_INITIAL_MILLIS * 2 ** attempt,
  );
  return Math.floor(upperBound / 2 + Math.random() * (upperBound / 2));
};

/**
 * The wait, in milliseconds, before re-polling after `error` on the
 * `attempt`-th consecutive retriable failure: {@link retryDelay}, or the
 * server's hint when `error` is `MaintenancePending` and asks for longer.
 * The hint (`error.retryAfter`, which already folds in the `Retry-After`
 * header) is clamped to `MAINTENANCE_PENDING_CLIENT_MAX_WAIT_MILLIS`: the
 * poll never gives up, so a hostile hint must not park it.
 */
export const pollRetryDelay = (attempt: number, error: unknown): number => {
  const backoff = retryDelay(attempt);
  if (
    !(error instanceof BaerlyError) ||
    error.code !== "MaintenancePending" ||
    error.retryAfter === undefined
  ) {
    return backoff;
  }
  return Math.max(
    backoff,
    Math.min(error.retryAfter * 1000, MAINTENANCE_PENDING_CLIENT_MAX_WAIT_MILLIS),
  );
};
