import {
  MPS3Error,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";

/**
 * `Storage` impl used when `MPS3` is constructed with `online: false`.
 * Every method throws `MPS3Error("OfflineNoCache")`. Callers that hit
 * the cache layer first never reach here; callers that miss the cache
 * see a clean failure instead of a hung promise (the legacy
 * `() => new Promise(() => {})` deadlock-fetchFn pattern).
 */
export class OfflineStorage implements Storage {
  async get(key: string, _opts?: StorageGetOptions): Promise<StorageGetResult | null> {
    throw new MPS3Error("OfflineNoCache", `Offline; cannot GET ${key}`);
  }

  async put(
    key: string,
    _body: Uint8Array,
    _opts?: StoragePutOptions,
  ): Promise<StoragePutResult> {
    throw new MPS3Error("OfflineNoCache", `Offline; cannot PUT ${key}`);
  }

  async delete(key: string, _opts?: { signal?: AbortSignal }): Promise<void> {
    throw new MPS3Error("OfflineNoCache", `Offline; cannot DELETE ${key}`);
  }

  // eslint-disable-next-line require-yield
  async *list(
    prefix: string,
    _opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry> {
    throw new MPS3Error("OfflineNoCache", `Offline; cannot LIST ${prefix}`);
  }
}
