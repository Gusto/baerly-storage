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
