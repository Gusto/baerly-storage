import { useEffect, useRef, useState } from "react";
import type { JSONArraylessObject, Predicate } from "@baerly/protocol";
import type { BaerlyClient } from "../client.ts";
import { stableKey } from "./stable-key.ts";
import { useChanges } from "./use-changes.ts";

export interface UseLiveQueryOptions {
  /** When `false`, suspends both the initial read and the subscription. Default `true`. */
  readonly enabled?: boolean;
}

export interface UseLiveQueryResult<T> {
  /**
   * Current matching rows. Empty array until the first read lands.
   * Always reflects the predicate as of the most recent successful
   * read.
   */
  readonly rows: ReadonlyArray<T>;
  /** `true` while the first read is in flight (cleared after first success). */
  readonly loading: boolean;
  /** Most recent read or subscription error. Cleared on the next successful read. */
  readonly error: Error | undefined;
}

/**
 * Declarative live query. Subscribes to `table` and re-reads
 * `.where(predicate).all()` whenever the server emits new log
 * events. Idle long-poll cycles are dropped at the
 * {@link useChanges} layer, so a steady-state table costs zero
 * list reads.
 *
 * The `predicate` is stable-stringified internally — passing an
 * inline object (`{ status: filter }`) does not churn extra fetches.
 *
 * @example
 * ```tsx
 * const { rows, loading, error } = useLiveQuery<Ticket>(
 *   client,
 *   "tickets",
 *   filter === "all" ? {} : { status: filter },
 * );
 * if (error) return <p>Error: {error.message}</p>;
 * if (loading) return <p>Loading…</p>;
 * return <ul>{rows.map((t) => <li key={t._id}>{t.title}</li>)}</ul>;
 * ```
 */
export const useLiveQuery = <T extends JSONArraylessObject = JSONArraylessObject>(
  client: BaerlyClient,
  table: string,
  predicate: Predicate<T> = {} as Predicate<T>,
  opts: UseLiveQueryOptions = {},
): UseLiveQueryResult<T> => {
  const { enabled = true } = opts;
  const [rows, setRows] = useState<ReadonlyArray<T>>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [fetchError, setFetchError] = useState<Error | undefined>(undefined);

  const { cursor, error: pollError } = useChanges(client, table, { enabled });

  // Snapshot the predicate by value through a ref so the fetch
  // closure reads the latest snapshot via `.current` rather than
  // closing over a stale literal. The dep is the stable string key,
  // so predicate-reference churn on every render doesn't trigger
  // refetches.
  const predicateKey = stableKey(predicate);
  const predicateRef = useRef<Predicate<T>>(predicate);
  predicateRef.current = predicate;

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    setLoading(true);
    void (async () => {
      try {
        const next = await client
          .table<T>(table)
          .where(predicateRef.current)
          .all({ signal: controller.signal });
        setRows(next);
        setFetchError(undefined);
      } catch (error) {
        // `AbortError` here only ever comes from our own `controller.abort()`
        // in the cleanup below — the effect re-ran or the component
        // unmounted. Either way the caller is gone; surfacing the
        // throw would trigger a setState-after-unmount React warning
        // and clobber a still-valid result from the next effect run.
        if (controller.signal.aborted) {
          return;
        }
        setFetchError(error instanceof Error ? error : new Error(String(error)));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    })();
    return (): void => {
      controller.abort();
    };
  }, [client, table, predicateKey, cursor, enabled]);

  return { rows, loading, error: fetchError ?? pollError };
};
