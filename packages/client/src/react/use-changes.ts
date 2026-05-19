import { useEffect, useState } from "react";
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
  /** Most recent non-empty batch of events. Empty until the first non-empty poll lands. */
  readonly events: ReadonlyArray<LogEntry>;
  /** Cursor to pass on the next call. Advances only when new events arrive. */
  readonly cursor: string;
  /** `true` while a poll is in flight. */
  readonly polling: boolean;
  /** Most recent error, if any. Cleared on the next successful poll. */
  readonly error: Error | undefined;
}

/**
 * Low-level escape hatch for consuming the raw `/v1/since` event
 * stream. **You almost certainly want `useLiveQuery` or
 * `useLiveDocument` instead** — those wrap this hook and present a
 * declarative live row / document, with no `useEffect` deps array to
 * get wrong.
 *
 * Subscribes to `/v1/since` for `table`. Each poll that returns new
 * events updates `events` (the batch from that poll) and `cursor`
 * (the server's `next_cursor`). **Idle polls (empty batch, unchanged
 * cursor) are dropped** — they do not re-render. On error, `error`
 * is set and the hook retries after a 1-second backoff. On unmount
 * the hook aborts any in-flight request.
 *
 * The hook does NOT accumulate events across polls — each render
 * sees the latest non-empty batch only. Consumers that need an
 * accumulating feed should `useReducer` the events themselves,
 * deduping on `lsn`.
 *
 * @example
 * ```tsx
 * // Apply per-event updates to a row store. Empty batches never fire
 * // this effect (the hook drops them), so the loop is always
 * // meaningful work.
 * const { events } = useChanges(client, "tickets");
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
  const [pollError, setPollError] = useState<Error | undefined>(undefined);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const controller = new AbortController();
    // `stopped` lives in a single-cell ref so the loop reads it
    // through `.current` — that's what the `useEffect` cleanup
    // mutates, and oxlint's `no-unmodified-loop-condition` cannot
    // see across the closure capture without it.
    const stopped = { current: false };
    // Loop-local cursor mirror. We track the latest cursor here
    // rather than reading from React state because state updates
    // settle on the next render, while the next `since` call fires
    // immediately after the await — a `useRef` updated on render
    // would lag the loop by one cycle. The local variable is
    // updated synchronously the same moment we call `setCursor`,
    // so the idle no-op comparison is always correct.
    let currentCursor = since;

    const loop = async (): Promise<void> => {
      while (!stopped.current) {
        setPolling(true);
        try {
          const res = await client.since({
            table,
            cursor: currentCursor,
            signal: controller.signal,
          });
          if (stopped.current) {
            return;
          }
          // Idle no-op: an empty batch with an unchanged cursor
          // carries no information. Skipping the `setEvents` /
          // `setCursor` calls here prevents a re-render and keeps
          // consumers' `[events]` / `[cursor]` deps stable across
          // long-poll budget cycles. Without this, every 25 s
          // timeout would invalidate downstream effects.
          if (res.events.length > 0 || res.next_cursor !== currentCursor) {
            currentCursor = res.next_cursor;
            setEvents(res.events);
            setCursor(res.next_cursor);
          }
          setPollError(undefined);
        } catch (error) {
          if (stopped.current || (error instanceof DOMException && error.name === "AbortError")) {
            return;
          }
          setPollError(error instanceof Error ? error : new Error(String(error)));
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
  }, [client, table, enabled, since]);

  return { events, cursor, polling, error: pollError };
};
