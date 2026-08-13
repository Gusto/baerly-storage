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
 *    validates the caller's cursor against `log_seq_start`, discovers
 *    the true tail by forward-probe, GETs each body by integer `seq`,
 *    and returns the parsed `LogEntry`s in causal order.
 *
 * The handler is wired into the Hono router (`router.ts`); the
 * router itself owns request parsing and error → HTTP mapping. This
 * module owns the I/O + cursor semantics.
 *
 * Cost model. While a long-poll connection is active the per-poll
 * cost is one `Storage.get` of `current.json`, the tail
 * forward-probe GETs, plus one `Storage.get` per log entry yielded.
 * These are Class B ops, not Class A. The `< 1 Class A op / writer /
 * hour` cost-model bound (see `docs/spec/sync-protocol.md`) still
 * holds; active long-poll subscribers pay repeated Class B reads for
 * lower-latency delivery.
 */

import {
  type BaerlyConfig,
  BaerlyError,
  COUNT_BIT_WIDTH,
  formatCursor,
  type LogEntry,
  logSeqStartOf,
  lsnParts,
  NO_GENERATION,
  parseCursor,
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
 * Generation half of a cursor: lowercase hex as minted by
 * `mintGeneration`, or the `NO_GENERATION` sentinel for a manifest that
 * predates the field.
 */
const GENERATION_RE = /^(?:[0-9a-f]+|-)$/;

/**
 * Reject a malformed cursor before it reaches storage, and return its
 * decoded halves.
 *
 * Shape validation lives here rather than in the codec because the
 * codec is a protocol leaf with no opinion about which LSN dialect a
 * given build mints — `LSN_RE` is that opinion, and it is derived from
 * `COUNT_BIT_WIDTH`.
 */
const decodeCursor = (cursor: string): { generation: string; lsn: string } => {
  const parts = parseCursor(cursor);
  if (!GENERATION_RE.test(parts.generation) || !LSN_RE.test(parts.lsn)) {
    throw new BaerlyError(
      "SchemaError",
      `cursor: invalid shape (expected a cursor returned by a prior SinceResponse); got ${JSON.stringify(cursor)}`,
    );
  }
  return parts;
};

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
 * Default 1 s inner-poll interval. See module docstring for the
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
  if (cursor.length > 0) {
    decodeCursor(cursor);
  }

  // Fast path: the first poll already sees new events.
  const initial = await pollOnce({ db, collection, cursor, signal });
  if (initial.events.length > 0) {
    return { events: initial.events, next_cursor: nextCursor(initial) };
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
        const polled = await pollOnce({ db, collection, cursor, signal });
        if (settled) {
          return;
        }
        if (polled.events.length > 0) {
          settleResolve({ events: polled.events, next_cursor: nextCursor(polled) });
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
 * collection without erroring). Cursor inside `[0, log_seq_start)`, or
 * minted in a truncated generation → `BaerlyError{code:"SchemaError"}`.
 */
export async function listEventsSince(opts: ListEventsSinceOptions): Promise<LogEntry[]> {
  const polled = await pollOnce(opts);
  return polled.events;
}

/**
 * The body of {@link listEventsSince}, additionally surfacing the
 * manifest `generation` the poll read.
 *
 * `longPollSince` needs that generation to mint `next_cursor`, and
 * re-reading `current.json` to get it would add a Class A op to every
 * poll — the idle-reader cost bound this protocol is built around.
 * {@link listEventsSince} is public surface pinned by
 * `tests/integration/public-surface.test.ts`, so it keeps returning a
 * bare array and this internal variant carries the extra field.
 *
 * `generation` is `undefined` when the collection has no `current.json`
 * (no events either, so it is never consumed) or when the manifest
 * predates the field.
 */
async function pollOnce(
  opts: ListEventsSinceOptions,
): Promise<{ events: LogEntry[]; generation: string | undefined }> {
  const { db, collection, cursor, signal } = opts;

  const decoded = cursor.length > 0 ? decodeCursor(cursor) : undefined;

  const read = await db.getCurrentJson(collection, signalOpt(signal));
  if (read === null) {
    // No collection provisioned yet. Clients polling for a collection that
    // doesn't exist see an empty stream, NOT an error.
    return { events: [], generation: undefined };
  }
  const logSeqStart = logSeqStartOf(read.json);
  // End bound is the DISCOVERED tail (probe past a stale-low hint).
  // The GET loop below 404-tolerates misses, so over-bounding is safe.
  // Floor at `max(log_seq_start, tail_hint)` — same probe floor every
  // other consumer uses (the invariant `tail_hint >= log_seq_start`
  // holds, so this is consistency, not a behaviour change).
  const tail = await db.probeLogTail(
    collection,
    Math.max(logSeqStart, read.json.tail_hint),
    read.json,
    signalOpt(signal),
  );

  // Derive the seq range to scan. Empty cursor → start at
  // `log_seq_start` (the first un-snapshotted entry). Non-empty
  // cursor → start at `cursorSeq + 1`, after two rejections.
  let startSeq: number;
  if (decoded === undefined) {
    startSeq = logSeqStart;
  } else {
    const { generation, lsn } = decoded;
    // (1) Wrong generation. A seq identifies a `log/<seq>` slot, and
    // slots are REUSED: `restore --force` truncates and reseeds
    // `log_seq_start` to one past the highest surviving log object,
    // which can land below the old floor (the floor exemption —
    // invariant 12 in `docs/spec/sync-protocol.md`). A pre-restore
    // cursor would then clear check (2) below and resume into the new
    // generation, silently skipping every restored row beneath it —
    // gapped, not broken, which is the failure mode a sync client can't
    // detect for itself.
    //
    // Both spellings of "no generation" — a manifest predating the
    // field and a bare-LSN cursor predating the composite shape —
    // decode to `NO_GENERATION`, so this stays one comparison with no
    // fail-open branch. See the truth table in `sync-protocol.md`.
    const currentGeneration = read.json.generation ?? NO_GENERATION;
    if (generation !== currentGeneration) {
      throw new BaerlyError(
        "SchemaError",
        `cursor ${JSON.stringify(cursor)} was minted in a generation that no longer exists (the collection has been truncated and restored); re-bootstrap from a snapshot read before resuming`,
      );
    }
    // (2) Folded away. The entry is below the floor, so the compactor
    // folded it into the snapshot and the GC sweep deleted it.
    const cursorSeq = lsnParts(lsn).seq;
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
    const entry = await db.getLogEntry(collection, s, read.json, signalOpt(signal));
    if (entry === null) {
      // Race: the GC sweeper deleted this entry between
      // `getCurrentJson` and the GET. Skip; don't error.
      continue;
    }
    entries.push(entry);
  }

  return { events: entries, generation: read.json.generation };
}

/**
 * Mint the `next_cursor` for a poll that produced events: the last
 * entry's `lsn`, paired with the generation the poll read it under.
 *
 * Only called when `events` is non-empty, which is exactly when the
 * poll saw a `current.json` — so the generation here is the manifest's,
 * not a stand-in.
 */
const nextCursor = (polled: { events: LogEntry[]; generation: string | undefined }): string =>
  formatCursor(polled.generation, polled.events[polled.events.length - 1]!.lsn);

/** Pack an optional `signal` into the `{ signal? }` shape callers expect. */
const signalOpt = (signal: AbortSignal | undefined): { signal?: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };
