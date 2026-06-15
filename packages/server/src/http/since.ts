/**
 * Long-poll `GET /v1/since` handler core. Two exports:
 *
 *  - {@link longPollSince} — the long-poll itself. Fast path first;
 *    if `listEventsSince` already sees events, return immediately.
 *    Otherwise race a poll loop against a 25 s wall-clock timeout and
 *    return either the next batch of events or
 *    `{ events: [], next_cursor: <same> }` ("nothing changed within
 *    the budget").
 *  - {@link listEventsSince} — one poll cycle. Reads `current.json`,
 *    validates the caller's cursor against `log_seq_start`, lists the
 *    log keys strictly-greater than the cursor's key, GETs each body,
 *    and returns the parsed `LogEntry`s in causal order.
 *
 * The handler is wired into the Hono router (`router.ts`); the
 * router itself owns request parsing and error → HTTP mapping. This
 * module owns the I/O + cursor semantics.
 *
 * Cost model. While a long-poll connection is active the per-poll
 * cost is one `Storage.get` of `current.json` plus one `Storage.get`
 * per log entry yielded. An idle reader (no new entries) pays one
 * Class A op per inner poll; with the production defaults
 * (25 s / 1 s) that is 25 ops per active connection. The
 * `< 1 Class A op / writer / hour` cost-model bound (see
 * `docs/spec/sync-protocol.md`) is for an *idle* reader — i.e. a
 * client that is *not* currently holding a long-poll open.
 * Subscribers paying for real-time-ish delivery are by definition
 * non-idle.
 */

import {
  type BaerlyConfig,
  BaerlyError,
  COUNT_BIT_WIDTH,
  type LogEntry,
  logSeqStartOf,
  lsnParts,
} from "@baerly/protocol";
import type { Db } from "../db.ts";
import type { SinceResponse } from "../contract.ts";

/**
 * Validation regex for an opaque LSN cursor. Matches the shape minted
 * by `Writer.commit` (see `packages/server/src/writer.ts`) and described
 * on {@link LogEntry.lsn} — `<base32-time>_<session>_<seq>` where
 * base-32 is `[0-9a-v]` and the trailing seq is a fixed-width token.
 *
 * The seq width (`{11}`) is `Math.ceil(COUNT_BIT_WIDTH / 5)` chars, derived
 * automatically from the canonical `COUNT_BIT_WIDTH` constant in
 * `packages/protocol/src/constants.ts` via the `SEQ_CHARS` computed
 * constant below — no manual update needed when `COUNT_BIT_WIDTH` changes.
 * Currently: `Math.ceil(53 / 5) = 11`.
 */
// COUNT_BIT_WIDTH is 53; Math.ceil(53 / 5) = 11.
const SEQ_CHARS = Math.ceil(COUNT_BIT_WIDTH / 5); // 11
const LSN_RE = new RegExp(`^[0-9a-v]+_[0-9a-v]+_[0-9a-v]{${SEQ_CHARS}}$`);

/**
 * Hard cap on log entries returned in a single poll cycle. 1024 is
 * comfortably above the largest expected per-poll batch under the
 * production 1 s poll interval and bounds the worst-case memory
 * footprint of the parsed-JSON array on a hostile workload.
 */
const DEFAULT_MAX_EVENTS = 1024;

/**
 * Default 25 s long-poll budget. CF Workers cap fetch CPU at 30 s on
 * the free plan; 25 s leaves slack for header serialization plus the
 * platform's bookkeeping. Node / Bun / Deno have no comparable cap,
 * but the budget is still useful as a connection-cycling hint for
 * upstream load balancers (most idle-connection timeouts are 30-60 s).
 *
 * Per-request override is via the `timeoutMs` field on
 * {@link LongPollSinceOptions} (plumbed from `sinceTimeoutMs` on
 * `CreateRouterOptions` and both Node + Cloudflare adapters).
 */
const DEFAULT_TIMEOUT_MS = 25_000;

/**
 * Default 1 s inner-poll interval. 25 polls × 1 list = 25 Class A
 * ops per active long-poll connection. See module docstring for the
 * cost-model trade-off.
 *
 * Per-request override is via the `pollIntervalMs` field on
 * {@link LongPollSinceOptions} (plumbed from `sincePollIntervalMs`
 * on `CreateRouterOptions` and both Node + Cloudflare adapters).
 */
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface LongPollSinceOptions {
  readonly db: Db<BaerlyConfig>;
  readonly collection: string;
  /** Opaque cursor; empty string = from `log_seq_start`. */
  readonly cursor: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
}

export interface ListEventsSinceOptions {
  readonly db: Db<BaerlyConfig>;
  readonly collection: string;
  /** Opaque cursor; empty string = from `log_seq_start`. */
  readonly cursor: string;
  readonly signal?: AbortSignal;
}

/**
 * Long-poll wrapper around {@link listEventsSince}. Returns as soon
 * as the first non-empty poll lands, or when the wall-clock timeout
 * elapses (whichever comes first). On timeout the response is
 * `{ events: [], next_cursor: <same> }` — shipped as `200`, not `304`,
 * because the response body carries the unchanged cursor the client
 * needs for the next poll cycle.
 *
 * @throws BaerlyError{code:"SchemaError"} — invalid cursor shape, or
 *   the cursor references a log entry that has been folded into a
 *   snapshot and GC'd.
 */
