import {
  RequestLedger,
  type RequestLedgerLimits,
  type RequestPool,
  retryStorageCall,
  type Storage,
  type StorageGetOptions,
  type StorageGetResult,
  type StorageListEntry,
  type StoragePutOptions,
  type StoragePutResult,
} from "@baerly/protocol";
import {
  type CallCounts,
  CallTally,
  LIST_PAGE_SIZE,
  type RequestCounter,
  totalCalls,
} from "./request-counting-storage.ts";

/**
 * Wrap `inner` the way a real adapter wraps its transport: every object
 * call, and every `list` page of at most {@link LIST_PAGE_SIZE} keys, runs
 * in one `retryStorageCall` charged to `pool`. Inside a context carrying a
 * request ledger, each call is charged to that ledger before it reaches
 * `inner`, and one the ledger refuses never does.
 *
 * `issued` is charged for each request as it reaches `inner`, so it counts
 * what was issued, by kind; the ledger's charge must agree with it. A page is requested only when
 * the consumer pulls past the previous one, and only if that page was full
 * and more keys exist (S3's `IsTruncated`), so a page is one request as on
 * S3 and R2. Node-import-free, so it loads under workerd too.
 */
export const ledgeredStorage = (
  inner: Storage,
  pool: RequestPool,
  issued: RequestCounter = { charge: () => {} },
): Storage => ({
  get: (key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> =>
    retryStorageCall(
      () => {
        issued.charge("get");
        return inner.get(key, opts);
      },
      { pool },
    ),
  put: (key: string, body: Uint8Array, opts?: StoragePutOptions): Promise<StoragePutResult> =>
    retryStorageCall(
      () => {
        issued.charge("put");
        return inner.put(key, body, opts);
      },
      { pool, conditionalCreate: opts?.ifNoneMatch === "*" },
    ),
  delete: (key: string, opts?: { signal?: AbortSignal }): Promise<void> =>
    retryStorageCall(
      () => {
        issued.charge("delete");
        return inner.delete(key, opts);
      },
      { pool },
    ),
  list: async function* (
    prefix: string,
    opts?: { startAfter?: string; maxKeys?: number; signal?: AbortSignal },
  ): AsyncIterable<StorageListEntry> {
    let startAfter = opts?.startAfter;
    let remaining = opts?.maxKeys ?? Infinity;
    while (remaining > 0) {
      const want = Math.min(remaining, LIST_PAGE_SIZE);
      // One page request, charged before it is issued. The page streams
      // lazily; asking for one key past it tells whether it is truncated,
      // as S3 reports `IsTruncated`.
      await retryStorageCall(
        async () => {
          issued.charge("listPage");
        },
        { pool },
      );
      let got = 0;
      let truncated = false;
      for await (const entry of inner.list(prefix, {
        ...(startAfter !== undefined && { startAfter }),
        maxKeys: want + 1,
        ...(opts?.signal !== undefined && { signal: opts.signal }),
      })) {
        if (got === want) {
          truncated = true;
          break;
        }
        got += 1;
        startAfter = entry.key;
        yield entry;
      }
      remaining -= got;
      if (!truncated) {
        return;
      }
    }
  },
});

/** A {@link ledgeredStorage} with a counting ledger and the issued tally beside it. */
export interface ChargedStorage {
  /** Storage to run the measured work against. */
  readonly storage: Storage;
  /** Put this on the observability context the work runs in. */
  readonly ledger: RequestLedger;
  /**
   * The calls issued, by kind, after checking that the ledger charged
   * exactly that many: every issued call charged once, nothing charged
   * that was not issued. Throws on any difference.
   */
  read(): CallCounts;
}

/**
 * Measure storage calls through the ledger: `inner` behind
 * {@link ledgeredStorage}, a ledger with `limits` (by default one that
 * counts and never refuses), and the issued tally that proves the
 * ledger's charge equals what was sent.
 */
export const chargedStorage = (
  inner: Storage,
  pool: RequestPool,
  limits?: RequestLedgerLimits,
): ChargedStorage => {
  const ledger = new RequestLedger(limits);
  const issued = new CallTally();
  return {
    storage: ledgeredStorage(inner, pool, issued),
    ledger,
    read: (): CallCounts => {
      const counts = issued.read();
      const total = totalCalls(counts);
      const charged = ledger.charged;
      const external = pool === "external" ? total : 0;
      if (charged.internal !== total || charged.external !== external) {
        throw new Error(
          `request ledger charged internal=${charged.internal} external=${charged.external}, but ${total} ${pool} calls were issued`,
        );
      }
      return counts;
    },
  };
};
