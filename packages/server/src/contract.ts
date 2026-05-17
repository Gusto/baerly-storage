import type { LogEntry, BaerlyErrorCode } from "@baerly/protocol";

/**
 * Wire envelope for every error response. Mirrors `BaerlyError` so
 * the client SDK reconstructs the same class shape it would see
 * in-process. `code` is the discriminant; `cause` is never sent on
 * the wire.
 */
export interface HttpErrorEnvelope {
  readonly error: {
    readonly code: BaerlyErrorCode;
    readonly message: string;
    /**
     * Field-path issues, present only when `code === "SchemaError"`.
     * Each entry is `{ path, message }` where `path` is the dotted
     * key list from the validator. Older clients (pre-ticket-70)
     * see this field as `unknown` and ignore it; new clients
     * destructure it for form-side rendering.
     */
    readonly issues?: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>;
  };
}

/**
 * Single drift surface for the {@link HttpErrorEnvelope} shape. The
 * router and both adapters call this — adding or renaming a field on
 * the wire is a one-edit change here.
 */
export const errorEnvelope = (
  code: BaerlyErrorCode,
  message: string,
  issues?: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>,
): HttpErrorEnvelope => ({
  error: {
    code,
    message,
    ...(issues !== undefined && issues.length > 0 ? { issues } : {}),
  },
});

/**
 * Metadata embedded in every successful read response.
 *
 * - `manifest_pointer` is an opaque-to-the-consumer string cursor
 *   identifying the `current.json` generation this read folded over.
 *   Today's format is `"<snapshot>@<next_seq>"` where `<snapshot>` is
 *   the literal `"none"` when `CurrentJson.snapshot` is `null`. Treat
 *   as opaque on the wire — the shape may change in a future minor
 *   without breaking destructuring consumers.
 * - `fresh` is `true` iff this read advanced the locally-cached
 *   pointer (cold path); `false` iff it served from the cached view
 *   (cached pointer was unchanged).
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

/**
 * Long-poll response. `events` is the slice of `LogEntry`s between
 * the request's `cursor` and `next_cursor`. Client passes
 * `next_cursor` back on the next call. Empty `events` + same
 * `next_cursor` means "nothing changed within the budget"
 * (default budget: ~25s).
 */
export interface SinceResponse {
  readonly events: ReadonlyArray<LogEntry>;
  readonly next_cursor: string;
}

/**
 * URL contract. Path segments are typed as template literals so
 * the router gets compile-time route-table checks. The
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
  /** JSON-merge-patch. Body: `{ patch: JSONArraylessObject }`. Response: `{ modified: number }`. */
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
 * | 200    | `GET` read → `HttpOkEnvelope<T>`. `GET /v1/since` → `SinceResponse`. `PATCH` → `{ modified: number }`. |
 * | 201    | `POST` insert success — body `{ _id }`.                          |
 * | 204    | `DELETE` success — no body.                                      |
 * | 304    | Reserved. Long-poll idleness ships as 200 + empty events.        |
 * | 400    | Body parse failed → `HttpErrorEnvelope` `code:"SchemaError"`.    |
 * | 401    | `Verifier` returned null → `code:"Unauthorized"`.                |
 * | 403    | Auth ok but tenant prefix denied → `code:"AccessDenied"`.        |
 * | 404    | Doc not found → `code:"NotFound"`. NOT used for "tenant unknown" (→ 401). |
 * | 409    | CAS lost → `code:"Conflict"`.                                    |
 * | 413    | Request body exceeded `MAX_BODY_BYTES` → `code:"PayloadTooLarge"`. |
 * | 500    | Anything else → `code:"Internal"`.                               |
 */
export type HttpStatus = 200 | 201 | 204 | 304 | 400 | 401 | 403 | 404 | 409 | 413 | 500;
