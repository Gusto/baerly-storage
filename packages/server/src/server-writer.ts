/**
 * `ServerWriter` — stateless multi-instance write engine for Phase 3+.
 *
 * Each {@link ServerWriter.commit} call reads `current.json` FRESH from
 * the bucket, walks the log from `0` to `next_seq` to validate
 * integrity (per-doc fold lands in Phase 4), mints the next
 * {@link LogEntry}, PUTs the content body and the log entry, and
 * CAS-advances `current.json` with `If-Match`. Up to
 * {@link S3_REQUEST_MAX_RETRIES} attempts on contention before
 * surfacing `MPS3Error{code:"Conflict"}`.
 *
 * The instance carries no per-write cache: every commit re-reads
 * `current.json`, so N stateless server instances writing the same
 * tenant prefix contend at exactly one place — the conditional PUT
 * on `current.json` — and one loses cleanly with a 412.
 *
 * **Manifest-first ordering is REVERSED relative to the legacy
 * `src/syncer.ts` write loop.** Old loop: PUT manifest → PUT content
 * → CAS. New loop: PUT content → PUT log entry → CAS-advance
 * `current.json`. A crashed mid-loop writer leaves an unreferenced
 * content body (no log entry points at it), not an orphan log entry
 * with missing content. The Phase 5 compactor sweeps the orphan
 * content later.
 *
 * **`LogEntry` shape parity.** Emitted entries match the shape that
 * the legacy `Syncer.updateContent` log-emit produces
 * (`src/syncer.ts:454-518`). Fields, types, semantics — identical;
 * only the on-bucket key changes from `log/<lsn>.json` to
 * `log/<seq>.json` (the integer `seq` is the load-bearing identifier;
 * the `lsn` string is schema-only).
 *
 * @see docs/sync_protocol.md for the legacy invariants this loop
 *      preserves.
 */

import {
  type CurrentJson,
  type JSONArraylessObject,
  type LogEntry,
  MPS3Error,
  type Storage,
  type StoragePutOptions,
  S3_REQUEST_MAX_RETRIES,
  SESSION_ID_LENGTH,
  countKey,
  readCurrentJson,
  timestamp,
  uuid,
  versionFromContent,
} from "@baerly/protocol";

/**
 * Tunables for {@link ServerWriter}. All optional; defaults match the
 * legacy retry budget so the new loop is a drop-in replacement.
 */
export interface ServerWriterOptions {
  /**
   * Max CAS attempts on 412 before throwing `Conflict`. Default
   * {@link S3_REQUEST_MAX_RETRIES} (8). Override only in tests.
   */
  readonly maxRetries?: number;

  /** Initial backoff in ms; doubles per attempt, capped at 1500ms. Default 25. */
  readonly initialBackoffMs?: number;

  /**
   * Pure function returning a number in [0, 1). Used for jitter; tests
   * inject a deterministic generator. Defaults to `Math.random`.
   */
  readonly random?: () => number;
}

/**
 * Single-doc mutation request. One `commit()` ↔ one {@link LogEntry}.
 */
export interface CommitInput {
  /**
   * The mutation op. Maps directly to {@link LogEntry.op}. `T` and `M`
   * (TRUNCATE / MESSAGE) are out of scope for Phase 3.
   */
  readonly op: "I" | "U" | "D";

  /** The collection (table) name. Becomes {@link LogEntry.collection}. */
  readonly collection: string;

  /** The document primary key. Becomes {@link LogEntry.doc_id}. */
  readonly docId: string;

  /**
   * For `I` / `U`: the post-image. Becomes {@link LogEntry.new} *and*
   * {@link LogEntry.patch} (today's per-doc-replace model). Must be
   * `undefined` for `op: "D"`.
   */
  readonly body?: JSONArraylessObject;

  /** Optional ISO-8601 origin marker; becomes {@link LogEntry.origin}. */
  readonly origin?: string;
}

/** Return shape of {@link ServerWriter.commit}. */
export interface CommitResult {
  /** The committed `LogEntry`. Caller can ack on `entry.lsn`. */
  readonly entry: LogEntry;

  /** New ETag of `current.json` after the CAS-advance landed. */
  readonly currentEtag: string;

