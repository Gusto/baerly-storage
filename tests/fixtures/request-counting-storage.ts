import type {
  Storage,
  StorageGetOptions,
  StorageGetResult,
  StorageListEntry,
  StoragePutOptions,
  StoragePutResult,
} from "@baerly/protocol";

/**
 * One storage call as a host would bill it against a per-request
 * subrequest budget. `listPage` is one LIST request, not one `list()`
 * call: a `list()` that walks past {@link LIST_PAGE_SIZE} keys issues one
 * request per page on S3 and R2. The `Storage` interface has no HEAD, so
 * there is no `head` kind.
 */
export type StorageCallKind = "get" | "put" | "delete" | "listPage";

/** Every {@link StorageCallKind}, in the order snapshots print them. */
export const STORAGE_CALL_KINDS: readonly StorageCallKind[] = ["get", "put", "delete", "listPage"];

/**
 * Keys per LIST page. Matches the `max-keys` cap `S3HttpStorage` /
 * `GcsHttpStorage` send (`Math.min(remaining, 1000)`) and the R2
 * binding's `list()` default limit.
 */
export const LIST_PAGE_SIZE = 1000;

/**
 * The seam a counted call reports to. Kept to one method so a request
 * ledger's charge counter can stand in for the tally below without the
 * callers changing.
 */
export interface RequestCounter {
  charge(kind: StorageCallKind): void;
}

export type CallCounts = Record<StorageCallKind, number>;

/** A {@link RequestCounter} that tallies calls by kind. */
export class CallTally implements RequestCounter {
  #counts: CallCounts = { get: 0, put: 0, delete: 0, listPage: 0 };

  charge(kind: StorageCallKind): void {
    this.#counts[kind] += 1;
  }

  /** A copy of the counts so far. */
  read(): CallCounts {
    return { ...this.#counts };
  }
}

/** Sum of every kind: the number a per-request subrequest cap sees. */
export const totalCalls = (c: CallCounts): number =>
  STORAGE_CALL_KINDS.reduce((sum, k) => sum + c[k], 0);

/**
 * Wrap `inner` so every storage request it would issue is charged to
 * `counter`. Happy-path only: one call is one charge, with no retry
 * attempts, because `MemoryStorage` never fails. Fault paths and retry
 * accounting are covered by the adapters' request-accounting tests.
 */
export const requestCountingStorage = (inner: Storage, counter: RequestCounter): Storage => ({
  get: (key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> => {
    counter.charge("get");
    return inner.get(key, opts);
  },
  put: (key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> => {
    counter.charge("put");
    return inner.put(key, body, opts);
  },
  delete: (key: string, opts?: { signal?: AbortSignal }): Promise<void> => {
    counter.charge("delete");
    return inner.delete(key, opts);
  },
  list: async function* (
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry> {
    // The first page is requested when iteration starts, even if it comes
    // back empty; each later page only once the consumer pulls past the
    // previous page's last key.
    counter.charge("listPage");
    let yielded = 0;
    for await (const entry of inner.list(prefix, opts)) {
      if (yielded > 0 && yielded % LIST_PAGE_SIZE === 0) {
        counter.charge("listPage");
      }
      yielded += 1;
      yield entry;
    }
  },
});
