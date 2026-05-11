import type { LogEntry, MPS3ErrorCode } from "@baerly/protocol";

/**
 * Wire envelope for every error response. Mirrors `MPS3Error` so
 * the Phase 8 client SDK reconstructs the same class shape it
 * would see in-process. `code` is the discriminant; `cause` is
 * never sent on the wire.
 */
export interface HttpErrorEnvelope {
  readonly error: {
    readonly code: MPS3ErrorCode;
    readonly message: string;
  };
}

/** Successful single-doc / single-result wrapper. */
export interface HttpOkEnvelope<T> {
  readonly data: T;
}

/**
 * Long-poll response. `events` is the slice of `LogEntry`s between
 * the request's `cursor` and `next_cursor`. Client passes
 * `next_cursor` back on the next call. Empty `events` + same
 * `next_cursor` means "nothing changed within the budget"
 * (Phase 6 default budget: ~25s).
 */
export interface SinceResponse {
  readonly events: ReadonlyArray<LogEntry>;
  readonly next_cursor: string;
}

/**
 * URL contract. Path segments are typed as template literals so
 * the Phase 6 router gets compile-time route-table checks. The
 * `tenant` derives from the `Verifier`'s output, not the URL —
 * URLs carry `app` / `table` / `id` only.
 */
export type Routes =
  /** Read one document. → `HttpOkEnvelope<JSONArraylessObject>` | 404. */
  | { method: "GET"; path: `/v1/t/${string}/${string}` }
  /** List rows matching a predicate (in query string). */
  | { method: "GET"; path: `/v1/t/${string}` }
  /** Insert. Body: `{ doc: JSONArraylessObject }`. */
  | { method: "POST"; path: `/v1/t/${string}` }
  /** JSON-merge-patch. Body: `{ patch: JSONArraylessObject }`. */
  | { method: "PATCH"; path: `/v1/t/${string}/${string}` }
  /** Delete row by id. */
  | { method: "DELETE"; path: `/v1/t/${string}/${string}` }
  /** Long-poll log. Query: `?cursor=<opaque>`. Response: `SinceResponse`. */
  | { method: "GET"; path: `/v1/since` };

/**
 * Status-code policy. Listed here so the client SDK and the
 * conformance suite share one source of truth.
 *
 * | Status | Meaning                                                          |
 * |--------|------------------------------------------------------------------|
 * | 200    | Success — `HttpOkEnvelope<T>` or `SinceResponse`.                |
 * | 201    | `POST` insert success — body `{ _id }`.                          |
 * | 204    | `DELETE` success — no body.                                      |
 * | 304    | Long-poll: nothing changed; `next_cursor` unchanged.             |
 * | 400    | Body parse failed → `HttpErrorEnvelope` `code:"SchemaError"`.    |
 * | 401    | `Verifier` returned null → `code:"Unauthorized"`.                |
 * | 403    | Auth ok but tenant prefix denied → `code:"AccessDenied"`.        |
 * | 404    | Doc not found. NOT used for "tenant unknown" (→ 401).            |
 * | 409    | CAS lost → `code:"Conflict"`.                                    |
 * | 500    | Anything else → `code:"Internal"`.                               |
 */
export type HttpStatus = 200 | 201 | 204 | 304 | 400 | 401 | 403 | 404 | 409 | 500;
