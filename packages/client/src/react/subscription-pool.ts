import { BaerlyError } from "@baerly/protocol";
import type { BaerlyClient } from "../client.ts";
import { getClientContext } from "../internal/context.ts";
import { pollSinceOnce } from "../poll-since-once.ts";

/**
 * Discriminated snapshot a hook hands back from `getSnapshot`. The
 * `useQuery` types narrow this further (data: T vs data: undefined);
 * the pool stores it generically so the cache can be a single
 * `Map<signature, CachedSnapshot>`.
 */
export interface CachedSnapshot {
  readonly status: "loading" | "refreshing" | "ok" | "error";
  readonly data: unknown;
  readonly error: Error | undefined;
}

export const LOADING_SNAPSHOT: CachedSnapshot = Object.freeze({
  status: "loading",
  data: undefined,
  error: undefined,
});

const toError = (raw: unknown): Error => {
  if (raw instanceof BaerlyError || raw instanceof Error) {
    return raw;
  }
  return new BaerlyError("Internal", String(raw));
};

interface CacheEntry {
  snapshot: CachedSnapshot;
  /** Tables this signature's chain references — used for invalidation. */
  readonly chainTables: ReadonlySet<string>;
  /** Aborts the in-flight read for this signature, if any. */
  inFlight: AbortController | undefined;
}

interface TablePoll {
  refcount: number;
  controller: AbortController;
  cursor: string;
}

interface SubscriptionPool {
  /** Register a subscriber. Returns an unsubscribe. */
  attach(
    signature: string,
    tables: ReadonlyArray<string>,
    chainTables: ReadonlySet<string>,
    fetcher: () => Promise<unknown>,
    notify: () => void,
  ): () => void;
  /** Read the cached snapshot for `signature` (or the canonical loading sentinel). */
  getSnapshot(signature: string): CachedSnapshot;
}

const poolByClient = new WeakMap<BaerlyClient, SubscriptionPool>();

/** Returns the (lazily-created) pool for `client`. */
export const poolFor = (client: BaerlyClient): SubscriptionPool => {
  let pool = poolByClient.get(client);
  if (pool === undefined) {
    pool = createPool(client);
    poolByClient.set(client, pool);
  }
  return pool;
};

