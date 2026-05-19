/**
 * In-process cache wrapper over `Storage`, used by the load harness
 * to compare cold / metadata-warm / data-warm / tiny-cache profiles.
 * Sits BETWEEN `Db` and `CountingStorage` so cache hits never reach
 * the wire-counter.
 *
 * Eviction: bounded LRU on a `Map`, leveraging V8's insertion-order
 * guarantee. On hit, `delete(key)` then `set(key, entry)` moves the
 * entry to the most-recently-used end. On overflow, drop
 * `keys().next().value` (the oldest).
 *
 * NOT a runtime `lru-cache` dep — see ticket 53 §D2.
 */

import type {
  Storage,
  StorageGetOptions,
  StorageGetResult,
  StorageListEntry,
  StoragePutOptions,
  StoragePutResult,
} from "@baerly/protocol";

export type ManifestCacheMode = "cold" | "metadata-warm" | "data-warm" | "tiny-cache";

export interface ManifestCacheStats {
  readonly hits: number;
  readonly misses: number;
  /** Hit rate for `current.json` + snapshot keys. */
  readonly manifestHitRate: number;
  /** Hit rate for everything else (only meaningful in data-warm / tiny-cache). */
  readonly snapshotHitRate: number;
}

interface CacheEntry {
  readonly body: Uint8Array;
  readonly etag: string;
}

const CURRENT_JSON_SUFFIX = "/current.json";
const SNAPSHOT_PATH_FRAGMENT = "/snapshots/";

function isManifestKey(key: string): boolean {
  return key.endsWith(CURRENT_JSON_SUFFIX) || key.includes(SNAPSHOT_PATH_FRAGMENT);
}

const TINY_CACHE_ENTRIES = 16;
const DATA_WARM_ENTRIES = 10_000;

export class ManifestCachedStorage implements Storage {
  readonly #inner: Storage;
  readonly #mode: ManifestCacheMode;
  #cache: Map<string, CacheEntry> = new Map();
  #manifestHits = 0;
  #manifestMisses = 0;
  #dataHits = 0;
  #dataMisses = 0;

  constructor(inner: Storage, mode: ManifestCacheMode) {
    this.#inner = inner;
    this.#mode = mode;
  }

  reset(): void {
    this.#cache.clear();
    this.#manifestHits = 0;
    this.#manifestMisses = 0;
    this.#dataHits = 0;
    this.#dataMisses = 0;
  }

  stats(): ManifestCacheStats {
    const manifestTotal = this.#manifestHits + this.#manifestMisses;
    const dataTotal = this.#dataHits + this.#dataMisses;
    return {
      hits: this.#manifestHits + this.#dataHits,
      misses: this.#manifestMisses + this.#dataMisses,
      manifestHitRate: manifestTotal === 0 ? 0 : this.#manifestHits / manifestTotal,
      snapshotHitRate: dataTotal === 0 ? 0 : this.#dataHits / dataTotal,
    };
  }

  async get(key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    const isManifest = isManifestKey(key);
    if (this.#shouldCacheRead(isManifest)) {
      const cached = this.#cache.get(key);
      if (cached !== undefined) {
        if (isManifest) {
          this.#manifestHits++;
        } else {
          this.#dataHits++;
        }
        // Refresh LRU recency.
        this.#cache.delete(key);
        this.#cache.set(key, cached);
        // Honour `If-None-Match`: a matching ETag means the caller
        // already has the body; return null (304 semantics per the
        // `Storage` interface contract — s3-http returns null on 304).
        if (opts?.ifNoneMatch !== undefined && opts.ifNoneMatch === cached.etag) {
          return null;
        }
        return { body: cached.body, etag: cached.etag };
      }
      if (isManifest) {
        this.#manifestMisses++;
      } else {
        this.#dataMisses++;
      }
    }
    const fresh = await this.#inner.get(key, opts);
    if (fresh !== null && this.#shouldCacheRead(isManifest)) {
      this.#admit(key, { body: fresh.body, etag: fresh.etag });
    }
    return fresh;
  }

  async put(key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> {
    // Writes invalidate the cache entry for the same key. Don't try
    // to be clever and update the cache with `body` — the storage
    // adapter may rewrite `etag` (e.g. minio's content-MD5) and a
    // stale entry would tell `Db` the wrong ETag on the next read.
    this.#cache.delete(key);
    return this.#inner.put(key, body, opts);
  }

  async delete(key: string, opts?: { signal?: AbortSignal }): Promise<void> {
    this.#cache.delete(key);
    return this.#inner.delete(key, opts);
  }

  list(
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry> {
    // LIST is not cached. The protocol uses LIST sparingly (snapshot
    // discovery during compaction, GC) and stale LIST results would
    // produce real bugs.
    return this.#inner.list(prefix, opts);
  }

  #shouldCacheRead(isManifest: boolean): boolean {
    switch (this.#mode) {
      case "cold": {
        return false;
      }
      case "metadata-warm": {
        return isManifest;
      }
      case "data-warm":
      case "tiny-cache": {
        return true;
      }
    }
  }

  #admit(key: string, entry: CacheEntry): void {
    const cap = this.#capacity();
    if (cap === 0) {
      return;
    }
    if (this.#cache.has(key)) {
      this.#cache.delete(key);
    }
    this.#cache.set(key, entry);
    // Evict oldest entry when over capacity.
    while (this.#cache.size > cap) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.#cache.delete(oldest);
    }
  }

  #capacity(): number {
    switch (this.#mode) {
      case "cold": {
        return 0;
      }
      case "metadata-warm": {
        // Manifest keys only; in practice ~3-4 per (tenant, table):
        // current.json + the current snapshot + a handful of recent
        // snapshot pointers. 256 is generous for the bench's
        // single-digit-tenants → low-thousand-tenants range.
        return 256;
      }
      case "data-warm": {
        return DATA_WARM_ENTRIES;
      }
      case "tiny-cache": {
        return TINY_CACHE_ENTRIES;
      }
    }
  }
}