  /** How many CAS attempts it took (1 = first try won). */
  readonly attempts: number;
}

const DEFAULT_INITIAL_BACKOFF_MS = 25;
const MAX_BACKOFF_MS = 1500;
const APPLICATION_JSON = "application/json";

/**
 * Stateless write engine for the multi-instance core.
 *
 * Construction is cheap and performs zero I/O — Phase 3 adapters
 * build a fresh `ServerWriter` per request and discard it. All real
 * work happens in {@link commit}.
 *
 * @example
 * ```ts
 * import { ServerWriter } from "@baerly/server";
 * import { MemoryStorage } from "@baerly/protocol";
 *
 * const writer = new ServerWriter({
 *   storage: new MemoryStorage(),
 *   currentJsonKey: "app/tickets/tenant/acme/manifests/tickets/current.json",
 * });
 *
 * const result = await writer.commit({
 *   op: "I",
 *   collection: "tickets",
 *   docId: "doc-1",
 *   body: { _id: "doc-1", title: "hello" },
 * });
 * console.log(result.entry.seq, result.attempts);
 * ```
 */
export class ServerWriter {
  readonly #storage: Storage;
  readonly #currentJsonKey: string;
  readonly #maxRetries: number;
  readonly #initialBackoffMs: number;
  readonly #random: () => number;

  constructor(opts: {
    storage: Storage;
    /**
     * Full bucket-relative key of the CAS pointer, e.g.
     * `app/tickets/tenant/acme/manifests/tickets/current.json`. The
     * collection-prefix half lives at
     * `currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"))` — the
     * log and content keys are derived from it.
     */
    currentJsonKey: string;
    options?: ServerWriterOptions;
  }) {
    this.#storage = opts.storage;
    this.#currentJsonKey = opts.currentJsonKey;
    this.#maxRetries = opts.options?.maxRetries ?? S3_REQUEST_MAX_RETRIES;
    this.#initialBackoffMs = opts.options?.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.#random = opts.options?.random ?? Math.random;
  }

