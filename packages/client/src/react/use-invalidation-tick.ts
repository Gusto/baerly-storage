import { useEffect, useRef, useState } from "react";
import type { LogEntry } from "@baerly/protocol";
import type { BaerlyClient } from "../client.ts";

export interface UseInvalidationTickOptions {
  /**
   * Initial cursor. Pass `""` (default) to replay from `log_seq_start`.
   * Pass a previously-observed `next_cursor` to resume.
   */
  readonly since?: string;
  /** When `false`, the hook does not poll. Default `true`. */
  readonly enabled?: boolean;
  /**
   * Optional per-event filter. The tick only advances when a batch
   * contains at least one event for which `matchEvent(event)` returns
   * `true`. Default: any non-empty batch advances the tick.
   *
   * Reference-stable across renders is expected (e.g. wrap in
   * `useCallback`). Identity changes do not restart the poll loop.
   */
  readonly matchEvent?: (event: LogEntry) => boolean;
}

/**
 * Subscribes to `/v1/since` for `table` and returns a monotonically
 * increasing integer that advances whenever the server reports new
 * events. Use the returned value as a `useEffect` dep to invalidate
 * downstream reads.
 *
 * - Idle long-poll cycles do not advance the tick (empty batch + same
 *   cursor — see {@link UseInvalidationTickOptions.matchEvent} to
 *   narrow further).
 * - Transient `/v1/since` errors are retried with a 1-second backoff.
 *   Errors are not exposed; if the failure is persistent the
 *   downstream read (whose error path you should render) will see it
 *   too.
 * - The cursor is preserved across `enabled` toggles. Flipping
 *   `enabled: false → true` resumes from the last seen cursor; it
 *   does not replay history from `since`.
 *
 * Most UI consumers want {@link useLiveQuery} or
 * {@link useLiveDocument} instead — those wrap this hook and present
 * a declarative row / row-set.
 *
 * @example
 * ```tsx
 * // Manual cache: refetch a custom aggregate whenever the log advances.
 * const tick = useInvalidationTick(client, "tickets");
 * useEffect(() => {
 *   void refetchAggregate();
 * }, [tick]);
 * ```
 */
export const useInvalidationTick = (
  client: BaerlyClient,
  table: string,
  opts: UseInvalidationTickOptions = {},
): number => {
  const { since = "", enabled = true, matchEvent } = opts;
  const [tick, setTick] = useState<number>(0);

  // Cursor lives in a ref so the poll loop resumes across `enabled`
  // toggles. The previous `useChanges` implementation seeded
  // `currentCursor` from `since` inside the effect — when the effect
  // re-ran (e.g. `enabled` flipped false → true) the loop replayed
  // history from scratch. The ref persists across effect re-runs and
  // is only ever set forward.
  const cursorRef = useRef<string>(since);

  // Matchers can be inline arrow functions whose identity churns every
  // render. Hold the latest one in a ref so the loop reads
  // `.current` rather than capturing a stale closure, without making
  // `matchEvent` part of the effect's dep list (which would restart
  // the poll every render).
  const matchEventRef = useRef<typeof matchEvent>(matchEvent);
  matchEventRef.current = matchEvent;

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

    const loop = async (): Promise<void> => {
      while (!stopped.current) {
        try {
          const res = await client.since({
            table,
            cursor: cursorRef.current,
            signal: controller.signal,
          });
          if (stopped.current) {
            return;
          }
          // Idle no-op: an empty batch with an unchanged cursor
          // carries no information. Skip the tick bump so consumer
          // effects don't re-fire on the 25-second long-poll budget.
          if (res.events.length > 0 || res.next_cursor !== cursorRef.current) {
            cursorRef.current = res.next_cursor;
            const matcher = matchEventRef.current;
            const matched =
              matcher === undefined ? res.events.length > 0 : res.events.some(matcher);
            if (matched) {
              setTick((t) => t + 1);
            }
          }
        } catch (error) {
          if (stopped.current || (error instanceof DOMException && error.name === "AbortError")) {
            return;
          }
          // 1-second backoff on error. Don't accelerate — the server
          // mostly recovers within one budget cycle anyway and a tight
          // retry loop just burns mobile battery. Errors are not
          // exposed: the downstream read (whose error UI you render)
          // will see the same failure on its next fetch.
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };
    void loop();

    return (): void => {
      stopped.current = true;
      controller.abort();
    };
  }, [client, table, enabled]);

  return tick;
};
