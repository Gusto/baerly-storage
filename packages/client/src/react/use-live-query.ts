import { useEffect, useRef, useState } from "react";
import {
  type ConsistencyLevel,
  type DocumentData,
  normalizePredicateArg,
  type OrderSpec,
  type PredicateArg,
} from "@baerly/protocol";
import { useBaerlyClient } from "./provider.ts";
import { stableKey } from "./stable-key.ts";
import { useInvalidationTick } from "./use-invalidation-tick.ts";

export interface UseLiveQueryOptions<T extends DocumentData = DocumentData> {
  /** Table to read. */
  readonly table: string;
  /**
   * Filter rows. Accepts the same two shapes as `ClientTable.where`:
   * an equality-only object literal, or a callback DSL
   * (`q => q.eq(...).gt(...)`) for the operator vocabulary. Optional;
   * defaults to `{}` (matches every row).
   *
   * Inline values are fine — the hook stable-stringifies the
   * normalised wire form internally so reference churn (e.g. a fresh
   * inline arrow each render) does not refetch.
   */
  readonly where?: PredicateArg<T>;
  /**
   * Order modifier for the read. Mirrors `ClientTable.order(...)`.
   * Inline objects are fine — the hook stable-stringifies internally.
   */
  readonly order?: OrderSpec<T>;
  /**
   * Read consistency for the underlying terminal read. Defaults to
   * `strong`. Use `"eventual"` for auto-refresh / list views where
   * shaving one Class B op per read matters more than the last-write
   * being reflected; the long-poll subscription still fires the
   * refetch as soon as a change lands.
   */
  readonly consistency?: ConsistencyLevel;
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
 * `.where(where).order(order).consistency(consistency).all()` whenever
 * the server emits new log events. Idle long-poll cycles are dropped
 * at the {@link useInvalidationTick} layer, so a steady-state table
 * costs zero list reads.
 *
 * `where` and `order` are stable-stringified internally — passing
 * inline objects (`{ status: filter }`, `{ created_at: "desc" }`) does
 * not churn extra fetches.
 *
 * @example
 * ```tsx
 * const result = useLiveQuery<Ticket>({
 *   table: "tickets",
 *   where: filter === "all" ? {} : { status: filter },
 *   order: { created_at: "desc" },
 *   consistency: "eventual",  // auto-refresh shaves one Class B op per read
 * });
 * if (result.status === "loading") return <p>Loading…</p>;
 * if (result.status === "error") return <p>Error: {result.error.message}</p>;
 * return <ul>{result.rows.map((t) => <li key={t._id}>{t.title}</li>)}</ul>;
 * ```
 */
export const useLiveQuery = <T extends DocumentData = DocumentData>(
  opts: UseLiveQueryOptions<T>,
): UseLiveQueryResult<T> => {
  const { table, where = {} as PredicateArg<T>, order, consistency, enabled = true } = opts;
  const client = useBaerlyClient();
  const [state, setState] = useState<UseLiveQueryResult<T>>({ status: "loading" });

  const tick = useInvalidationTick({ table, enabled });

  // Snapshot the predicate + order by value through refs so the fetch
  // closure reads the latest snapshot via `.current` rather than
  // closing over a stale literal. The deps are stable string keys,
  // so reference churn on every render doesn't trigger refetches.
  //
  // Normalise `where` to the wire form BEFORE stable-keying. Object-
  // form and callback-form predicates with the same semantic content
  // produce the same wire, so `.where({ status: "open" })` and
  // `.where(q => q.eq("status", "open"))` share a cache entry. The
  // builder pass is cheap (just clause-array push), but is not zero
  // per render — hoist the callback if the hook is hot-path.
  const wire = normalizePredicateArg<T>(where);
  const predicateKey = stableKey(wire);
  const predicateRef = useRef<PredicateArg<T>>(where);
  predicateRef.current = where;
  const orderKey = order === undefined ? "" : stableKey(order);
  const orderRef = useRef<OrderSpec<T> | undefined>(order);
  orderRef.current = order;

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const controller = new AbortController();
    setState((prev) => (prev.status === "loading" ? prev : { status: "loading" }));
    void (async () => {
      try {
        let q = client.table<T>(table).where(predicateRef.current);
        if (orderRef.current !== undefined) {
          q = q.order(orderRef.current);
        }
        if (consistency !== undefined) {
          q = q.consistency(consistency);
        }
        const next = await q.all({ signal: controller.signal });
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
  }, [client, table, predicateKey, orderKey, consistency, tick, enabled]);

  return state;
};
