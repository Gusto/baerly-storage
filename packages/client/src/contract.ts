/**
 * Wire-shape mirror of the locked HTTP envelopes in
 * `packages/server/src/contract.ts`. The client deliberately does NOT
 * import from `@baerly/server` — pulling in the router would drag the
 * Hono dependency and the in-process `Db` into every browser bundle.
 * Shape parity is verified by the co-located unit test (§3.9).
 */
import type { BaerlyErrorCode, LogEntry } from "@baerly/protocol";

/**
 * Metadata embedded in every successful read response. Mirrors
 * `HttpOkMeta` in `packages/server/src/contract.ts:29-32`.
 *
 * - `manifest_pointer` — opaque-to-the-consumer string cursor
 *   identifying the `current.json` generation this read folded over.
 *   It is a digest of manifest state, not a bucket key. Treat as
 *   opaque on the wire.
 * - `fresh` — `true` iff this read advanced the locally-cached
 *   pointer on the server (cold path); `false` iff it served from the
 *   cached view.
 * - `since_cursor` — the `/v1/since` cursor for the state this read
 *   returned.
 */
interface HttpOkMeta {
  readonly manifest_pointer: string;
  readonly fresh: boolean;
  /**
   * A `/v1/since` cursor positioned exactly after the changes this read
   * folded. Mirrors `HttpOkMeta.since_cursor` in
   * `packages/server/src/contract.ts`. The React subscription pool seeds
   * its poll with it, so a change that commits and folds between the
   * read and the first poll is neither missed nor delivered twice.
   * Opaque: echo it, never parse it. A server that predates it omits it.
   *
   * @example
   * ```ts
   * const env = (await res.json()) as HttpOkEnvelope<Row[]>;
   * const cursor = env._meta.since_cursor ?? ""; // "" against an older server
   * ```
   */
  readonly since_cursor?: string;
}

/** Successful single-doc / single-result wrapper. */
export interface HttpOkEnvelope<T> {
  readonly data: T;
  readonly _meta: HttpOkMeta;
}

/** Wire envelope for every 4xx / 5xx error response. */
export interface HttpErrorEnvelope {
  readonly error: {
    readonly code: BaerlyErrorCode;
    readonly message: string;
    /**
     * Whether retrying can succeed. The server sends it, derived from
     * `code`, for non-SDK consumers; older servers may omit it. The SDK
     * ignores this field and derives `BaerlyError.retriable` from `code`.
     * Mirrors `HttpErrorEnvelope.error.retriable` in
     * `packages/server/src/contract.ts`.
     */
    readonly retriable?: boolean;
    /**
     * Field-path issues, present only when `code === "SchemaError"`.
     * Mirrors the server contract. Older servers omit this field.
     */
    readonly issues?: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>;
    /**
     * Human-readable remediation hint. Mirrors the server contract:
     * present when the code has a per-code default or a site override
     * (e.g. `PayloadTooLarge`, `Unauthorized`, `AccessDenied`, `NotFound`,
     * `WriteConflict`, `AlreadyExists`, `AmbiguousCommit`); absent for
     * opaque/transient codes.
     * Older servers may omit it.
     */
    readonly resolution?: string;
    /**
     * The affected row's `_id`, present only when
     * `code === "AmbiguousCommit"`. Mirrors the server contract. Older
     * servers omit this field.
     */
    readonly _id?: string;
    /**
     * Suggested retry delay in seconds, present only when
     * `code === "MaintenancePending"`. Mirrors the server contract.
     */
    readonly retryAfter?: number;
  };
}

/**
 * Long-poll response. `events` is the slice of `LogEntry`s between
 * the request's `cursor` and `next_cursor`. Client passes
 * `next_cursor` back on the next call, always, even with no events.
 * Empty `events` + same `next_cursor` means "nothing changed within
 * the budget". The first response to `""` may carry empty `events` and
 * a new `next_cursor`: the position after the changes already folded
 * into the collection's snapshot.
 *
 * `next_cursor` is **opaque**: echo it back verbatim, never parse it.
 * `""` means "start from the collection's log floor" and is always
 * valid. It comes back only from a request that ran out of storage
 * calls before reading the collection. A cursor survives the folds
 * that compact the log.
 *
 * A `410 CursorExpired` on resume means the cursor is permanently dead:
 * a change after it is no longer retained (the client fell further
 * behind than the log keeps), or its generation was truncated by
 * `baerly admin restore --force`. Neither clears on
 * retry: re-read, then resume from the re-read's `_meta.since_cursor`
 * (`cursor: ""` against a server that omits it). Retrying the rejected
 * cursor loops forever. Back off before re-bootstrapping so a cursor
 * rejected on every lap cannot become a hot loop. A malformed cursor is
 * `400 SchemaError`.
 */
export interface SinceResponse {
  readonly events: ReadonlyArray<LogEntry>;
  readonly next_cursor: string;
}
