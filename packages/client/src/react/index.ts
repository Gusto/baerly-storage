import { useEffect, useRef, useState } from "react";
import type { LogEntry } from "@baerly/protocol";
import type { BaerlyClient } from "../client.ts";

export interface UseChangesOptions {
  /**
   * Initial cursor. Pass `""` (default) to receive every event from
   * `log_seq_start` forward. Pass a previously-returned
   * `next_cursor` to resume.
   */
  readonly since?: string;
  /**
   * Optional. When `false`, the hook does not start polling. Useful
   * for SSR / suspense boundaries. Default `true`.
   */
  readonly enabled?: boolean;
}

export interface UseChangesResult {
  /** Most recent batch of events. Empty until the first poll lands. */
  readonly events: ReadonlyArray<LogEntry>;
  /** Cursor to pass on the next call. */
  readonly cursor: string;
  /** `true` while a poll is in flight. */
  readonly polling: boolean;
  /** Most recent error, if any. Cleared on the next successful poll. */
  readonly error: Error | undefined;
}

/**
 * Subscribe to `/v1/since` long-poll for a table. Each successful
 * poll updates `events` (the batch from that poll) and `cursor`
 * (the server's `next_cursor`). On error, `error` is set and the
 * hook retries after a 1-second backoff. On unmount the hook
 * aborts any in-flight request.
 *
 * The hook does NOT accumulate events across polls — each render
 * sees the latest batch only. Consumers that need an accumulating
 * feed should `useReducer` the events themselves, deduping on `lsn`.
 *
 * @example
 * ```tsx
 * const { events, cursor } = useChanges(client, "tickets");
 * useEffect(() => {
 *   for (const e of events) {
 *     if (e.op === "I" || e.op === "U") refreshRow(e.doc_id!);
 *     if (e.op === "D") removeRow(e.doc_id!);
 *   }
 * }, [events]);
 * ```
 */
export const useChanges = (
  client: BaerlyClient,
  table: string,
  opts: UseChangesOptions = {},
): UseChangesResult => {
  const { since = "", enabled = true } = opts;
  const [events, setEvents] = useState<ReadonlyArray<LogEntry>>([]);
  const [cursor, setCursor] = useState<string>(since);
  const [polling, setPolling] = useState<boolean>(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  // Mount-time ref so the polling loop can read the latest cursor
  // without re-issuing on every render. Mirrors the pattern used in
  // React's docs for "long-running effects."
  const cursorRef = useRef<string>(since);
  cursorRef.current = cursor;

  useEffect(() => {
    if (!enabled) return undefined;
    const controller = new AbortController();
    // `stopped` lives in a single-cell ref so the loop reads it
    // through `.current` — that's what the `useEffect` cleanup
    // mutates, and oxlint's `no-unmodified-loop-condition` cannot
    // see across the closure capture without it.
    const stopped = { current: false };

    const loop = async (): Promise<void> => {
      while (!stopped.current) {
        setPolling(true);
        try {
          const res = await client.since({
            table,
            cursor: cursorRef.current,
            signal: controller.signal,
          });
          if (stopped.current) return;
          setEvents(res.events);
          setCursor(res.next_cursor);
          setError(undefined);
        } catch (e) {
          if (stopped.current || (e instanceof DOMException && e.name === "AbortError")) {
            return;
          }
          setError(e instanceof Error ? e : new Error(String(e)));
          // 1-second backoff on error. Don't accelerate — the server
          // will mostly recover within one budget cycle anyway and a
          // tight retry loop just burns mobile battery.
          await new Promise((r) => setTimeout(r, 1000));
        } finally {
          setPolling(false);
        }
      }
    };
    void loop();

    return (): void => {
      stopped.current = true;
      controller.abort();
    };
    // Deliberately exclude `cursor` from the deps array — we read it
    // through `cursorRef` to keep the loop alive across cursor
    // advances.
  }, [client, table, enabled]);

  return { events, cursor, polling, error };
};
