import { BaerlyError } from "@baerly/protocol";
import type { BaerlyClient } from "../client.ts";
import { getClientContext } from "../internal/context.ts";
import { pollSinceOnce } from "../poll-since-once.ts";
import {
  SUBSCRIPTION_RETRY_INITIAL_MILLIS,
  SUBSCRIPTION_RETRY_MAX_MILLIS,
} from "./subscription-retry.ts";

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

const isAbortError = (raw: unknown): boolean =>
  typeof raw === "object" && raw !== null && "name" in raw && raw.name === "AbortError";

const retryDelay = (attempt: number): number => {
  const upperBound = Math.min(
    SUBSCRIPTION_RETRY_MAX_MILLIS,
    SUBSCRIPTION_RETRY_INITIAL_MILLIS * 2 ** attempt,
  );
  return Math.floor(upperBound / 2 + Math.random() * (upperBound / 2));
};

const waitForRetry = async (delay: number, signal: AbortSignal): Promise<void> => {
  if (signal.aborted) {
    return;
  }
  const cleanup: Array<() => void> = [];
  const timeout = new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delay);
    cleanup.push(() => clearTimeout(timer));
  });
  const aborted = new Promise<void>((resolve) => {
    const onAbort = (): void => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    cleanup.push(() => signal.removeEventListener("abort", onAbort));
  });
  await Promise.race([timeout, aborted]);
  for (const dispose of cleanup) {
    dispose();
  }
};

interface CacheEntry {
  snapshot: CachedSnapshot;
  /** Whether this entry has completed at least one successful read. */
  hasSuccessfulData: boolean;
  /** Tables this signature's chain references — used for invalidation. */
  readonly chainTables: ReadonlySet<string>;
  /** Aborts the in-flight read for this signature, if any. */
  inFlight: AbortController | undefined;
}

interface TablePoll {
  refcount: number;
  controller: AbortController;
  cursor: string;
  terminalError: Error | undefined;
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
  /** Re-run an attached signature's current fetcher. */
  refetch(signature: string): void;
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

  const terminalErrorFor = (entry: CacheEntry): Error | undefined => {
    for (const table of entry.chainTables) {
      const error = tablePolls.get(table)?.terminalError;
      if (error !== undefined) {
        return error;
      }
    }
    return undefined;
  };

