/* eslint-disable no-underscore-dangle -- `_raw` is the locked public-symbol
   name for the Storage escape hatch on `Db`; the long-poll handler
   reaches through it to read `current.json` + log entries with the
   `app/<app>/tenant/<tenant>/` physical-prefix rewrite already applied. */

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
 * The handler is wired into the Hono router (`router.ts`) by ticket
 * 26; the router itself owns request parsing and error → HTTP mapping.
 * This module owns the I/O + cursor semantics.
 *
 * Cost model. While a long-poll connection is active the cost is
 * `ceil(timeoutMs / pollIntervalMs)` Class A ops per connection
 * (one `Storage.list` per inner poll, plus zero-or-more GETs when
 * events arrive). With the production defaults (25 s / 1 s) that is
 * 25 ops per active connection. The cost-model bound ticket 22
 * established (`< 1 Class A op / writer / hour`) is for an *idle*
 * reader — i.e. a client that is *not* currently holding a long-poll
 * open. Subscribers paying for real-time-ish delivery are by
 * definition non-idle.
 *
 * See `.claude/research/planning/tickets/26-long-poll-since-route.md`
 * §4.3-§4.4 for the full design rationale.
 */

import { BaerlyError } from "@baerly/protocol";
import type { LogEntry, Storage, StorageGetOptions, StorageGetResult } from "@baerly/protocol";
import { LOG_KEY_PREFIX, readCurrentJson, logSeqStartOf } from "@baerly/protocol";
import type { Db } from "../db.ts";
import type { SinceResponse } from "../contract.ts";

/**
 * Validation regex for an opaque LSN cursor. Matches the shape minted
 * by `Syncer.generate_manifest_key()` (see
 * `packages/protocol/src/log.ts:22-30`) —
 * `<base32-time>_<session>_<seq>` where base-32 is `[0-9a-v]` and the
 * trailing seq is two characters. Mirrored from
 * `tests/integration/log-emit.test.ts:77`.
 */
const LSN_RE = /^[0-9a-v]+_[0-9a-v]+_[0-9a-v]{2}$/;

/**
 * Hard cap on log entries returned in a single poll cycle. 1024 is
 * comfortably above the largest expected per-poll batch under the
 * production 1 s poll interval and bounds the worst-case memory
 * footprint of the parsed-JSON array on a hostile workload.
 */
const DEFAULT_MAX_EVENTS = 1024;

/**
 * Env-read guarded against Workerd (no `process.env`). The two
 * `DEFAULT_*` constants below resolve once at module init, NOT
 * per-request. CF Worker env access has measurable per-call cost.
 */
const env: Record<string, string | undefined> =
  typeof process !== "undefined" && process.env ? process.env : {};

/**
 * Default 25 s long-poll budget. CF Workers cap fetch CPU at 30 s on
 * the free plan; 25 s leaves slack for header serialization plus the
 * platform's bookkeeping. Node / Bun / Deno have no comparable cap,
 * but the budget is still useful as a connection-cycling hint for
 * upstream load balancers (most idle-connection timeouts are 30-60 s).
 */
const DEFAULT_TIMEOUT_MS = Number(env.BAERLY_SINCE_TIMEOUT_MS ?? 25_000);

/**
 * Default 1 s inner-poll interval. 25 polls × 1 list = 25 Class A
 * ops per active long-poll connection. See module docstring for the
 * cost-model trade-off.
 */
const DEFAULT_POLL_INTERVAL_MS = Number(env.BAERLY_SINCE_POLL_INTERVAL_MS ?? 1_000);

export interface LongPollSinceOptions {
  readonly db: Db;
  readonly table: string;
  /** Opaque cursor; empty string = from `log_seq_start`. */
  readonly cursor: string;
  readonly signal?: AbortSignal;
  /** Overrides for tests. */
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly maxEvents?: number;
}

