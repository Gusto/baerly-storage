/**
 * Tolerant forward-probe for the true committed log tail. The strict
 * `[log_seq_start, hint)` range is dense (a hole is corruption, owned
 * by `walkLogRange`); this owns only the tolerant `[hint, ∞)` probe,
 * where `hint` is a lower bound — the real tail may sit at or past it.
 */

import {
  type LogEntry,
  type Storage,
  BaerlyError,
  decodeJsonBytes,
  LOG_FORWARD_PROBE_CAP,
  logObjectKey,
} from "@baerly/protocol";

/**
 * Discover the true committed tail and fold entries in `[hint, tail)`.
 * `tail` is the first empty seq (>= hint); `entries` are the
 * LogEntries in `[hint, tail)` in seq order. `cap` bounds the walk.
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
    const key = logObjectKey(logPrefix, seq);
    const got = await storage.get(key, getOpts);
    if (got === null) {
      return { tail: seq, entries };
    }
    try {
      entries.push(decodeJsonBytes<LogEntry>(got.body));
    } catch (error) {
      // A malformed body at an occupied slot is a protocol violation —
      // surface it as InvalidResponse (the same code readLogEntry uses)
      // rather than a raw SyntaxError leaking out of the probe.
      throw new BaerlyError(
        "InvalidResponse",
        `probeTailFrom: malformed log entry at ${key}: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
  return { tail: hint + cap, entries };
};

/**
 * First empty log seq at/after `hint` — the slot a new commit creates —
 * found by galloping search (`O(log gap)` GETs vs `probeTailFrom`'s
 * `O(gap)`). Used by the writer's per-commit tail-find, where `tail_hint`
 * can lag the true tail. Position only; no bodies.
 *
 * PRECONDITION: occupancy MUST be a dense prefix from `hint` (galloping
 * assumes monotone occupied→empty; a hole ABOVE `hint` would be skipped
 * and the gallop could return a tail past live entries). Contrast
 * `probeTailFrom`, which stops at the first 404 and is hole-tolerant.
 */
export const findLogTail = async (
  storage: Storage,
  logPrefix: string,
  hint: number,
  opts?: { signal?: AbortSignal },
): Promise<number> => {
  const getOpts = opts?.signal !== undefined ? { signal: opts.signal } : undefined;
  const exists = async (seq: number): Promise<boolean> =>
    (await storage.get(logObjectKey(logPrefix, seq), getOpts)) !== null;
  if (!(await exists(hint))) {
    return hint;
  }
  // Gallop to bracket the tail in `(lo, hi]` (lo occupied, hi empty).
  let lo = hint;
  let step = 1;
  let hi = hint + step;
  while (await exists(hi)) {
    lo = hi;
    step *= 2;
    hi = lo + step;
    if (step > LOG_FORWARD_PROBE_CAP) {
      throw new BaerlyError(
        "Internal",
        `findLogTail: galloping probe exceeded ${LOG_FORWARD_PROBE_CAP} from hint ${hint} on ${logPrefix}`,
      );
    }
  }
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (await exists(mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
};
