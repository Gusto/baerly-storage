/**
 * Discriminator for {@link MPS3Error}. Strings (not subclasses) so they
 * survive cross-realm boundaries (e.g. a Web Worker) and so callers can
 * pattern-match with grep-friendly equality.
 */
export type MPS3ErrorCode =
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
    | "Internal";

/**
 * The single error class thrown by MPS3. Discriminate by `code`, not
 * `instanceof`:
 *
 * @example
 * ```ts
 * try {
 *   await mps3.get("k");
 * } catch (err) {
 *   if (err instanceof MPS3Error && err.code === "OfflineNoCache") {
 *     // ... handle offline
 *   }
 *   throw err;
 * }
 * ```
 */
export class MPS3Error extends Error {
    constructor(
        public readonly code: MPS3ErrorCode,
        message: string,
        public override readonly cause?: unknown,
    ) {
        super(message);
        this.name = "MPS3Error";
    }
}