  /**
   * Atomically commit one mutation. Reads `current.json` fresh, mints
   * the next log entry at `seq = current.next_seq`, PUTs the content
   * body and the log entry, then CAS-advances `current.json` with
   * `If-Match`. Retries on conflict up to `maxRetries`.
   *
   * The hot-path cost under no contention is 1 GET + 3 PUTs (4 ops);
   * an in-flight peer write costs one extra GET + the backoff sleep
   * per retry.
   *
   * Idempotency: PUT content uses `If-None-Match: "*"`, so a retry of
   * the same logical write produces the same content key and the
   * second PUT no-ops. PUT log entry also uses `If-None-Match: "*"`,
   * so two writers racing the same `next_seq` cause exactly one PUT
   * to land — the loser falls into the CAS retry path.
   *
   * @throws MPS3Error code="Conflict" when the retry budget is
   *   exhausted (genuine high-contention case), or when the underlying
   *   `current.json` CAS PUT lost.
   * @throws MPS3Error code="Internal" when a log entry expected in
   *   `[0, next_seq)` is missing — a protocol-invariant violation
   *   (compactor bug or stale `current.json`).
   * @throws MPS3Error code="InvalidResponse" when `current.json` does
   *   not exist (caller must bootstrap it first), or a log-entry body
   *   isn't valid JSON.
   * @throws MPS3Error code="SchemaError" when `op !== "D"` and `body`
   *   is missing, or `op === "D"` and `body` is provided.
   */
  async commit(input: CommitInput): Promise<CommitResult> {
    validateInput(input);
    const session = uuid().slice(0, SESSION_ID_LENGTH);
    const logPrefix = this.#currentJsonKey.slice(0, this.#currentJsonKey.lastIndexOf("/"));

    for (let attempt = 1; attempt <= this.#maxRetries; attempt++) {
      // ── Step 1. Read current.json (fresh; carries the ETag). ──────
      const read = await readCurrentJson(this.#storage, this.#currentJsonKey);
      if (read === null) {
        throw new MPS3Error(
          "InvalidResponse",
          `ServerWriter: current.json missing at ${this.#currentJsonKey}; bootstrap via createCurrentJson first`,
        );
      }
      const current = read.json;
      const baseEtag = read.etag;

      // ── Step 2. Walk the log to validate integrity. ───────────────
      // Phase 5 will surface `log_seq_start` on `current.json`; until
      // then walk from 0. The fold (per-doc reducer) is deferred to
      // Phase 4 — today every `U` arrives with a full post-image, so
      // we don't need to materialise it. We still issue the GETs so
      // the I/O profile matches what adapters in tickets 04/05 will
      // see in real workloads, and so a missing entry trips the
      // Internal invariant check.
      await this.#walkLog(logPrefix, current.next_seq);

      // ── Step 3. Mint the new LogEntry. ────────────────────────────
      const nextSeq = current.next_seq;
      const lsn = `${timestamp(Date.now())}_${session}_${countKey(nextSeq)}`;
      const entry: LogEntry = {
        lsn,
        commit_ts: new Date().toISOString(),
        op: input.op,
        collection: input.collection,
        doc_id: input.docId,
        schema_version: 0,
        session,
        seq: nextSeq,
        ...(input.op !== "D" && input.body !== undefined
          ? { new: input.body, patch: input.body }
          : {}),
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
      };

      // ── Step 4. PUT content body at content-hashed key. ───────────
      // For `D` ops there is no body; skip the content PUT entirely.
      // For `I`/`U`: the content key is SHA-256 over the serialised
      // body. `ifNoneMatch: "*"` makes the PUT a no-op when the same
      // hash already exists — that's the idempotency property of
      // §3.5 of ticket 03, exercised by crash-recovery and same-body
      // replay.
      if (input.op !== "D" && input.body !== undefined) {
        const contentBytes = new TextEncoder().encode(JSON.stringify(input.body));
        const version = await versionFromContent(contentBytes);
        const contentKey = `${logPrefix}/content/${version}.json`;
        try {
          await this.#storage.put(contentKey, contentBytes, {
            ifNoneMatch: "*",
            contentType: APPLICATION_JSON,
          });
        } catch (err) {
          // 412 = same content already present (idempotent same-hash
          // re-write); swallow. Other failures propagate.
          if (!isPreconditionFailed(err)) throw err;
        }
      }

      // ── Step 5. PUT the log entry at log/<next_seq>.json. ─────────
      // The log key is deterministic given `next_seq`. `ifNoneMatch:
      // "*"` ensures two writers racing the same seq produce exactly
      // one landed PUT.
      //
      // On 412 there are two cases to discriminate:
      //   (a) a peer wrote a DIFFERENT entry at the same seq — we
      //       lost the race, our CAS in step 6 will also fail, so
      //       back off and retry from step 1.
      //   (b) our OWN previous attempt landed step 5 but lost step 6
      //       (and we're now re-driving the same logical commit) —
      //       the existing entry IS ours. Adopt it and proceed to
      //       step 6 so the CAS-advance gets a chance to commit.
      // We discriminate by `session`: the random per-`commit()` id
      // is unique to this call, so a matching session uniquely
      // identifies "our own previous attempt."
      const logEntryKey = `${logPrefix}/log/${nextSeq}.json`;
      const logBytes = new TextEncoder().encode(JSON.stringify(entry));
      let committedEntry = entry;
      try {
        await this.#storage.put(logEntryKey, logBytes, {
          ifNoneMatch: "*",
          contentType: APPLICATION_JSON,
        });
      } catch (err) {
        if (!isPreconditionFailed(err)) throw err;
        const existing = await this.#readLogEntry(logEntryKey);
        if (existing.session !== session) {
          // Real peer race; their CAS will / did win step 6.
          await this.#backoff(attempt);
          continue;
        }
        // Our previous attempt's entry — adopt it so the returned
        // `CommitResult.entry` matches what's actually stored.
        committedEntry = existing;
      }

      // ── Step 6. CAS-advance current.json with If-Match. ───────────
      // Bind the CAS to the etag from step 1 — we must not let the
      // helper re-read `current.json` and write under a different
      // etag, because that would advance `next_seq` past a seq we
      // never wrote a log entry for. Direct `storage.put` is the
      // right level here.
      const next: CurrentJson = { ...current, next_seq: nextSeq + 1 };
      const nextBody = new TextEncoder().encode(JSON.stringify(next));
      const putOpts: StoragePutOptions = {
        ifMatch: baseEtag,
        contentType: APPLICATION_JSON,
      };
      try {
        const result = await this.#storage.put(this.#currentJsonKey, nextBody, putOpts);
        return { entry: committedEntry, currentEtag: result.etag, attempts: attempt };
      } catch (err) {
        if (isCasConflict(err)) {
          await this.#backoff(attempt);
          continue;
        }
        throw err;
      }
    }

    // Retry budget exhausted.
    throw new MPS3Error(
      "Conflict",
      `ServerWriter: CAS conflict on ${this.#currentJsonKey} after ${this.#maxRetries} attempts`,
    );
  }

  /**
   * Walk `log/0.json` … `log/<nextSeq - 1>.json` in parallel. Any
   * missing entry is a protocol-invariant violation
   * (`MPS3Error{code:"Internal"}`). A malformed body surfaces as
   * `InvalidResponse`. The materialised entries are discarded in
   * Phase 3 — Phase 4 will fold them into a per-doc reducer.
   */
  async #walkLog(logPrefix: string, nextSeq: number): Promise<void> {
    if (nextSeq === 0) return;
    const reads: Array<Promise<LogEntry>> = [];
    for (let s = 0; s < nextSeq; s++) {
      reads.push(this.#readLogEntry(`${logPrefix}/log/${s}.json`));
    }
    await Promise.all(reads);
  }

  async #readLogEntry(key: string): Promise<LogEntry> {
    const got = await this.#storage.get(key);
    if (got === null) {
      throw new MPS3Error(
        "Internal",
        `ServerWriter: missing log entry at ${key}; protocol invariant violation`,
      );
    }
    try {
      return JSON.parse(new TextDecoder().decode(got.body)) as LogEntry;
    } catch (err) {
      throw new MPS3Error("InvalidResponse", `ServerWriter: malformed log entry at ${key}`, err);
    }
  }

  /**
   * Exponential backoff with full jitter. `25 * 2^(attempt-1)` capped
   * at 1500ms; uniform jitter in `[0, base)` keeps colliding peers
   * from re-racing in lockstep. Worst-case total wait across the
   * default 8 attempts is roughly 2.5 s — well under a typical
   * Worker request budget.
   */
  async #backoff(attempt: number): Promise<void> {
    const base = Math.min(this.#initialBackoffMs * 2 ** (attempt - 1), MAX_BACKOFF_MS);
    const sleepMs = base * this.#random();
    if (sleepMs <= 0) return;
    await new Promise<void>((r) => setTimeout(r, sleepMs));
  }
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

