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
   * Other failure modes throw `MPS3Error`.
   */
  get(
    key: string,
    opts?: { ifNoneMatch?: string; signal?: AbortSignal },
  ): Promise<StorageGetResult | null>;

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

export interface StorageGetResult {
  readonly body: Uint8Array;
  readonly etag: string;
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
}
