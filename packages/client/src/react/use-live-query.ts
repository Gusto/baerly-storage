import { useEffect, useRef, useState } from "react";
import type { JSONArraylessObject, Predicate } from "@baerly/protocol";
import { useBaerlyClient } from "./provider.ts";
import { stableKey } from "./stable-key.ts";
import { useInvalidationTick } from "./use-invalidation-tick.ts";

export interface UseLiveQueryOptions<T extends JSONArraylessObject = JSONArraylessObject> {
  /** Table to read. */
  readonly table: string;
  /**
   * Equality predicate over top-level or dotted-path keys. Optional;
   * defaults to `{}` (matches every row). Inline objects are fine —
   * the hook stable-stringifies internally so reference churn does
   * not refetch.
   */
  readonly where?: Predicate<T>;
  /** When `false`, suspends both the initial read and the subscription. Default `true`. */
  readonly enabled?: boolean;
}

/**
 * Live query result. The `status` field discriminates the three
 * possible states — narrow on it to access `rows` / `error` safely.
 *
 * - `"loading"` — the first read is in flight.
 * - `"ok"` — the most recent read returned rows; `rows` is populated
 *   (possibly empty when the predicate has no matches).
 * - `"error"` — the most recent read failed; `error` is populated.
 */
export type UseLiveQueryResult<T> =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly rows: ReadonlyArray<T> }
  | { readonly status: "error"; readonly error: Error };

/**
 * Declarative live query. Subscribes to `table` and re-reads
 * `.where(where).all()` whenever the server emits new log events.
 * Idle long-poll cycles are dropped at the
 * {@link useInvalidationTick} layer, so a steady-state table costs
 * zero list reads.
 *
 * The `where` predicate is stable-stringified internally — passing
 * an inline object (`{ status: filter }`) does not churn extra
 * fetches.
 *
 * @example
 * ```tsx
 * const result = useLiveQuery<Ticket>({
 *   table: "tickets",
 *   where: filter === "all" ? {} : { status: filter },
 * });
 * if (result.status === "loading") return <p>Loading…</p>;
 * if (result.status === "error") return <p>Error: {result.error.message}</p>;
 * return <ul>{result.rows.map((t) => <li key={t._id}>{t.title}</li>)}</ul>;
 * ```
 */
export const useLiveQuery = <T extends JSONArraylessObject = JSONArraylessObject>(
  opts: UseLiveQueryOptions<T>,
): UseLiveQueryResult<T> => {
  const { table, where = {} as Predicate<T>, enabled = true } = opts;
  const client = useBaerlyClient();
  const [state, setState] = useState<UseLiveQueryResult<T>>({ status: "loading" });

  const tick = useInvalidationTick({ table, enabled });

  // Snapshot the predicate by value through a ref so the fetch
  // closure reads the latest snapshot via `.current` rather than
  // closing over a stale literal. The dep is the stable string key,
  // so predicate-reference churn on every render doesn't trigger
  // refetches.
  const predicateKey = stableKey(where);
  const predicateRef = useRef<Predicate<T>>(where);
  predicateRef.current = where;

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const controller = new AbortController();
    setState((prev) => (prev.status === "loading" ? prev : { status: "loading" }));
    void (async () => {
      try {
        const next = await client
          .table<T>(table)
          .where(predicateRef.current)
          .all({ signal: controller.signal });
        if (controller.signal.aborted) {
          return;
        }
        setState({ status: "ok", rows: next });
      } catch (error) {
        // `AbortError` here only ever comes from our own
        // `controller.abort()` in the cleanup below — the effect
        // re-ran or the component unmounted. Either way the caller
        // is gone; surfacing the throw would trigger a
        // setState-after-unmount React warning and clobber a
        // still-valid result from the next effect run.
        if (controller.signal.aborted) {
          return;
        }
        setState({
          status: "error",
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    })();
    return (): void => {
      controller.abort();
    };
  }, [client, table, predicateKey, tick, enabled]);

  return state;
};
