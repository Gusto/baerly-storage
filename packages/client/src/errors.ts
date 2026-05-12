import type { BaerlyErrorCode } from "@baerly/protocol";

/**
 * Wire-error mirror of `BaerlyError`. The HTTP server emits
 * `HttpErrorEnvelope { error: { code, message } }` on every 4xx /
 * 5xx; the client decodes that into this class.
 *
 * - `code` — the `BaerlyErrorCode` discriminant from the wire envelope.
 * - `status` — the raw HTTP status, kept for diagnostics (e.g. you
 *   may want to distinguish 404-as-"no such row" from 404-as-"route
 *   not found").
 * - `message` — the server's message string, verbatim.
 *
 * The class extends `Error` so it appears in stack traces; the
 * `code` discriminant is what consumers should branch on (not
 * `instanceof BaerlyClientError`, since a future
 * `@baerly/react-query` wrapper may wrap it in a `QueryError`).
 *
 * Mirrors the `BaerlyError` shape in `@baerly/protocol` — same
 * `code` enum, no `cause` (the wire envelope drops `cause`).
 *
 * @example
 * ```ts
 * try {
 *   await client.table("tickets").insert({ title: "hi" });
 * } catch (err) {
 *   if (err instanceof BaerlyClientError && err.code === "Unauthorized") {
 *     // refresh token, retry
 *   }
 *   throw err;
 * }
 * ```
 */
export class BaerlyClientError extends Error {
  readonly code: BaerlyErrorCode;
  readonly status: number;
  constructor(code: BaerlyErrorCode, message: string, status = 0) {
    super(message);
    this.name = "BaerlyClientError";
    this.code = code;
    this.status = status;
  }
}
