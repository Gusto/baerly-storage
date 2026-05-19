import { useCallback, useEffect, useState } from "react";
import type { JSONArraylessObject, LogEntry, Predicate } from "@baerly/protocol";
import { useBaerlyClient } from "./provider.ts";
import { useInvalidationTick } from "./use-invalidation-tick.ts";

export interface UseLiveDocumentOptions {
  /** Table to read from. */
  readonly table: string;
  /** Document `_id` to subscribe to. */
  readonly id: string;
  /** When `false`, suspends both the initial read and the subscription. Default `true`. */
  readonly enabled?: boolean;
}

/**
 * Live document result. The `status` field discriminates the four
 * possible states — narrow on it to access `row` / `error` safely.
 *
 * - `"loading"` — the first read is in flight.
 * - `"ok"` — the most recent read returned a row; `row` is populated.
 * - `"missing"` — the most recent read confirmed no row exists for `id`.
 * - `"error"` — the most recent read failed; `error` is populated.
 */
export type UseLiveDocumentResult<T> =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly row: T }
  | { readonly status: "missing" }
  | { readonly status: "error"; readonly error: Error };

/**
 * Declarative live document. Subscribes to `table` and re-reads
 * `.where({ _id: id }).first()` whenever the server emits a log
 * event for `id`. Events for unrelated rows do not trigger a refetch.
 *
 * Idle long-poll cycles are dropped at the
 * {@link useInvalidationTick} layer, so a steady-state document
 * costs zero reads.
 *
 * @example
 * ```tsx
 * const result = useLiveDocument<Ticket>({ table: "tickets", id });
 * if (result.status === "loading") return <p>Loading…</p>;
 * if (result.status === "error") return <p>Error: {result.error.message}</p>;
 * if (result.status === "missing") return <p>Not found.</p>;
 * return <h2>{result.row.title}</h2>;
 * ```
 */
export const useLiveDocument = <T extends JSONArraylessObject = JSONArraylessObject>(
  opts: UseLiveDocumentOptions,
): UseLiveDocumentResult<T> => {
  const { table, id, enabled = true } = opts;
  const client = useBaerlyClient();
  const [state, setState] = useState<UseLiveDocumentResult<T>>({ status: "loading" });

  const matchEvent = useCallback((event: LogEntry): boolean => event.doc_id === id, [id]);
  const tick = useInvalidationTick({ table, enabled, matchEvent });

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
          .where({ _id: id } as Predicate<T>)
          .first({ signal: controller.signal });
        if (controller.signal.aborted) {
          return;
        }
        setState(next === undefined ? { status: "missing" } : { status: "ok", row: next });
      } catch (error) {
        // `AbortError` here only ever comes from our own
        // `controller.abort()` in the cleanup below — the effect
        // re-ran or the component unmounted. Surfacing it would
        // trigger a setState-after-unmount React warning and clobber
        // a still-valid result from the next effect run.
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
  }, [client, table, id, enabled, tick]);

  return state;
};
