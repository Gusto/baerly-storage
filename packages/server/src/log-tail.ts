/**
 * Tolerant forward-probe for the true committed log tail.
 *
 * The strict `[log_seq_start, hint)` range is dense-by-construction —
 * a hole there is corruption, owned by the caller (`walkLogRange` in
 * `log-walk.ts`, which THROWS on a missing entry). THIS module owns
 * only the tolerant `[hint, ∞)` probe, where `tail_hint` is a
 * non-authoritative lower bound: the real tail may sit at or past it.
 */

import {
  type LogEntry,
  type Storage,
  decodeJsonBytes,
  LOG_FORWARD_PROBE_CAP,
  logObjectKey,
} from "@baerly/protocol";

/**
 * Discover the true committed tail and fold entries in `[hint, tail)`.
 *
 * @returns `{ tail, entries }` — `tail` is the first empty seq (>= hint);
 *   `entries` are the LogEntries in `[hint, tail)` in seq order.
 *
 * `cap` bounds the walk: on `cap` consecutive present entries, returns
 * `{ tail: hint + cap, entries }` (a bounded walk, not corruption).
 */
export const probeTailFrom = async (
  storage: Storage,
  logPrefix: string,
  hint: number,
  opts?: { signal?: AbortSignal; cap?: number },
): Promise<{ tail: number; entries: LogEntry[] }> => {
  const cap = opts?.cap ?? LOG_FORWARD_PROBE_CAP;
  const getOpts = opts?.signal !== undefined ? { signal: opts.signal } : undefined;
  const entries: LogEntry[] = [];
  for (let i = 0; i < cap; i++) {
    const seq = hint + i;
    const got = await storage.get(logObjectKey(logPrefix, seq), getOpts);
    if (got === null) {
      return { tail: seq, entries };
    }
    entries.push(decodeJsonBytes<LogEntry>(got.body));
  }
  return { tail: hint + cap, entries };
};
