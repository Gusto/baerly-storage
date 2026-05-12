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
 *   Treat as opaque on the wire.
 * - `fresh` — `true` iff this read advanced the locally-cached
 *   pointer on the server (cold path); `false` iff it served from the
 *   cached view.
 */
export interface HttpOkMeta {
  readonly manifest_pointer: string;
  readonly fresh: boolean;
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
  };
}

/**
 * Long-poll response. `events` is the slice of `LogEntry`s between
 * the request's `cursor` and `next_cursor`. Client passes
 * `next_cursor` back on the next call. Empty `events` + same
 * `next_cursor` means "nothing changed within the budget".
 */
export interface SinceResponse {
  readonly events: ReadonlyArray<LogEntry>;
  readonly next_cursor: string;
}