/**
 * Reject inputs that the {@link LogEntry} shape can't represent
 * coherently. `D` ops can't carry a `body`; `I`/`U` ops must.
 */
const validateInput = (input: CommitInput): void => {
  if (input.op === "D" && input.body !== undefined) {
    throw new MPS3Error("SchemaError", `ServerWriter: op "D" must not carry a body`);
  }
  if (input.op !== "D" && input.body === undefined) {
    throw new MPS3Error(
      "SchemaError",
      `ServerWriter: op "${input.op}" requires a body (post-image)`,
    );
  }
};

/**
 * `true` when the underlying storage surfaced a `PreconditionFailed`
 * 412. Every in-tree {@link Storage} impl phrases the message as
 * `"PreconditionFailed: …"` on `InvalidResponse`; some upstream
 * helpers (e.g. {@link casUpdateCurrentJson}) translate that to
 * `Conflict` before re-throwing. Match both shapes.
 */
const isPreconditionFailed = (err: unknown): boolean => {
  if (!(err instanceof MPS3Error)) return false;
  if (err.code === "Conflict") return true;
  return err.code === "InvalidResponse" && err.message.startsWith("PreconditionFailed:");
};

/**
 * `true` when an `If-Match` CAS guard lost. Same shape envelope as
 * {@link isPreconditionFailed} — kept as a separate predicate for
 * call-site clarity (step 6 reads better as "CAS conflict").
 */
const isCasConflict = (err: unknown): boolean => isPreconditionFailed(err);