export async function longPollSince(opts: LongPollSinceOptions): Promise<SinceResponse> {
  const { db, collection, cursor, signal } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // Up-front cursor-shape validation. `listEventsSince` also checks,
  // but doing it here short-circuits the fast-path read on bad input.
  if (cursor.length > 0 && !LSN_RE.test(cursor)) {
    throw new BaerlyError(
      "SchemaError",
      `cursor: invalid shape (expected an lsn returned by a prior SinceResponse); got ${JSON.stringify(cursor)}`,
    );
  }

  // Fast path: the first poll already sees new events.
  const initial = await listEventsSince({ db, collection, cursor, signal });
  if (initial.length > 0) {
    return { events: initial, next_cursor: initial[initial.length - 1]!.lsn };
  }

  // No events yet. Race a timeout against a polling loop.
  const start = Date.now();
  const deadline = start + timeoutMs;

  return new Promise<SinceResponse>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;

    const cleanup = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    };

    const settleResolve = (value: SinceResponse): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (err: unknown): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    };

    function onAbort(): void {
      // Treat client disconnect as "no events, same cursor" — the
      // socket is gone anyway; the resolve is a no-op for response
      // serialization but keeps the promise from leaking.
      settleResolve({ events: [], next_cursor: cursor });
    }

    if (signal !== undefined) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const tick = async (): Promise<void> => {
      if (settled) {
        return;
      }
      try {
        const events = await listEventsSince({ db, collection, cursor, signal });
        if (settled) {
          return;
        }
        if (events.length > 0) {
          settleResolve({ events, next_cursor: events[events.length - 1]!.lsn });
          return;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          settleResolve({ events: [], next_cursor: cursor });
          return;
        }
        const delay = Math.min(pollIntervalMs, remaining);
        timer = setTimeout(() => {
          void tick();
        }, delay);
      } catch (error) {
        settleReject(error);
      }
    };

    // First tick scheduled after `pollIntervalMs` (the initial fast
    // path already covered "events present at t=0"). Cap by the
    // remaining deadline so an early-cutoff tester with
    // `timeoutMs < pollIntervalMs` still resolves on time.
    timer = setTimeout(
      () => {
        void tick();
      },
      Math.min(pollIntervalMs, timeoutMs),
    );
  });
}

/**
 * One poll cycle: read `current.json`, derive the `seq` range to
 * scan from the cursor's embedded seq, GET each log entry by `seq`,
 * return the parsed `LogEntry`s in causal order.
 *
 * On-bucket log keys are `log/<seq>.json` — the same shape
 * `compactor` / `gc` / `rebuild-index` walk. Iterating
 * `[startSeq, endSeq)` and GET-ing each key directly avoids the
 * lex-`startAfter` hazard on integer filenames (`10.json` sorts
 * before `2.json` lex) and gives us the global causal ordering for
 * free — `seq` is monotonic across writer sessions.
 *
 * No `current.json` yet → `[]` (clients can poll a not-yet-existing
 * collection without erroring). Cursor inside `[0, log_seq_start)` →
 * `BaerlyError{code:"SchemaError"}`.
 */
export async function listEventsSince(opts: ListEventsSinceOptions): Promise<LogEntry[]> {
  const { db, collection, cursor, signal } = opts;

  if (cursor.length > 0 && !LSN_RE.test(cursor)) {
    throw new BaerlyError(
      "SchemaError",
      `cursor: invalid shape (expected an lsn returned by a prior SinceResponse); got ${JSON.stringify(cursor)}`,
    );
  }

  const read = await db.getCurrentJson(collection, signalOpt(signal));
  if (read === null) {
    // No collection provisioned yet. Clients polling for a collection that
    // doesn't exist see an empty stream, NOT an error.
    return [];
  }
  const logSeqStart = logSeqStartOf(read.json);
  // End bound is the DISCOVERED tail (probe past a stale-low hint).
  // The GET loop below 404-tolerates misses, so over-bounding is safe.
  const tail = await db.probeLogTail(collection, read.json.tail_hint, signalOpt(signal));

  // Derive the seq range to scan. Empty cursor → start at
  // `log_seq_start` (the first un-snapshotted entry). Non-empty
  // cursor → start at `cursorSeq + 1`. A cursor whose seq is below
  // `log_seq_start` references an entry the compactor has folded
  // into the snapshot and the GC sweep has deleted; the client must
  // re-bootstrap from a snapshot read before resuming.
  let startSeq: number;
  if (cursor.length === 0) {
    startSeq = logSeqStart;
  } else {
    const cursorSeq = lsnParts(cursor).seq;
    if (cursorSeq < logSeqStart) {
      throw new BaerlyError(
        "SchemaError",
        `cursor ${JSON.stringify(cursor)} points to a log entry that has been folded into a snapshot (log_seq_start=${logSeqStart}); re-bootstrap from a snapshot read before resuming`,
      );
    }
    startSeq = cursorSeq + 1;
  }

  // Cap the range at the discovered `tail` (no entries past the tail
  // exist) and at `DEFAULT_MAX_EVENTS` (hard ceiling per the module
  // docstring).
  const endSeq = Math.min(tail, startSeq + DEFAULT_MAX_EVENTS);

  // Sequential GETs (NOT Promise.all). Long-poll is latency-bound,
  // per-poll batch is typically 0-10 entries, sequential keeps
  // memory bounded under pathological workloads.
  const entries: LogEntry[] = [];
  for (let s = startSeq; s < endSeq; s++) {
    const entry = await db.getLogEntry(collection, s, signalOpt(signal));
    if (entry === null) {
      // Race: the GC sweeper deleted this entry between
      // `getCurrentJson` and the GET. Skip; don't error.
      continue;
    }
    entries.push(entry);
  }

  return entries;
}

/** Pack an optional `signal` into the `{ signal? }` shape callers expect. */
const signalOpt = (signal: AbortSignal | undefined): { signal?: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };
