import type {
  Storage,
  StorageGetOptions,
  StorageGetResult,
  StoragePutOptions,
  StoragePutResult,
  StorageListEntry,
} from "@baerly/protocol";

/**
 * Wraps a `Storage` instance with per-method op counters.
 *
 * Class A = mutating/enumerating ops in the S3/R2 taxonomy (PUT,
 * DELETE, LIST). Class B (GET, HEAD) is transparent. `classAOps`
 * is a derived sum used by callers that only care about aggregate
 * cost (e.g. the `phase5-end-to-end` idle-reader bound). Callers
 * that need per-verb shape (e.g. "POST should produce exactly 3
 * PUTs and 0 LISTs") read `puts` / `deletes` / `lists` directly.
 *
 * Counters are mutable — `reset()` zeroes them. Not thread-safe;
 * tests should not share an instance across concurrent workers.
 */
export interface CountingStorage {
  readonly storage: Storage;
  readonly puts: number;
  readonly deletes: number;
  readonly lists: number;
  /** Sum of `puts + deletes + lists`. */
  readonly classAOps: number;
  reset(): void;
}

export function wrapCountingStorage(inner: Storage): CountingStorage {
  let puts = 0;
  let deletes = 0;
  let lists = 0;
  const storage: Storage = {
    get: (key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> =>
      inner.get(key, opts),
    put: (key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> => {
      puts++;
      return inner.put(key, body, opts);
    },
    delete: (key: string, opts?: { signal?: AbortSignal }): Promise<void> => {
      deletes++;
      return inner.delete(key, opts);
    },
    list: async function* (
      prefix: string,
      opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
    ): AsyncIterable<StorageListEntry> {
      lists++;
      for await (const entry of inner.list(prefix, opts)) yield entry;
    },
  };
  return {
    storage,
    get puts() {
      return puts;
    },
    get deletes() {
      return deletes;
    },
    get lists() {
      return lists;
    },
    get classAOps() {
      return puts + deletes + lists;
    },
    reset() {
      puts = 0;
      deletes = 0;
      lists = 0;
    },
  };
}
