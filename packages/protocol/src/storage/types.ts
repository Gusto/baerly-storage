/**
 * Object-storage abstraction. The protocol kernel writes through
 * this and only this. Implementations: in-memory (testing), S3 HTTP
 * (production), R2 binding (deferred), local-fs (deferred).
 *
 * Cancellation: every method accepts an optional AbortSignal.
 * Implementations should respect it where feasible; consumers may
 * ignore it. We thread it through from the start so we don't have
 * to retrofit cancellation later.
 *
 * Encoding: bodies are `Uint8Array` (works in Workers + Node 24+),
 * not `Buffer`. Result types are `readonly` — the kernel doesn't
 * mutate what storage returns.
 *
 * Not-found is signalled by `null` (single discriminator), not by
 * throwing. Other failure modes throw `MPS3Error`.
 */
export interface Storage {
  /**
   * Fetch a single object. Returns `null` on not-found (404
   * semantics). With `ifNoneMatch`, returns `null` if the current
   * ETag matches (304 semantics — caller's cached copy is current).
   * With `versionId`, fetches a specific historical version (only
   * meaningful on a versioned S3 bucket; non-versioning impls may
   * ignore). Other failure modes throw `MPS3Error`.
   */
  get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null>;

  /**
   * Write a single object. Returns the new ETag and, when the
   * underlying transport surfaces it, the server's response time
   * as `serverDate` (S3's `Date` header). The kernel uses
   * `serverDate` to track adaptive clock-skew; impls may return
   * `undefined` if no server clock is available. Use `ifMatch` for
   * compare-and-swap (write only if the current ETag matches), or
   * `ifNoneMatch: "*"` for create-only (write only if no object
   * exists). Conflicts throw `MPS3Error` with HTTP 412 semantics.
   */
  put(
    key: string,
    body: Uint8Array,
    opts?: StoragePutOptions,
  ): Promise<StoragePutResult>;

  /**
   * Delete a single object. Idempotent: deleting a missing key is
   * not an error.
   */
  delete(key: string, opts?: { signal?: AbortSignal }): Promise<void>;

  /**
   * Lex-asc enumeration of keys with the given prefix. Pagination is
   * implementation-internal; consumers iterate until exhaustion or
   * `maxKeys`. `startAfter` (exclusive) is a strict-greater cursor.
   */
  list(
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry>;
}

export interface StorageGetOptions {
  readonly ifNoneMatch?: string;
  /**
   * Pin to a specific historical version. Maps to S3's
   * `?versionId=…` query parameter on versioned buckets. Impls that
   * don't model versions may ignore.
   */
  readonly versionId?: string;
  readonly signal?: AbortSignal;
}

export interface StorageGetResult {
  readonly body: Uint8Array;
  readonly etag: string;
  /**
   * S3 `x-amz-version-id` of the returned object on versioned
   * buckets; `undefined` for unversioned reads or impls without
   * native versioning.
   */
  readonly versionId?: string;
}

export interface StoragePutResult {
  readonly etag: string;
  /**
   * Server-reported response time, used by the kernel's adaptive
   * clock-skew loop. Set by HTTP-backed impls from the response
   * `Date` header; in-memory impls fill in the local wall clock.
   * `undefined` if no clock signal is available.
   */
  readonly serverDate?: Date;
  /**
   * S3 `x-amz-version-id` of the new object version on versioned
   * buckets; `undefined` for unversioned writes or impls without
   * native versioning.
   */
  readonly versionId?: string;
}

export interface StoragePutOptions {
  /** CAS guard: write only if ETag matches. */
  readonly ifMatch?: string;
  /** Create-only guard: write only if no object exists. */
  readonly ifNoneMatch?: "*";
  readonly contentType?: string;
  /** Cancel mid-flight; impls should respect when feasible. */
  readonly signal?: AbortSignal;
}

export interface StorageListEntry {
  readonly key: string;
  readonly etag: string;
  /**
   * Server's `Last-Modified` for the listed object. The kernel's
   * manifest validity check uses this to reject writes whose
   * embedded base32 timestamp disagrees with the server's clock by
   * more than `LAG_WINDOW_MILLIS` (defends against clock-skewed or
   * adversarial writers). Impls without a server clock may return
   * `undefined` and the kernel skips the cross-check.
   */
  readonly lastModified?: Date;
}
