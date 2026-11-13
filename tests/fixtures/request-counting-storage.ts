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

/** The seam a counted call reports to: `ledgeredStorage` charges it as each request is issued. */
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
