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
 * cost (e.g. the `maintenance-e2e` idle-reader bound). Callers
 * that need per-verb shape (e.g. "an unindexed POST should produce exactly 1
 * PUT and 0 LISTs") read `puts` / `deletes` / `lists` directly.
 *
 * Beyond the op counts it tracks body bytes (`bytesRead` from `get`
 * results, `bytesWritten` from `put` bodies) and, when a
 * {@link KeyClassifier} is passed as the second argument, the same
 * per-class (e.g. tree-node) op and byte counts. Callers that pass only
 * `inner` see exactly the original behaviour.
 *
 * Counters are mutable — `reset()` zeroes them. Not thread-safe;
 * tests should not share an instance across concurrent workers.
 */
export interface CountingStorage {
  readonly storage: Storage;
  /**
   * Per-op-kind counts as a plain snapshot: `{ get, put, delete, list }`.
   * The same numbers as `gets` / `puts` / `deletes` / `lists`.
   */
  readonly counts: OpCounts;
  /**
   * Total body bytes returned by successful `get`s (a miss adds 0). `list`
   * entries carry no body, so they add 0.
   */
  readonly bytesRead: number;
  /**
   * Total body bytes handed to `put`, counted when the call is issued,
   * whatever its outcome (a rejected CAS or a thrown fault still sent the
   * bytes). Measured as `body.byteLength`, so typed-array views, `Buffer`
   * and `subarray` slices count their visible bytes (`Storage.put` takes
   * only `Uint8Array`).
   */
  readonly bytesWritten: number;
  /**
   * Per-class counters, keyed by the classifier passed to
   * `wrapCountingStorage`. A class is created on first use; with no
   * classifier the map stays empty. Reads the live state, not a snapshot
   * (the entries themselves are copies).
   */
  readonly classes: ReadonlyMap<string, ClassCounts>;
  /** Counters for `name`, all zero when nothing has been classified under it. */
  classCounts(name: string): ClassCounts;
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

/** Op counts by `Storage` method. */
export interface OpCounts {
  readonly get: number;
  readonly put: number;
  readonly delete: number;
  readonly list: number;
}

/**
 * Counters for one class of keys (e.g. tree nodes): op counts and body
 * bytes. `list` is not attributed: a list names a prefix, not an object.
 */
export interface ClassCounts {
  readonly gets: number;
  readonly puts: number;
  readonly deletes: number;
  readonly bytesRead: number;
  readonly bytesWritten: number;
}

/**
 * Maps an object key to a class name, or `undefined` to leave the key out
 * of the per-class counters (the global counters still count it). Called
 * once per `get` / `put` / `delete` with the key as issued, e.g.
 * `(key) => /\/tree\/node\//.test(key) ? "node" : undefined`.
 */
export type KeyClassifier = (key: string) => string | undefined;

interface MutableClassCounts {
  gets: number;
  puts: number;
  deletes: number;
  bytesRead: number;
  bytesWritten: number;
}

export function wrapCountingStorage(inner: Storage, classify?: KeyClassifier): CountingStorage {
  let puts = 0;
  let deletes = 0;
  let lists = 0;
  let gets = 0;
  let bytesRead = 0;
  let bytesWritten = 0;
  const classes = new Map<string, MutableClassCounts>();
  const classOf = (key: string): MutableClassCounts | undefined => {
    const name = classify?.(key);
    if (name === undefined) {
      return undefined;
    }
    let counts = classes.get(name);
    if (counts === undefined) {
      counts = { gets: 0, puts: 0, deletes: 0, bytesRead: 0, bytesWritten: 0 };
      classes.set(name, counts);
    }
    return counts;
  };
  const storage: Storage = {
    get: async (key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> => {
      gets++;
      const cls = classOf(key);
      if (cls !== undefined) {
        cls.gets++;
      }
      const result = await inner.get(key, opts);
      if (result !== null) {
        bytesRead += result.body.byteLength;
        if (cls !== undefined) {
          cls.bytesRead += result.body.byteLength;
        }
      }
      return result;
    },
    put: (key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> => {
      puts++;
      bytesWritten += body.byteLength;
      const cls = classOf(key);
      if (cls !== undefined) {
        cls.puts++;
        cls.bytesWritten += body.byteLength;
      }
      return inner.put(key, body, opts);
    },
    delete: (key: string, opts?: { signal?: AbortSignal }): Promise<void> => {
      deletes++;
      const cls = classOf(key);
      if (cls !== undefined) {
        cls.deletes++;
      }
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
    get counts() {
      return { get: gets, put: puts, delete: deletes, list: lists };
    },
    get bytesRead() {
      return bytesRead;
    },
    get bytesWritten() {
      return bytesWritten;
    },
    get classes() {
      return new Map([...classes].map(([name, c]) => [name, { ...c }]));
    },
    classCounts(name: string) {
      return { gets: 0, puts: 0, deletes: 0, bytesRead: 0, bytesWritten: 0, ...classes.get(name) };
    },
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
      bytesRead = 0;
      bytesWritten = 0;
      classes.clear();
    },
  };
}
