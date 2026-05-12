/**
 * Discriminator for {@link BaerlyError}. Strings (not subclasses) so they
 * survive cross-realm boundaries (e.g. a Web Worker) and so callers can
 * pattern-match with grep-friendly equality.
 */
export type BaerlyErrorCode =
  /** Caller-provided config or input is invalid (bad bucket, unsupported credential type, malformed URL, bucket not version-enabled when versioning was requested). */
  | "InvalidConfig"
  /** Read attempted while `online: false` and the value isn't in any cache. */
  | "OfflineNoCache"
  /** Generic S3/HTTP transport failure (5xx, unexpected status, retries exhausted). */
  | "NetworkError"
  /** S3 returned 403. Either credentials are wrong or the bucket policy denies the operation. */
  | "AccessDenied"
  /** Server returned data that didn't parse (malformed XML, non-JSON body where JSON expected). */
  | "InvalidResponse"
  /** Internal invariant violation — should not be reachable. File a bug. */
  | "Internal"
  /**
   * Document body failed schema validation. Today (Phase 2):
   * emitted by `Db._raw.put` and the table-API write verbs when
   * the body isn't valid JSON or contains an array where
   * `JSONArrayless` is required. Phase 9 wires this to a real
   * validator without changing the wire shape.
   */
  | "SchemaError"
  /**
   * CAS lost on `current.json` (or, for `Query.replace`, the
   * row-cardinality precondition failed). Caller decides whether
   * to retry. Surfaces in Phase 4 / Phase 6.
   */
  | "Conflict"
  /**
   * `Verifier` (Phase 6) returned no identity. HTTP server maps
   * to 401. Code is reserved here so the union locks in Phase 2.
   */
  | "Unauthorized";

/**
 * The single error class thrown by Baerly. Discriminate by `code`, not
 * `instanceof`:
 *
 * @example
 * ```ts
 * try {
 *   await db._raw.get("k");
 * } catch (err) {
 *   if (err instanceof BaerlyError && err.code === "OfflineNoCache") {
 *     // ... handle offline
 *   }
 *   throw err;
 * }
 * ```
 */
export class BaerlyError extends Error {
  readonly code: BaerlyErrorCode;
  override readonly cause?: unknown;

  constructor(code: BaerlyErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = "BaerlyError";
    this.code = code;
    this.cause = cause;
  }
}
