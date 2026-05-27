/**
 * Storage wrapper that lets a test plant arbitrary entries at arbitrary
 * keys via `scriptForgedEntry`, without going through the writer's PUT
 * path. The forged bytes are returned by subsequent GETs of that key,
 * letting the test simulate an adversary that has bucket-write access
 * but cannot read writer RAM (and therefore cannot observe the
 * per-commit session id).
 *
 * Used by `tests/integration/log-conflict-forgery.test.ts` to verify
 * that `tryAdoptOwnSessionLogEntry` never returns `adopt: true` on a
 * forged entry, regardless of how the adversary crafts the body.
 *
 * Surface:
 *   - `wrapForgeryStorage(inner)` → `{ storage, scriptForgedEntry,
 *     unscriptForgedEntry, clearForgeries }`.
 *   - `scriptForgedEntry(key, body)` plants forged bytes that will
 *     be returned by subsequent `storage.get(key)` calls, shadowing
 *     whatever the inner backend holds.
 *   - All other methods (`put`, `delete`, `list`) delegate to the
 *     inner storage unchanged — the adversary's surface here is
 *     specifically the GET-intercept (which models a bucket-write
 *     adversary who has ALSO replaced the read path, e.g. via a
 *     compromised CDN edge or DNS hijack).
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
  /** Remove a previously scripted forgery for `key`. */
  unscriptForgedEntry(key: string): void;
  /** Clear all scripted forgeries. */
  clearForgeries(): void;
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
    unscriptForgedEntry(key) {
      forged.delete(key);
    },
    clearForgeries() {
      forged.clear();
    },
  };
}