export interface ListEventsSinceOptions {
  readonly db: Db;
  readonly table: string;
  /** Opaque cursor; empty string = from `log_seq_start`. */
  readonly cursor: string;
  readonly signal?: AbortSignal;
  readonly maxEvents?: number;
}

/**
 * Long-poll wrapper around {@link listEventsSince}. Returns as soon
 * as the first non-empty poll lands, or when the wall-clock timeout
 * elapses (whichever comes first). On timeout the response is
 * `{ events: [], next_cursor: <same> }` — see ticket 26 §4.5 for why
 * we ship that as `200`, not `304`.
 *
 * @throws BaerlyError{code:"SchemaError"} — invalid cursor shape, or
 *   the cursor references a log entry that has been folded into a
 *   snapshot and GC'd.
 */
export async function longPollSince(opts: LongPollSinceOptions): Promise<SinceResponse> {
  const { db, table, cursor, signal } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;

  // Up-front cursor-shape validation. `listEventsSince` also checks,
  // but doing it here short-circuits the fast-path read on bad input.
  if (cursor.length > 0 && !LSN_RE.test(cursor)) {
    throw new BaerlyError(
      "SchemaError",
      `cursor: invalid shape (expected an lsn returned by a prior SinceResponse); got ${JSON.stringify(cursor)}`,
    );
  }

  // Fast path: the first poll already sees new events.
  const initial = await listEventsSince({ db, table, cursor, signal, maxEvents });
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
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const settleReject = (err: unknown): void => {
      if (settled) return;
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
      if (settled) return;
      try {
        const events = await listEventsSince({ db, table, cursor, signal, maxEvents });
        if (settled) return;
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
      } catch (e) {
        settleReject(e);
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
 * One poll cycle: read `current.json`, validate the cursor against
 * `log_seq_start`, list strictly-greater log keys, GET each body,
 * return the parsed `LogEntry`s in causal order.
 *
 * No `current.json` yet → `[]` (clients can poll a not-yet-existing
 * table without erroring). Cursor inside `[0, log_seq_start)` →
 * `BaerlyError{code:"SchemaError"}`.
 */
export async function listEventsSince(opts: ListEventsSinceOptions): Promise<LogEntry[]> {
  const { db, table, cursor, signal } = opts;
  const maxEvents = opts.maxEvents ?? DEFAULT_MAX_EVENTS;

  if (cursor.length > 0 && !LSN_RE.test(cursor)) {
    throw new BaerlyError(
      "SchemaError",
      `cursor: invalid shape (expected an lsn returned by a prior SinceResponse); got ${JSON.stringify(cursor)}`,
    );
  }

  const tablePrefix = `manifests/${table}`;
  const currentJsonKey = `${tablePrefix}/current.json`;
  const logPrefix = `${tablePrefix}/${LOG_KEY_PREFIX}/`;

  // `readCurrentJson` calls `Storage.get`. Build a 1-method adapter
  // over `db._raw.get` so we get the tenant prefix rewrite for free.
  // The other Storage methods throw `Internal` — `readCurrentJson`
  // only ever calls `get`.
  const storage = rawAsStorage(db);

  const read = await readCurrentJson(storage, currentJsonKey, signalOpt(signal));
  if (read === null) {
    // No table provisioned yet. Clients polling for a table that
    // doesn't exist see an empty stream, NOT an error.
    return [];
  }
  const logSeqStart = logSeqStartOf(read.json);

  // Cursor probe (the only non-obvious step). A cursor inside
  // `[0, log_seq_start)` references a log entry that the compactor
  // has folded into the snapshot and the GC sweep has deleted. The
  // client must re-bootstrap from a snapshot read before resuming.
  if (cursor.length > 0) {
    const probeKey = `${logPrefix}${cursor}.json`;
    const probed = await db._raw.get(probeKey, signalOpt(signal));
    if (probed === null && logSeqStart > 0) {
      throw new BaerlyError(
        "SchemaError",
        `cursor ${JSON.stringify(cursor)} points to a log entry that has been folded into a snapshot (log_seq_start=${logSeqStart}); re-bootstrap from a snapshot read before resuming`,
      );
    }
    // If `logSeqStart === 0` and the probe missed, the cursor is
    // either a future lsn the client invented or a transient race
    // — fall through and let the list surface zero events.
  }

  // Collect log keys strictly greater than the cursor.
  const startAfter = cursor.length > 0 ? `${logPrefix}${cursor}.json` : undefined;
  const listOpts: { startAfter?: string; maxKeys: number; signal?: AbortSignal } = {
    maxKeys: maxEvents,
  };
  if (startAfter !== undefined) listOpts.startAfter = startAfter;
  if (signal !== undefined) listOpts.signal = signal;

  const keys: string[] = [];
  for await (const entry of db._raw.list(logPrefix, listOpts)) {
    keys.push(entry.key);
    if (keys.length >= maxEvents) break;
  }

  // Sequential GETs (NOT Promise.all). Long-poll is latency-bound,
  // per-poll batch is typically 0-10 entries, sequential keeps
  // memory bounded under pathological workloads.
  const entries: LogEntry[] = [];
  for (const key of keys) {
    const got = await db._raw.get(key, signalOpt(signal));
    if (got === null) {
      // Race: the GC sweeper deleted this entry between the list
      // and the GET. Skip; don't error.
      continue;
    }
    const text = new TextDecoder().decode(got.body);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new BaerlyError("InvalidResponse", `log entry at ${key}: body is not valid JSON`, e);
    }
    entries.push(parsed as LogEntry);
  }

  // Sort defensively. Within a single session, ascending `seq`;
  // across sessions, the lsn lex order is the descending-base-32
  // encoding of the time component (newer sorts EARLIER lex), so we
  // sort by `seq` ascending for the within-session case and break
  // ties by lsn-desc (newer-first) for the cross-session case. The
  // sort is REDUNDANT for a single-session writer — the list
  // returns keys in storage-defined order which mirrors lex. We
  // sort anyway because the design admits multiple concurrent
  // writer sessions sharing one `current.json`.
  entries.sort((a, b) => {
    if (a.session === b.session) return a.seq - b.seq;
    // Cross-session: tie-break on lsn lex-DESC (newer first under
    // descending-base-32 encoding).
    return a.lsn < b.lsn ? 1 : a.lsn > b.lsn ? -1 : 0;
  });

  return entries;
}

/**
 * Adapter that exposes `Db._raw.get` under the `Storage` interface
 * so `readCurrentJson` (which is platform-agnostic and only takes a
 * `Storage`) can read through the tenant-prefix rewrite. The other
 * `Storage` methods throw `Internal` — they are unreachable inside
 * `readCurrentJson`.
 */
function rawAsStorage(db: Db): Storage {
  return {
    get: (key: string, opts?: StorageGetOptions): Promise<StorageGetResult | null> => {
      // Forward only the fields the underlying `Db._raw.get` honours.
      // Reassemble the object via spread because `StorageGetOptions`
      // is fully `readonly` (no field-wise reassignment).
      const passOpts: StorageGetOptions = {
        ...(opts?.ifNoneMatch !== undefined && { ifNoneMatch: opts.ifNoneMatch }),
        ...(opts?.versionId !== undefined && { versionId: opts.versionId }),
        ...(opts?.signal !== undefined && { signal: opts.signal }),
      };
      return db._raw.get(key, passOpts);
    },
    put: () => {
      throw new BaerlyError("Internal", "rawAsStorage: put() is not implemented");
    },
    delete: () => {
      throw new BaerlyError("Internal", "rawAsStorage: delete() is not implemented");
    },
    list: () => {
      throw new BaerlyError("Internal", "rawAsStorage: list() is not implemented");
    },
  };
}

/** Pack an optional `signal` into the `{ signal? }` shape callers expect. */
const signalOpt = (signal: AbortSignal | undefined): { signal?: AbortSignal } | undefined =>
  signal === undefined ? undefined : { signal };
