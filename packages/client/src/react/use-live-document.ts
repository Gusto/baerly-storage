import { useEffect, useRef, useState } from "react";
import type { JSONArraylessObject, Predicate } from "@baerly/protocol";
import type { BaerlyClient } from "../client.ts";
import { useChanges } from "./use-changes.ts";

export interface UseLiveDocumentOptions {
  /** When `false`, suspends both the initial read and the subscription. Default `true`. */
  readonly enabled?: boolean;
}

export interface UseLiveDocumentResult<T> {
  /**
   * Current document, or `undefined` if the row does not exist (a
   * server 404) or has not been read yet. `loading` discriminates
   * "not yet read" from "read and confirmed missing."
   */
  readonly row: T | undefined;
  /** `true` while the first read is in flight (cleared after first success). */
  readonly loading: boolean;
  /** Most recent read or subscription error. Cleared on the next successful read. */
  readonly error: Error | undefined;
}

/**
 * Declarative live document. Subscribes to `table` and re-reads
 * `.where({ _id: id }).first()` whenever a log event arrives whose
 * `doc_id` matches `id`. Events for unrelated rows do not trigger a
 * refetch.
 *
 * Idle long-poll cycles are dropped at the {@link useChanges} layer,
 * so a steady-state document costs zero reads.
 *
 * @example
 * ```tsx
 * const { row, loading, error } = useLiveDocument<Ticket>(client, "tickets", id);
 * if (error) return <p>Error: {error.message}</p>;
 * if (loading) return <p>Loading…</p>;
 * if (row === undefined) return <p>Not found.</p>;
 * return <h2>{row.title}</h2>;
 * ```
 */
export const useLiveDocument = <T extends JSONArraylessObject = JSONArraylessObject>(
  client: BaerlyClient,
  table: string,
  id: string,
  opts: UseLiveDocumentOptions = {},
): UseLiveDocumentResult<T> => {
  const { enabled = true } = opts;
  const [row, setRow] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(true);
  const [fetchError, setFetchError] = useState<Error | undefined>(undefined);

  const { events, error: pollError } = useChanges(client, table, { enabled });

  // Tick counter that advances iff a non-empty event batch contained
  // an op touching this `id`. The fetch effect depends on the tick,
  // so events for unrelated rows do not trigger a re-read. The
  // `lastSeenLsn` ref dedupes when a batch is re-presented (cannot
  // happen with the current useChanges semantics but is cheap to
  // guard against).
  const [matchTick, setMatchTick] = useState<number>(0);
  const lastSeenLsn = useRef<string>("");
  useEffect(() => {
    const last = events.findLast?.((e) => e.doc_id === id) ?? findLastMatch(events, id);
    if (last !== undefined && last.lsn !== lastSeenLsn.current) {
      lastSeenLsn.current = last.lsn;
      setMatchTick((t) => t + 1);
    }
  }, [events, id]);

  useEffect(() => {
    if (!enabled) {
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const next = await client
          .table<T>(table)
          .where({ _id: id } as Predicate<T>)
          .first();
        if (cancelled) {
          return;
        }
        setRow(next);
        setFetchError(undefined);
      } catch (error) {
        if (cancelled) {
          return;
        }
        setFetchError(error instanceof Error ? error : new Error(String(error)));
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [client, table, id, enabled, matchTick]);

  return { row, loading, error: fetchError ?? pollError };
};

// `Array.prototype.findLast` is only available on ES2023+ runtimes.
// Workerd and modern browsers / Node 20+ ship it; provide a tiny
// fallback for older test runners that intercept the prototype.
const findLastMatch = <U extends { doc_id?: string }>(
  arr: ReadonlyArray<U>,
  id: string,
): U | undefined => {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i]!.doc_id === id) {
      return arr[i];
    }
  }
  return undefined;
};
