import { BaerlyError } from "@baerly/protocol";
import type { BaerlyClient } from "../client.ts";
import { getClientContext } from "../internal/context.ts";
import { pollSinceOnce } from "../poll-since-once.ts";
import { pollRetryDelay } from "./subscription-retry.ts";

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

/**
 * Receives a read's `_meta.since_cursor` under the collection it read.
 * The pool hands one to every fetch it runs (see `withSignal`).
 */
type ReadCursorSink = (collection: string, cursor: string) => void;

/** A query fetch: runs the query's callback against a scoped client. */
type Fetcher = (signal: AbortSignal, onReadCursor: ReadCursorSink) => Promise<unknown>;

interface CacheEntry {
  snapshot: CachedSnapshot;
  /** Whether this entry has completed at least one successful read. */
  hasSuccessfulData: boolean;
  /** Tables this signature's chain references — used for invalidation. */
  readonly chainTables: ReadonlySet<string>;
  /** Aborts the in-flight read for this signature, if any. */
  inFlight: AbortController | undefined;
}

/**
 * One collection's `/v1/since` loop.
 *
 * The poll's starting position comes from a query, not from a request
 * of its own. A `cursor=""` poll issued alongside a query reads the log
 * at a different moment than the query does, so a change that commits
 * and folds between the two would be missed (or, the other way round,
 * delivered on top of a state that already holds it). Instead the poll
 * waits, with `cursor` unset, for a fetch on its collection to finish,
 * and starts from that read's `_meta.since_cursor`: exactly after the
 * state the query rendered. It does so when it starts and again after
 * `CursorExpired`.
 *
 * Several queries can read one collection, each at its own moment. A
 * fetch dispatched after the seed arrived read a state at or past it,
 * so every change it has not seen is still ahead of the poll. A fetch
 * already running when the seed arrived may have read an earlier state,
 * so it is accepted only if every cursor it read equals the seed, and
 * otherwise runs again (now after the seed). The cursors are opaque and
 * are only ever compared for equality.
 *
 * A fetch that ends without a cursor for the collection (it failed, was
 * cancelled, did not read it, or read from a server that predates
 * `_meta.since_cursor`) does not seed while another fetch that may is
 * still running: seeding then would wave that one through unchecked.
 * Only once none is left does the poll start from `""`, the
 * request-of-its-own bootstrap, so it still runs.
 */
interface TablePoll {
  refcount: number;
  controller: AbortController;
  /** What the next poll sends; unset while waiting for a seed. */
  cursor: string | undefined;
  /** Counts the waits for a seed, so a fetch can tell which one it saw. */
  epoch: number;
  /** The `_meta.since_cursor` this wait was seeded with; unset for `""`. */
  seed: string | undefined;
  /** Wakes the loop waiting for a seed. */
  wake: (() => void) | undefined;
  /** The fetches running that may seed this wait. */
  seeders: Set<AbortController>;
  terminalError: Error | undefined;
}

