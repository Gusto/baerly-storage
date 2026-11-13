import { CF_CACHE_API_MAX_CALLS } from "../constants.ts";
import { BaerlyError } from "../errors.ts";

/**
 * A request pool on a {@link RequestLedger}. `internal` is charged for
 * every storage call. `external` is charged as well for a call that
 * leaves through `fetch` or the Cache API (S3 over HTTP, GCS, the Worker
 * read cache). Charging an external call to both pools is safe whether
 * the host keeps one combined counter or two separate ones.
 */
export type RequestPool = "internal" | "external";

/** Per-pool request limits. `Infinity` counts without ever refusing. */
export interface RequestLedgerLimits {
  readonly internal: number;
  readonly external: number;
}

/** Requests charged so far, per pool, plus Cache API calls (also in `external`). */
export interface RequestLedgerCharges {
  readonly internal: number;
  readonly external: number;
  readonly cache: number;
}

/** Limits that count every request and never refuse one (Node, and any host without a per-invocation cap). */
export const UNLIMITED_REQUESTS: RequestLedgerLimits = { internal: Infinity, external: Infinity };

/**
 * Per-invocation storage request budget. The adapter creates one per
 * invocation (an HTTP request, a cron tick) and the server carries it on
 * the observability context, so everything that invocation runs,
 * `ctx.waitUntil` work included, charges the same ledger.
 *
 * `retryStorageCall` charges one request before every attempt, so adapter
 * retries and `list` pages are charged as they are issued. A request that
 * does not fit is refused before it is sent: {@link acquire} throws
 * `CapacityExceeded` whose cause carries `refused: true`, which ends the
 * retry loop at once and keeps `notApplied` on a create. Charging is
 * synchronous, so a `Promise.all` fan-out can never issue past the limit.
 *
 * Calls outside `retryStorageCall` (the verifier's JWKS fetch, GCS
 * signing, app code in the same Worker) are not charged; the limits keep
 * a margin below the platform cap for them.
 */
export class RequestLedger {
  readonly limits: RequestLedgerLimits;
  #internal = 0;
  #external = 0;
  #cache = 0;

  constructor(limits: RequestLedgerLimits = UNLIMITED_REQUESTS) {
    this.limits = limits;
  }

  /** Requests charged so far. */
  get charged(): RequestLedgerCharges {
    return { internal: this.#internal, external: this.#external, cache: this.#cache };
  }

  /** Requests still allowed on `pool`. An external request also needs room in `internal`. */
  remaining(pool: RequestPool): number {
    const internal = this.limits.internal - this.#internal;
    return pool === "internal"
      ? internal
      : Math.min(internal, this.limits.external - this.#external);
  }

  /**
   * Charge one request to `pool`, or refuse it before it is sent.
   *
   * @throws BaerlyError code="CapacityExceeded", cause `{ refused: true }`,
   *   when `pool` has no room. Nothing is charged.
   */
  acquire(pool: RequestPool): void {
    if (this.remaining(pool) < 1) {
      const limit = pool === "internal" ? this.limits.internal : this.limits.external;
      throw new BaerlyError(
        "CapacityExceeded",
        `this request has issued its limit of ${String(limit)} ${pool} storage calls, so the next call was not sent; the work this request needs does not fit in one request on this host`,
        // The HTTP envelope fills in the code's canonical resolution.
        { cause: { refused: true, pool, limit } },
      );
    }
    this.#charge(pool);
  }

  /**
   * Charge one optional Cache API call when it fits: room in `external`
   * and fewer than {@link CF_CACHE_API_MAX_CALLS} cache calls so far.
   * Returns `false`, charging nothing, when it does not; the caller skips
   * the cache call. With `required`, the call is charged whether or not
   * it fits and always returns `true`: a cache invalidation after a write
   * runs inside the limits' margin rather than leave a stale entry.
   */
  chargeCacheCall(required = false): boolean {
    if (!required && (this.#cache >= CF_CACHE_API_MAX_CALLS || this.remaining("external") < 1)) {
      return false;
    }
    this.#cache += 1;
    this.#charge("external");
    return true;
  }

  #charge(pool: RequestPool): void {
    this.#internal += 1;
    if (pool === "external") {
      this.#external += 1;
    }
  }
}

let resolveLedger: () => RequestLedger | undefined = () => undefined;

/**
 * Register how {@link currentRequestLedger} finds the active ledger. The
 * server registers its observability context here, so adapters, which
 * import only this package, charge the ledger of the invocation they run
 * in. One resolver per process; a later call replaces it.
 */
export const setRequestLedgerResolver = (resolver: () => RequestLedger | undefined): void => {
  resolveLedger = resolver;
};

/** The ledger of the active invocation, or `undefined` outside one (nothing is charged). */
export const currentRequestLedger = (): RequestLedger | undefined => resolveLedger();
