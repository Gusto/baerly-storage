/**
 * Tolerant forward-probe for the true committed log tail. The strict
 * `[log_seq_start, hint)` range is dense (a hole is corruption, owned
 * by `walkLogRange`); this owns only the tolerant `[hint, ∞)` probe,
 * where `hint` is a lower bound — the real tail may sit at or past it.
 */

import {
  type LogEntry,
  type RequestPool,
  type Storage,
  BaerlyError,
  currentRequestLedger,
  decodeJsonBytes,
  LOG_FORWARD_PROBE_CAP,
  logObjectKey,
} from "@baerly/protocol";

/** A forward probe's slot cap, and which bound set it. */
export interface ForwardProbeCap {
  /** Slots the probe may GET. */
  readonly slots: number;
  /**
   * `"request"` when the active invocation's request ledger set the cap:
   * exhausting it is a capacity refusal (`CapacityExceeded`), the whole
   * answer refused. `"runaway"` when {@link LOG_FORWARD_PROBE_CAP} did:
   * exhausting it is the `Internal` runaway alarm.
   */
  readonly bound: "request" | "runaway";
}

/**
 * The forward-probe cap for a read in the active invocation:
 * `min(LOG_FORWARD_PROBE_CAP, ledger remaining on pool)`. Every read path
 * that probes past `tail_hint` (collection reads, `/v1/since`) sizes its
 * probe here, so a probe never plans more GETs than the request can
 * issue, and running out is a capacity refusal rather than the runaway
 * alarm. Without a ledger (or with one that never refuses, as on Node) the
 * runaway cap applies.
 */
export const forwardProbeCap = (pool: RequestPool = "internal"): ForwardProbeCap => {
  const remaining = currentRequestLedger()?.remaining(pool) ?? Infinity;
  return remaining < LOG_FORWARD_PROBE_CAP
    ? { slots: Math.max(0, remaining), bound: "request" }
    : { slots: LOG_FORWARD_PROBE_CAP, bound: "runaway" };
};

export type TailProbeChunk =
  | {
      readonly kind: "exact";
      readonly tail: number;
      readonly entries: LogEntry[];
      readonly complete: boolean;
    }
  | {
      readonly kind: "at-least";
      readonly lowerBound: number;
      readonly entries: LogEntry[];
      readonly complete: boolean;
    };

/**
 * Probe a bounded chunk of committed entries from `hint`. An occupied
 * chunk certifies only that the tail is at or past its exclusive bound.
 * Decode failures throw by default. With tolerant occupancy probing,
 * malformed slots remain occupied, `complete` becomes false, and probing
 * continues to the first missing slot or cap.
 */
