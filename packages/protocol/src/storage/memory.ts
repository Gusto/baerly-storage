import { MPS3Error } from "../errors";
import type {
  Storage,
  StorageGetOptions,
  StorageGetResult,
  StorageListEntry,
  StoragePutOptions,
  StoragePutResult,
} from "./types";

interface StoredObject {
  body: Uint8Array;
  etag: string;
  contentType?: string;
}

/**
 * In-memory `Storage`. The randomized property test runs against
 * this; it must be deterministic — no clocks beyond the caller's,
 * no randomness, no I/O.
 *
 * ETags are a monotonically increasing hex counter formatted in the
 * `"<hex>"` shape S3 returns (the surrounding double-quotes are part
 * of the ETag header value). Keys are stored verbatim.
 */
export class MemoryStorage implements Storage {
  readonly #objects = new Map<string, StoredObject>();
  #etagCounter = 0;

  #nextEtag(): string {
    this.#etagCounter += 1;
    return `"${this.#etagCounter.toString(16)}"`;
  }

  async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    opts?.signal?.throwIfAborted();
    const stored = this.#objects.get(key);
    if (stored === undefined) return null;
    if (opts?.ifNoneMatch !== undefined && opts.ifNoneMatch === stored.etag) {
      // 304 Not Modified — caller's cached copy is current.
      return null;
    }
    return { body: stored.body, etag: stored.etag };
  }

  async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
    opts?.signal?.throwIfAborted();
    const existing = this.#objects.get(key);

    if (opts?.ifNoneMatch === "*" && existing !== undefined) {
      throw new MPS3Error(
        "InvalidResponse",
        `PreconditionFailed: ifNoneMatch="*" but key ${key} already exists`,
      );
    }
    if (opts?.ifMatch !== undefined) {
      if (existing === undefined) {
        throw new MPS3Error(
          "InvalidResponse",
          `PreconditionFailed: ifMatch=${opts.ifMatch} but key ${key} does not exist`,
        );
      }
      if (existing.etag !== opts.ifMatch) {
        throw new MPS3Error(
          "InvalidResponse",
          `PreconditionFailed: ifMatch=${opts.ifMatch} but current ETag is ${existing.etag}`,
        );
      }
    }

    const etag = this.#nextEtag();
    this.#objects.set(key, {
      body,
      etag,
      ...(opts?.contentType !== undefined && { contentType: opts.contentType }),
    });
    // `serverDate` is intentionally returned (callers like the kernel's
    // adaptive-clock loop need a value); `lastModified` is intentionally
    // *not* surfaced on `list()` — the in-memory impl has no
    // independent server clock, and pretending it does would force the
    // kernel's wall-clock cross-check against an artificially injected
    // `clockOffset`, breaking the property-based randomized tests.
    return { etag, serverDate: new Date() };
  }

  async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    opts?.signal?.throwIfAborted();
    this.#objects.delete(key);
  }

  async *list(
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry> {
    opts?.signal?.throwIfAborted();
    const startAfter = opts?.startAfter ?? "";
    const maxKeys = opts?.maxKeys ?? Infinity;
    const sorted = [...this.#objects.keys()]
      .filter((k) => k.startsWith(prefix) && k > startAfter)
      .toSorted();
    let yielded = 0;
    for (const key of sorted) {
      if (yielded >= maxKeys) return;
      opts?.signal?.throwIfAborted();
      const stored = this.#objects.get(key);
      if (stored === undefined) continue; // unreachable; satisfies noUncheckedIndexedAccess
      yield { key, etag: stored.etag };
      yielded += 1;
    }
  }

  /**
   * Test-only: drop all objects.
   * @internal
   */
  _clear(): void {
    this.#objects.clear();
    this.#etagCounter = 0;
  }
}

// Process-singleton MemoryStorage map keyed by bucket. Tests that need
// multiple `Db` / `ServerWriter` instances to see each other's writes
// against an in-memory backend reach for this via
// {@link getOrCreateMemoryStorageForBucket}; {@link resetMemoryStorage}
// drops every bucket between test cases.
const sharedPerBucket = new Map<string, MemoryStorage>();

/**
 * Test isolation: drop every bucket's contents from the shared
 * memory storage used by {@link getOrCreateMemoryStorageForBucket}.
 * Direct `MemoryStorage` instances built via `new MemoryStorage()`
 * are unaffected — those are isolated by construction.
 */
export const resetMemoryStorage = (): void => {
  sharedPerBucket.clear();
};

/**
 * Get the process-singleton {@link MemoryStorage} for the named
 * bucket, creating one on first access. Use this when constructing
 * a `Storage` directly so multiple consumers in the same process
 * see each other's writes for the same bucket name.
 */
export const getOrCreateMemoryStorageForBucket = (bucket: string): MemoryStorage => {
  let s = sharedPerBucket.get(bucket);
  if (s === undefined) {
    s = new MemoryStorage();
    sharedPerBucket.set(bucket, s);
  }
  return s;
};