const createPool = (client: BaerlyClient): SubscriptionPool => {
  const cache = new Map<string, CacheEntry>();
  const subscribersBySignature = new Map<string, Set<() => void>>();
  const tablePolls = new Map<string, TablePoll>();

  const notifyAll = (signature: string): void => {
    const subs = subscribersBySignature.get(signature);
    if (subs === undefined) {
      return;
    }
    for (const notify of subs) {
      notify();
    }
  };

  const dispatchFetch = (signature: string, fetcher: () => Promise<unknown>): void => {
    const entry = cache.get(signature);
    if (entry === undefined) {
      return;
    }
    if (entry.inFlight !== undefined) {
      entry.inFlight.abort();
    }
    const controller = new AbortController();
    entry.inFlight = controller;
    const prevSnapshot = entry.snapshot;
    const hadData = entry.snapshot.status === "ok" || entry.snapshot.status === "refreshing";
    entry.snapshot = hadData
      ? { status: "refreshing", data: entry.snapshot.data, error: undefined }
      : LOADING_SNAPSHOT;
    if (entry.snapshot !== prevSnapshot) {
      notifyAll(signature);
    }
    void (async () => {
      try {
        const data = await fetcher();
        if (controller.signal.aborted) {
          return;
        }
        const live = cache.get(signature);
        if (live === undefined || live.inFlight !== controller) {
          return;
        }
        live.snapshot = { status: "ok", data, error: undefined };
        live.inFlight = undefined;
        notifyAll(signature);
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        const live = cache.get(signature);
        if (live === undefined || live.inFlight !== controller) {
          return;
        }
        const wrapped = toError(error);
        live.snapshot = {
          status: "error",
          data: live.snapshot.data,
          error: wrapped,
        };
        live.inFlight = undefined;
        notifyAll(signature);
      }
    })();
  };

  const invalidateForTable = (table: string): void => {
    for (const [signature, entry] of cache) {
      if (!entry.chainTables.has(table)) {
        continue;
      }
      const subs = subscribersBySignature.get(signature);
      if (subs === undefined || subs.size === 0) {
        continue;
      }
      // Any subscriber's fetcher is fine — they all produce the
      // same call against the real client for this signature
      // (signature is hashed on chain shape + deps).
      const fetcher = signatureFetchers.get(signature);
      if (fetcher !== undefined) {
        dispatchFetch(signature, fetcher);
      }
    }
  };

  /** Per-signature fetcher; last writer wins (all fetchers for a signature are equivalent). */
  const signatureFetchers = new Map<string, () => Promise<unknown>>();

  const startTablePoll = (table: string): void => {
    if (tablePolls.has(table)) {
      return;
    }
    const controller = new AbortController();
    const poll: TablePoll = { refcount: 1, controller, cursor: "" };
    tablePolls.set(table, poll);
    const ctx = getClientContext(client);
    void (async () => {
      while (!controller.signal.aborted) {
        try {
          const res = await pollSinceOnce(ctx, table, poll.cursor, controller.signal);
          if (controller.signal.aborted) {
            return;
          }
          if (res.events.length > 0 || res.next_cursor !== poll.cursor) {
            poll.cursor = res.next_cursor;
            if (res.events.length > 0) {
              invalidateForTable(table);
            }
          }
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }
          if (error instanceof DOMException && error.name === "AbortError") {
            return;
          }
          // 1-second backoff on error — match the prior
          // useInvalidationTick semantics. Downstream subscribers'
          // next fetch will see the same failure if it's persistent.
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    })();
  };

  const stopTablePoll = (table: string): void => {
    const poll = tablePolls.get(table);
    if (poll === undefined) {
      return;
    }
    poll.refcount--;
    if (poll.refcount === 0) {
      poll.controller.abort();
      tablePolls.delete(table);
    }
  };

  const incrementTablePoll = (table: string): void => {
    const poll = tablePolls.get(table);
    if (poll === undefined) {
      startTablePoll(table);
    } else {
      poll.refcount++;
    }
  };

  return {
    getSnapshot(signature: string): CachedSnapshot {
      return cache.get(signature)?.snapshot ?? LOADING_SNAPSHOT;
    },
    attach(signature, tables, chainTables, fetcher, notify) {
      let entry = cache.get(signature);
      const isFirstSubscriber = entry === undefined;
      if (entry === undefined) {
        entry = {
          snapshot: LOADING_SNAPSHOT,
          chainTables,
          inFlight: undefined,
        };
        cache.set(signature, entry);
      }
      signatureFetchers.set(signature, fetcher);
      let subs = subscribersBySignature.get(signature);
      if (subs === undefined) {
        subs = new Set();
        subscribersBySignature.set(signature, subs);
      }
      subs.add(notify);
      for (const table of tables) {
        incrementTablePoll(table);
      }
      if (isFirstSubscriber) {
        dispatchFetch(signature, fetcher);
      } else {
        // Cache already has data (or in-flight). The new subscriber
        // gets the existing snapshot via getSnapshot; no extra fetch.
      }
      return () => {
        const liveSubs = subscribersBySignature.get(signature);
        if (liveSubs !== undefined) {
          liveSubs.delete(notify);
          if (liveSubs.size === 0) {
            subscribersBySignature.delete(signature);
            const liveEntry = cache.get(signature);
            if (liveEntry !== undefined) {
              liveEntry.inFlight?.abort();
              cache.delete(signature);
            }
            signatureFetchers.delete(signature);
          }
        }
        for (const table of tables) {
          stopTablePoll(table);
        }
      };
    },
  };
};
