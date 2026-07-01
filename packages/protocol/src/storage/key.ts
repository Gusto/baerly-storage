import { BaerlyError } from "../errors.ts";

/**
 * Validate a raw {@link Storage} object key against the portable baerly key
 * grammar before it is used to address an object. A key MUST be non-empty
 * and `/`-delimited, with **no path segment equal to `.` or `..`**.
 *
 * The dot-segment rule is not a vendor quirk — it is a *client-side*
 * universal: RFC 3986 §5.2.4 "remove dot segments" is mandatory for every
 * conformant URL parser, so `<endpoint>/<bucket>/.` normalizes to
 * `<endpoint>/<bucket>/` and `<endpoint>/<bucket>/..` escapes the bucket
 * entirely — *before* the request is signed or sent, in TypeScript, Go,
 * Rust, Python, or any language a `Storage` port is written in. Such a key
 * cannot be addressed over the S3/R2 HTTP API regardless of backend; a bare
 * `.` PUT surfaces as a confusing bucket-root 403 rather than a clear
 * rejection. The kernel never emits such keys (caller-controlled segments
 * are already screened by `assertPathSegment` one layer up), so this is the
 * boundary guard that makes every adapter reject them *identically* and
 * gives ports a single, testable contract.
 *
 * Thrown as `BaerlyError{code:"InvalidConfig"}` to match the sibling
 * key/segment guards (`assertKeyWithinLimit`, `assertPathSegment`). The
 * full-key 1024-byte ceiling is enforced separately on the write path
 * (`assertKeyWithinLimit`), where multi-segment keys are assembled.
 *
 * @see docs/spec/storage-compatibility.md — "Key namespace"
 */
export function assertValidStorageKey(key: string): void {
  if (key.length === 0) {
    throw new BaerlyError("InvalidConfig", "storage key must be a non-empty string");
  }
  for (const segment of key.split("/")) {
    if (segment === "." || segment === "..") {
      throw new BaerlyError(
        "InvalidConfig",
        `storage key may not contain a "." or ".." path segment — RFC 3986 dot-segment ` +
          `removal makes it unaddressable over the S3/R2 HTTP API: ${JSON.stringify(key)}`,
      );
    }
  }
}