  const dispatchFetch = (signature: string, fetcher: () => Promise<unknown>): void => {
    const entry = cache.get(signature);
    if (entry === undefined) {
      return;
    }
    const terminalError = terminalErrorFor(entry);
    if (terminalError !== undefined) {
      if (entry.snapshot.status !== "error" || entry.snapshot.error !== terminalError) {
        entry.snapshot = {
          status: "error",
          data: entry.snapshot.data,
          error: terminalError,
        };
        notifyAll(signature);
      }
      return;
    }
    if (entry.inFlight !== undefined) {
      entry.inFlight.abort();
    }
    const controller = new AbortController();
    entry.inFlight = controller;
    const prevSnapshot = entry.snapshot;
    entry.snapshot = entry.hasSuccessfulData
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
        live.hasSuccessfulData = true;
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

  const invalidateForTable = (
    table: string,
    skipSignature?: string,
    dispatchedSignatures?: Set<string>,
  ): void => {
    for (const [signature, entry] of cache) {
      if (
        !entry.chainTables.has(table) ||
        signature === skipSignature ||
        dispatchedSignatures?.has(signature)
      ) {
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
        dispatchedSignatures?.add(signature);
        dispatchFetch(signature, fetcher);
      }
    }
  };

  const failForTable = (table: string, error: Error): void => {
    for (const [signature, entry] of cache) {
      if (!entry.chainTables.has(table)) {
        continue;
      }
      const subs = subscribersBySignature.get(signature);
      if (subs === undefined || subs.size === 0) {
        continue;
      }
      entry.inFlight?.abort();
      entry.inFlight = undefined;
      entry.snapshot = {
        status: "error",
        data: entry.snapshot.data,
        error,
      };
      notifyAll(signature);
    }
  };

  /** Per-signature fetcher; last writer wins (all fetchers for a signature are equivalent). */
  const signatureFetchers = new Map<string, () => Promise<unknown>>();

  const startTablePoll = (table: string, initialRefcount = 1): void => {
    if (tablePolls.has(table)) {
      return;
    }
    const controller = new AbortController();
    const poll: TablePoll = {
      refcount: initialRefcount,
      controller,
      cursor: "",
      terminalError: undefined,
    };
    tablePolls.set(table, poll);
    const ctx = getClientContext(client);
    void (async () => {
      let retryAttempt = 0;
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
          retryAttempt = 0;
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }
          if (isAbortError(error)) {
            return;
          }
          let recoveredDeadCursor = false;
          if (error instanceof BaerlyError && error.code === "SchemaError" && poll.cursor !== "") {
            // The cursor is unrecoverable, not the request. `/v1/since`
            // returns this for exactly two states, both permanent: the
            // entry was folded into a snapshot and GC'd, or the cursor
            // was minted in a generation `restore --force` has since
            // truncated. Retrying the same cursor can never clear
            // either one, so without this the loop would retry it at
            // 1 req/s forever with the table frozen.
            //
            // Re-bootstrap: `""` restarts from `log_seq_start`, which
            // is what the server's error text asks for. The invalidate
            // refetches the visible queries so subscribers converge on
            // the post-restore state rather than sitting on pre-restore
            // data.
            //
            // We deliberately do NOT `continue` past the backoff below.
            // The `poll.cursor !== ""` guard bounds a same-iteration
            // respin, but not a two-iteration oscillation: if the
            // server rejects a cursor it just minted — a mixed-version
            // fleet mid-rolling-deploy is the reachable case, where one
            // replica issues a shape the other refuses — then `""`
            // succeeds, hands back a fresh cursor, and that cursor is
            // rejected again. Skipping the backoff would make that
            // cycle run at network speed, with an `invalidateForTable`
            // refetch storm on every lap. Falling through costs one
            // backoff interval of recovery latency and bounds the
            // pathological cycle.
            poll.cursor = "";
            invalidateForTable(table);
            recoveredDeadCursor = true;
          }
          if (!recoveredDeadCursor && error instanceof BaerlyError && !error.retriable) {
            poll.terminalError = error;
            failForTable(table, error);
            return;
          }
          const delay = retryDelay(retryAttempt);
          retryAttempt += 1;
          await waitForRetry(delay, controller.signal);
        }
      }
    })();
  };

  const restartTerminalPoll = (table: string): boolean => {
    const poll = tablePolls.get(table);
    if (poll?.terminalError === undefined) {
      return false;
    }
    const refcount = poll.refcount;
    poll.controller.abort();
    tablePolls.delete(table);
    startTablePoll(table, refcount);
    return true;
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
    refetch(signature: string): void {
      const entry = cache.get(signature);
      const fetcher = signatureFetchers.get(signature);
      if (entry === undefined || fetcher === undefined) {
        return;
      }
      const revived: Array<string> = [];
      for (const table of entry.chainTables) {
        if (restartTerminalPoll(table)) {
          revived.push(table);
        }
      }
      dispatchFetch(signature, fetcher);
      // `failForTable` parked *every* signature on the dead table, not
      // just this one. The revived poll only re-invalidates once the
      // server has an event to report, so on a quiet collection the
      // siblings would sit on a stale error forever even though the
      // poll behind them is healthy again. Refresh them here; the
      // caller is already dispatched above and is skipped so it isn't
      // aborted and re-issued.
      const dispatchedSignatures = new Set<string>();
      for (const table of revived) {
        invalidateForTable(table, signature, dispatchedSignatures);
      }
    },
    attach(signature, tables, chainTables, fetcher, notify) {
      let entry = cache.get(signature);
      const isFirstSubscriber = entry === undefined;
      if (entry === undefined) {
        entry = {
          snapshot: LOADING_SNAPSHOT,
          hasSuccessfulData: false,
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
