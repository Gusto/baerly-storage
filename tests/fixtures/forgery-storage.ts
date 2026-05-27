/**
 * Storage wrapper that models a bucket-write adversary who has ALSO
 * compromised the read path (e.g. via a CDN edge or DNS hijack), but
 * cannot read the writer's local RAM — and therefore cannot observe
 * the per-commit session id minted inside `Writer.commit`.
 *
 * `scriptForgedEntry(key, body)` plants forged bytes at `key`;
 * subsequent `storage.get(key)` calls return those bytes,
 * shadowing the inner backend. All other methods delegate.
 *
 * Used by `tests/integration/log-conflict-forgery.test.ts` to verify
 * that `tryAdoptOwnSessionLogEntry` never returns `adopt: true` on a
 * forged entry, regardless of how the adversary crafts the body.
 *
 * Not thread-safe; tests should not share an instance across
 * concurrent workers.
 */

import type {
  Storage,
  StorageGetOptions,
  StorageGetResult,
  StorageListEntry,
  StoragePutOptions,
  StoragePutResult,
} from "@baerly/protocol";

export interface ForgeryStorage {
  readonly storage: Storage;
  /**
   * Plant `body` at `key`. Subsequent `storage.get(key)` calls
   * return `{ body, etag: "forged" }` instead of whatever the
   * inner backend would have produced. Multiple calls overwrite.
   */
  scriptForgedEntry(key: string, body: Uint8Array): void;
}

export function wrapForgeryStorage(inner: Storage): ForgeryStorage {
  const forged = new Map<string, Uint8Array>();
  const storage: Storage = {
    get: async (key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> => {
      const planted = forged.get(key);
      if (planted !== undefined) {
        // Adversary intercepts the read. `etag: "forged"` is a
        // sentinel — the adoption decision never inspects ETags;
        // the inner-vs-planted distinction is invisible to the
        // writer. (The writer DOES use ETags on `current.json` for
        // CAS, but we don't forge that key in any test that
        // depends on a specific etag value.)
        return { body: planted, etag: "forged" };
      }
      return inner.get(key, opts);
    },
    put: (key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> =>
      inner.put(key, body, opts),
    delete: (key: string, opts?: { signal?: AbortSignal }): Promise<void> =>
      inner.delete(key, opts),
    list: (
      prefix: string,
      opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
    ): AsyncIterable<StorageListEntry> => inner.list(prefix, opts),
  };
  return {
    storage,
    scriptForgedEntry(key, body) {
      forged.set(key, body);
    },
  };
}
