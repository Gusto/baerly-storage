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
 * DELETE, LIST). Class B GET is counted via `gets`; HEAD is not wrapped. `classAOps`
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
  readonly gets: number;
  /**
   * Operation/subrequest count: `puts + deletes + lists`. Includes DELETE
   * because a `DeleteObject` is still a real CF subrequest against the
   * subrequest budget. Use `billableClassAOps` when measuring cost in dollars.
   */
  readonly classAOps: number;
  /**
   * Billing-correct Class A op count: `puts + lists`. Excludes
   * `DeleteObject`, which is $0 on both R2 and S3 (see
   * docs/about/cost-model.md). Use this for COST measurement; use
   * `classAOps` (which includes DELETE) for CF subrequest-budget
   * measurement, where a DELETE is still a real subrequest.
   */
  readonly billableClassAOps: number;
  reset(): void;
}

export function wrapCountingStorage(inner: Storage): CountingStorage {
  let puts = 0;
  let deletes = 0;
  let lists = 0;
  let gets = 0;
  const storage: Storage = {
    get: (key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> => {
      gets++;
      return inner.get(key, opts);
    },
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
      for await (const entry of inner.list(prefix, opts)) {
        yield entry;
      }
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
    get gets() {
      return gets;
    },
    get classAOps() {
      return puts + deletes + lists;
    },
    get billableClassAOps() {
      return puts + lists;
    },
    reset() {
      puts = 0;
      deletes = 0;
      lists = 0;
      gets = 0;
    },
  };
}