export const probeTailChunk = async (
  storage: Storage,
  logPrefix: string,
  hint: number,
  opts?: {
    signal?: AbortSignal;
    cap?: number;
    tolerateMalformed?: boolean;
    /** Called with each occupied slot's stored body length before it is decoded; may throw to stop the probe. */
    onBody?: (bytes: number) => void;
  },
): Promise<TailProbeChunk> => {
  const cap = opts?.cap ?? LOG_FORWARD_PROBE_CAP;
  const getOpts = opts?.signal !== undefined ? { signal: opts.signal } : undefined;
  const entries: LogEntry[] = [];
  let complete = true;
  for (let i = 0; i < cap; i++) {
    const seq = hint + i;
    const key = logObjectKey(logPrefix, seq);
    const got = await storage.get(key, getOpts);
    if (got === null) {
      return { kind: "exact", tail: seq, entries, complete };
    }
    opts?.onBody?.(got.body.byteLength);
    try {
      entries.push(decodeJsonBytes<LogEntry>(got.body));
    } catch (error) {
      if (opts?.tolerateMalformed === true) {
        complete = false;
        continue;
      }
      // A malformed body at an occupied slot is a protocol violation —
      // surface it as InvalidResponse (the same code readLogEntry uses)
      // rather than a raw SyntaxError leaking out of the probe.
      throw new BaerlyError(
        "InvalidResponse",
        `probeTailChunk: malformed log entry at ${key}: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
  return { kind: "at-least", lowerBound: hint + cap, entries, complete };
};

/**
 * Discover the true committed tail and fold entries in `[hint, tail)`.
 * `tail` is the first empty seq (>= hint); `entries` are the
 * LogEntries in `[hint, tail)` in seq order.
 *
 * Retention precondition: derive `hint` from a fresh `current.json` read
 * and require `hint >= current.log_seq_start`; the usual start is
 * `Math.max(current.log_seq_start, current.tail_hint)`. The floor and hint
 * must come from that same manifest read. Entries below the floor may
 * already be reclaimed, and this probe interprets the first missing slot
 * as the tail. A sub-floor hint may therefore report a false tail and omit
 * later live entries. This storage-level helper intentionally accepts no
 * manifest and cannot enforce the precondition for its caller.
 *
 * `cap` bounds the walk; exhausting it THROWS `Internal` (never silently
 * truncates) — see the cap-exhaustion comment below.
 */
export const probeTailFrom = async (
  storage: Storage,
  logPrefix: string,
  hint: number,
  opts?: { signal?: AbortSignal; cap?: number },
): Promise<{ tail: number; entries: LogEntry[] }> => {
  const result = await probeTailChunk(storage, logPrefix, hint, opts);
  if (result.kind === "exact") {
    return { tail: result.tail, entries: result.entries };
  }
  // Cap exhausted without hitting a 404 — the true tail is past `cap`.
  // Returning `hint+cap` here would silently truncate every downstream
  // read (since.ts / query.ts / export / rebuild-index), so we
  // THROW instead, mirroring `findLogTail`'s cap-exhaustion guard. With
  // the maintenance tick keeping `tail_hint` within
  // `MAINTENANCE_TAIL_HINT_REFRESH_WRITES` of the true tail (HR-2), this
  // is a pure runaway alarm — a >cap gap means maintenance is
  // broken/disabled (a graduation/operator concern), never normal
  // operation. No partial-accept escape hatch: no caller legitimately
  // needs to walk past the cap.
  throw new BaerlyError(
    "Internal",
    `probeTailFrom: forward probe exceeded ${opts?.cap ?? LOG_FORWARD_PROBE_CAP} from hint ${hint} on ${logPrefix}`,
  );
};

/**
 * {@link probeTailFrom} for a read, capped by {@link forwardProbeCap}. When
 * the request ledger set the cap and every capped slot is occupied, the
 * tail is past what this request can probe: throws `refusal()` (a whole
 * `CapacityExceeded` answer) rather than the runaway alarm. `onBody` sees
 * each stored body length before decode, as on {@link probeTailChunk}.
 *
 * @throws the `refusal()` error when the ledger cap is exhausted.
 * @throws BaerlyError code="Internal" when {@link LOG_FORWARD_PROBE_CAP} is.
 */
export const probeReadTail = async (
  storage: Storage,
  logPrefix: string,
  hint: number,
  opts: {
    readonly refusal: () => BaerlyError;
    readonly pool?: RequestPool;
    readonly onBody?: (bytes: number) => void;
    readonly signal?: AbortSignal;
  },
): Promise<{ tail: number; entries: LogEntry[] }> => {
  const cap = forwardProbeCap(opts.pool);
  const result = await probeTailChunk(storage, logPrefix, hint, {
    cap: cap.slots,
    ...(opts.onBody !== undefined && { onBody: opts.onBody }),
    ...(opts.signal !== undefined && { signal: opts.signal }),
  });
  if (result.kind === "exact") {
    return { tail: result.tail, entries: result.entries };
  }
  if (cap.bound === "request") {
    throw opts.refusal();
  }
  throw new BaerlyError(
    "Internal",
    `probeReadTail: forward probe exceeded ${cap.slots} from hint ${hint} on ${logPrefix}`,
  );
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
