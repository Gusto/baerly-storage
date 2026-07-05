import {
  CODE_RESOLUTIONS,
  isRetriableCode,
  type LogEntry,
  type BaerlyErrorCode,
} from "@baerly/protocol";

/**
 * Wire envelope for every error response. Mirrors `BaerlyError` so
 * the client SDK reconstructs the same class shape it would see
 * in-process. `code` is the discriminant; `cause` is never sent on
 * the wire. `message` follows the HTTP message policy: caller-facing
 * errors carry actionable detail, predicate `InvalidConfig` keeps its
 * request-fix guidance, and storage/server diagnostics use generic text
 * so bucket keys, layout, ETags, and upstream response bodies stay
 * server-side.
 */
export interface HttpErrorEnvelope {
  readonly error: {
    readonly code: BaerlyErrorCode;
    readonly message: string;
    /** Whether this error instance is retriable. Always present; defaults from `code`, with throw-site overrides. Additive. */
    readonly retriable: boolean;
    /**
     * Field-path issues, present only when `code === "SchemaError"`.
     * Each entry is `{ path, message }` where `path` is the dotted
     * key list from the validator. Older clients see this field as
     * `unknown` and ignore it; new clients destructure it for form-
     * side rendering.
     */
    readonly issues?: ReadonlyArray<{
      readonly path: ReadonlyArray<string | number>;
      readonly message: string;
    }>;
    /** Human-readable remediation hint. Present when the code has a per-code default or a site override; absent for opaque/transient codes. */
    readonly resolution?: string;
  };
}

/**
 * Single drift surface for the {@link HttpErrorEnvelope} shape. The
 * router and both adapters call this — adding or renaming a field on
 * the wire is a one-edit change here. `retriable` is additive (always
 * present, defaulted from `code`); older clients ignore it.
 */
export const errorEnvelope = (
  code: BaerlyErrorCode,
  message: string,
  issues?: ReadonlyArray<{ path: ReadonlyArray<string | number>; message: string }>,
  resolution?: string,
  retriable?: boolean,
): HttpErrorEnvelope => {
  const resolved = resolution ?? CODE_RESOLUTIONS[code];
  return {
    error: {
      code,
      message,
      retriable: retriable ?? isRetriableCode(code),
      ...(issues !== undefined && issues.length > 0 ? { issues } : {}),
      ...(resolved !== undefined ? { resolution: resolved } : {}),
    },
  };
};

/**
 * Metadata embedded in every successful read response.
 *
 * - `manifest_pointer` is an opaque-to-the-consumer string cursor
 *   identifying the `current.json` generation this read folded over.
 *   It is a digest of manifest state, not a bucket key; treat it as
 *   opaque on the wire.
 * - `fresh` is `true` iff this read advanced the locally-cached
 *   pointer (cold path); `false` iff it served from the cached view
 *   (cached pointer was unchanged).
 */
interface HttpOkMeta {
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
 * Status-code policy. Listed here so the client SDK and the
 * conformance suite share one source of truth.
 *
 * | Status | Meaning                                                          |
 * |--------|------------------------------------------------------------------|
 * | 200    | `GET` read → `HttpOkEnvelope<T>`. `GET /v1/since` → `SinceResponse`. `PATCH` → `{ modified: number }`. |
 * | 201    | `POST` insert success — body `{ _id }`.                          |
 * | 204    | `DELETE` success — no body.                                      |
 * | 304    | Reserved. Long-poll idleness ships as 200 + empty events.        |
 * | 400    | Caller request failed → `SchemaError` / `InvalidConfig` / `UnsatisfiablePredicate`. Predicate `InvalidConfig` guidance is public; server/storage config detail is scrubbed. |
 * | 401    | `Verifier` returned null → `code:"Unauthorized"`, `message: "Missing or invalid Authorization header"`. |
 * | 403    | Auth ok but tenant prefix denied → `code:"AccessDenied"`.        |
 * | 404    | Doc not found → `code:"NotFound"`. NOT used for "tenant unknown" (→ 401). |
 * | 409    | Write conflict → `code:"Conflict"` (`retriable` says whether to retry). Non-retriable caller conflicts keep their message; retriable CAS/storage conflicts are scrubbed. |
 * | 413    | Request body exceeded `MAX_BODY_BYTES` → `code:"PayloadTooLarge"`. |
 * | 502    | Storage/network upstream failed → `code:"NetworkError"` / `code:"InvalidResponse"` with a generic message. |
 * | 500    | Anything else → `code:"Internal"` with a generic message.         |
 */
export type HttpStatus = 200 | 201 | 204 | 304 | 400 | 401 | 403 | 404 | 409 | 413 | 500 | 502;