interface SubscriptionPool {
  /** Register a subscriber. Returns an unsubscribe. */
  attach(
    signature: string,
    tables: ReadonlyArray<string>,
    chainTables: ReadonlySet<string>,
    fetcher: Fetcher,
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

  const dispatchFetch = (signature: string, fetcher: Fetcher): void => {
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
    // The polls waiting for a seed as this fetch starts: it may seed
    // them, and its reads may predate whichever seed they get.
    const unseeded = new Map<string, { readonly poll: TablePoll; readonly epoch: number }>();
    for (const table of entry.chainTables) {
      const poll = tablePolls.get(table);
      if (poll !== undefined && poll.cursor === undefined) {
        unseeded.set(table, { poll, epoch: poll.epoch });
        poll.seeders.add(controller);
      }
    }
    const readCursors = new Map<string, string[]>();
    let settled = false;
    // Detached once the fetch settles: a scoped client the app kept must
    // not keep collecting into this fetch.
    const onReadCursor: ReadCursorSink = (collection, cursor) => {
      if (settled) {
        return;
      }
      const seen = readCursors.get(collection);
      if (seen === undefined) {
        readCursors.set(collection, [cursor]);
      } else {
        seen.push(cursor);
      }
    };
    /**
     * Settle this fetch against the polls it may seed, once. With
     * `useReads`, seed each still waiting from its reads; a poll it has no
     * cursor for is seeded with `""` only when no other seeder is left.
     * Reports whether any read of a seeded table saw a state other than
     * its seed (so this fetch's data may predate what the poll delivers).
     */
    const settleSeeds = (useReads: boolean): boolean => {
      if (settled) {
        return false;
      }
      settled = true;
      let predates = false;
      for (const [table, { poll, epoch }] of unseeded) {
        poll.seeders.delete(controller);
        if (tablePolls.get(table) !== poll || poll.epoch !== epoch) {
          continue;
        }
        const cursors = useReads ? readCursors.get(table) : undefined;
        if (poll.cursor === undefined && (cursors !== undefined || poll.seeders.size === 0)) {
          poll.seed = cursors?.[0];
          poll.cursor = poll.seed ?? "";
          poll.wake?.();
        }
        if (poll.seed !== undefined && cursors?.some((cursor) => cursor !== poll.seed) === true) {
          predates = true;
        }
      }
      readCursors.clear();
      return predates;
    };
    // A cancelled fetch may never settle; release its claim on the polls
    // after the dispatch that superseded it (if any) has registered.
    controller.signal.addEventListener(
      "abort",
      () => {
        queueMicrotask(() => settleSeeds(false));
      },
      { once: true },
    );
    const prevSnapshot = entry.snapshot;
    entry.snapshot = entry.hasSuccessfulData
      ? { status: "refreshing", data: entry.snapshot.data, error: undefined }
      : LOADING_SNAPSHOT;
    if (entry.snapshot !== prevSnapshot) {
      notifyAll(signature);
    }
    void (async () => {
      try {
        const data = await fetcher(controller.signal, onReadCursor);
        if (controller.signal.aborted) {
          return;
        }
        const live = cache.get(signature);
        if (live === undefined || live.inFlight !== controller) {
          settleSeeds(false);
          return;
        }
        const predates = settleSeeds(true);
        live.snapshot = { status: "ok", data, error: undefined };
        live.hasSuccessfulData = true;
        live.inFlight = undefined;
        notifyAll(signature);
        if (predates) {
          // Read before the seed arrived and at a different state: run
          // again, now after it, so no change between the two is lost.
          dispatchFetch(signature, fetcher);
        }
      } catch (error) {
        if (controller.signal.aborted) {
          return;
        }
        const live = cache.get(signature);
        if (live === undefined || live.inFlight !== controller) {
          settleSeeds(false);
          return;
        }
        settleSeeds(true);
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
  const signatureFetchers = new Map<string, Fetcher>();

  const startTablePoll = (table: string, initialRefcount = 1): void => {
    if (tablePolls.has(table)) {
      return;
    }
    const controller = new AbortController();
    const poll: TablePoll = {
      refcount: initialRefcount,
      controller,
      cursor: undefined,
      epoch: 0,
      seed: undefined,
      wake: undefined,
      seeders: new Set(),
      terminalError: undefined,
    };
    tablePolls.set(table, poll);
    const ctx = getClientContext(client);
    void (async () => {
      let retryAttempt = 0;
      let deadCursorRecoveryPending = false;
      while (!controller.signal.aborted) {
        const requestCursor = poll.cursor;
        if (requestCursor === undefined) {
          // A poll stopped while it waits is dropped with this promise.
          await new Promise<void>((resolve) => {
            poll.wake = resolve;
          });
          continue;
        }
        try {
          const res = await pollSinceOnce(ctx, table, requestCursor, controller.signal);
          if (controller.signal.aborted) {
            return;
          }
          // Adopt `next_cursor` even with no events: the first response to
          // `""` names a position past everything already folded, and
          // staying on `""` would let a change commit and fold between two
          // polls unseen. Only events invalidate.
          poll.cursor = res.next_cursor;
          if (res.events.length > 0) {
            invalidateForTable(table);
          }
          // A recovery seed proves itself by succeeding here. A `""` seed
          // is unproven while it hands back a replacement cursor, empty
          // batch or not: the replacement proves itself by succeeding on
          // the next request. `""` back means the server could not read
          // the collection, so there is no replacement to prove.
          const recoveryProven =
            !deadCursorRecoveryPending || requestCursor !== "" || res.next_cursor === "";
          if (recoveryProven) {
            retryAttempt = 0;
            deadCursorRecoveryPending = false;
          }
        } catch (error) {
          if (controller.signal.aborted) {
            return;
          }
          if (isAbortError(error)) {
            return;
          }
          let recoveredDeadCursor = false;
          if (
            error instanceof BaerlyError &&
            error.code === "CursorExpired" &&
            requestCursor !== ""
          ) {
            // The cursor is unrecoverable, not the request. `/v1/since`
            // returns this for exactly two states, both permanent: the
            // changes after the cursor are no longer retained, or the
            // cursor was minted in a generation `restore --force` has
            // since truncated. Retrying the same cursor can never clear
            // either one, so without this the loop would retry it at
            // exponential backoff forever with the table frozen. A
            // malformed cursor is `SchemaError` and parks below like any
            // other non-retriable code.
            //
            // Re-bootstrap, as the code's resolution asks: the invalidate
            // refetches the visible queries so subscribers converge on
            // the current state, since the changes after the dead cursor
            // are not replayed, and the poll waits to resume from what
            // the first refetch read (see `TablePoll`).
            //
            // We deliberately do NOT `continue` past the backoff below:
            // if the seed has expired again by the time it is used, it is
            // rejected, refetched and reseeded on every lap. Skipping the
            // backoff would make that cycle run at network speed, with an
            // `invalidateForTable` refetch storm on every lap. Falling
            // through costs one backoff interval of recovery latency and
            // bounds the pathological cycle.
            poll.cursor = undefined;
            poll.seed = undefined;
            poll.epoch += 1;
            poll.seeders.clear();
            deadCursorRecoveryPending = true;
            invalidateForTable(table);
            recoveredDeadCursor = true;
          }
          // A non-retriable code parks the poll until `refetch`:
          // `CapacityExceeded` included, since it clears only once the
          // app deletes or shrinks rows. A retriable `MaintenancePending`
          // waits at least the server's `retryAfter`.
          if (!recoveredDeadCursor && error instanceof BaerlyError && !error.retriable) {
            poll.terminalError = error;
            failForTable(table, error);
            return;
          }
          const delay = pollRetryDelay(retryAttempt, error);
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
