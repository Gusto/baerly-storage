/**
 * `ServerWriter` — stateless multi-instance write engine for Phase 3+.
 *
 * Each {@link ServerWriter.commit} call reads `current.json` FRESH from
 * the bucket, walks the log from `0` to `next_seq` to validate
 * integrity (per-doc fold lands in Phase 4), mints the next
 * {@link LogEntry}, PUTs the content body and the log entry, and
 * CAS-advances `current.json` with `If-Match`. Up to
 * {@link S3_REQUEST_MAX_RETRIES} attempts on contention before
 * surfacing `BaerlyError{code:"Conflict"}`.
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
 * @see docs/spec/sync-protocol.md for the legacy invariants this loop
 *      preserves.
 */

import {
  type CurrentJson,
  type JSONArraylessObject,
  type LogEntry,
  type MetricsRecorder,
  logSeqStartOf,
  BaerlyError,
  noopMetricsRecorder,
  type Storage,
  type StoragePutOptions,
  type StoragePutResult,
  S3_REQUEST_MAX_RETRIES,
  SESSION_ID_LENGTH,
  countKey,
  readCurrentJson,
  timestamp,
  uuid,
  versionFromContent,
} from "@baerly/protocol";
import { allIndexKeysFor, type IndexDefinition, validateIndexDefinition } from "./indexes";

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

  /**
   * Optional metrics sink. Defaults to {@link noopMetricsRecorder} so
   * non-instrumented callers see zero behavioural change. The writer
   * emits:
   *   - `db.write.class_a_ops_per_logical_write` histogram per
   *     successful commit (PUT count: content + log + current.json,
   *     minus the content PUT on `op:"D"`, plus one per backoff
   *     retry).
   *   - `db.r2.put.412_total` counter on `PreconditionFailed` (CAS
   *     loss on `current.json` or `If-None-Match: "*"` loss on the
   *     log PUT).
   *   - `db.r2.put.429_total` counter on rate-limit (best effort —
   *     detected via `BaerlyError{code:"NetworkError"}` with a `429`
   *     token in the message).
   *   - `db.tenant.put_rate` gauge per commit (each commit emits
   *     `1` at observation time; downstream aggregation
   *     rate-converts).
   *   - `db.writer.fence_bump_observed_total` counter on a
   *     concurrent fence-epoch bump observed during commit
   *     (split-brain detection; commit fails fast with
   *     `Conflict`).
   */
  readonly metrics?: MetricsRecorder;

  /**
   * Tenant label used on emitted metrics. The full `currentJsonKey`
   * already encodes the tenant; this is a denormalised convenience
   * for the metrics sink. Defaults to `""` (no label emitted).
   */
  readonly tenant?: string;

  /**
   * Optional. Indexes declared for the collection this writer
   * commits to. Each commit emits one zero-byte PUT per declared
   * index (when the indexed field is set on the doc) inside the
   * same fence as the log entry and content body. On U/D, the
   * writer reads the pre-image content body from the log (one
   * back-walk per indexed collection, NOT per index) to compute
   * the stale-key set; stale keys are DELETE'd inside the same
   * fence.
   *
   * Validated at construction via {@link validateIndexDefinition} —
   * an invalid def throws `BaerlyError{code:"SchemaError"}`
   * synchronously, before the first commit. Empty / undefined is
   * a no-op (writer behaves exactly as pre-Phase-8 — no extra
   * GET, no extra PUTs).
   *
   * Note: `ServerWriter` is per-collection (the `currentJsonKey`
   * is per-collection), so this array applies to one collection
   * only — adapters that serve multiple collections instantiate
   * one writer per collection.
   *
   * Emits two new metrics when at least one index is declared:
   *   - `db.r2.preimage_get_total` (counter, labelled by
   *     `collection`) — bumped on every U/D log-walk that finds
   *     a pre-image entry.
   *   - `db.write.index_ops_per_logical_write` (histogram,
   *     labelled by `collection`) — `K (PUT) + L (DELETE)` per
   *     successful commit.
   */
  readonly indexes?: ReadonlyArray<IndexDefinition>;
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

/** Return shape of {@link ServerWriter.commitBatch}. */
export interface CommitBatchResult {
  /**
   * One emitted `LogEntry` per input, in input order.
   * `entries[i]` corresponds to `inputs[i]`. `entries.length ===
   * inputs.length`. On an empty input array `entries` is empty and
   * no I/O happened.
   */
  readonly entries: readonly LogEntry[];

  /**
   * New ETag of `current.json` after the CAS-advance landed.
   * `undefined` on an empty input array (the CAS step is skipped).
   */
  readonly currentEtag: string | undefined;
}

const DEFAULT_INITIAL_BACKOFF_MS = 25;
const MAX_BACKOFF_MS = 1500;
const APPLICATION_JSON = "application/json";

/**
 * Empty body for index entries. Each index entry is a fact ("doc
 * `<docId>` has `<field> = <value>`"), not data — readers list the
 * prefix, extract the doc id, then GET the content body separately.
 * Pre-allocated module-level constant so every index PUT shares one
 * zero-length buffer.
 */
const EMPTY_BODY = new Uint8Array(0);

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
  readonly #metrics: MetricsRecorder;
  readonly #tenant: string;
  readonly #indexes: ReadonlyArray<IndexDefinition>;

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
    this.#metrics = opts.options?.metrics ?? noopMetricsRecorder;
    this.#tenant = opts.options?.tenant ?? "";
    const indexes = opts.options?.indexes ?? [];
    for (const def of indexes) validateIndexDefinition(def);
    this.#indexes = indexes;
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
   * @throws BaerlyError code="Conflict" when the retry budget is
   *   exhausted (genuine high-contention case), or when the underlying
   *   `current.json` CAS PUT lost.
   * @throws BaerlyError code="Conflict" — the writer fence
   *   (`current.json.writer_fence.epoch`) was bumped by a concurrent
   *   `claimWriter` call between this commit's read of
   *   `current.json` and its CAS-advance. The stale writer aborts
   *   to honour the new authority — the kernel does NOT retry under
   *   the old epoch. See {@link claimWriter} for the rotation
   *   recipe.
   * @throws BaerlyError code="Internal" when a log entry expected in
   *   `[0, next_seq)` is missing — a protocol-invariant violation
   *   (compactor bug or stale `current.json`).
   * @throws BaerlyError code="InvalidResponse" when `current.json` does
   *   not exist (caller must bootstrap it first), or a log-entry body
   *   isn't valid JSON.
   * @throws BaerlyError code="SchemaError" when `op !== "D"` and `body`
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
        throw new BaerlyError(
          "InvalidResponse",
          `ServerWriter: current.json missing at ${this.#currentJsonKey}; bootstrap via createCurrentJson first`,
        );
      }
      const current = read.json;
      const baseEtag = read.etag;
      const expectedEpoch = current.writer_fence.epoch;

      // ── Step 2. Walk the log to validate integrity. ───────────────
      // Walk `[log_seq_start, next_seq)` — entries below the bound
      // have been folded into the snapshot (ticket 14) and may already
      // have been swept off the bucket (ticket 15), so GET-requiring
      // them would trip the `Internal` invariant check. Pre-Phase-5
      // collections have `log_seq_start` undefined → `logSeqStartOf`
      // normalises to 0, so this is a no-op rewrite for the legacy
      // path. The fold (per-doc reducer) is deferred to Phase 4 —
      // today every `U` arrives with a full post-image, so we don't
      // need to materialise it. We still issue the GETs so the I/O
      // profile matches what adapters in tickets 04/05 will see, and
      // so a missing entry trips the `Internal` invariant.
      await this.#walkLog(logPrefix, logSeqStartOf(current), current.next_seq);

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
          this.#observe429(err, input.collection);
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
        this.#observe429(err, input.collection);
        if (!isPreconditionFailed(err)) throw err;
        // 412 on the log PUT — bump the counter at the "log-put" step.
        this.#metrics.counter("db.r2.put.412_total", 1, {
          collection: input.collection,
          step: "log-put",
        });
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

      // ── Step 5.5. Index updates (Phase-8). ────────────────────────
      // For I:   PUT each new index key (zero-byte, ifNoneMatch:"*").
      // For U:   PUT each new key + DELETE each stale key (the pre-
      //          image's keys not in the new key set).
      // For D:   DELETE every stale key from the pre-image.
      //
      // All PUTs / DELETEs run in parallel via Promise.all. A failure
      // on any individual PUT propagates — the outer attempt loop
      // catches it as a CAS-equivalent failure and retries from step
      // 1; on retry same-bytes/same-key PUTs are 412-then-swallowed
      // (the entries are content-addressed by composition — zero-byte
      // body, deterministic key — so a re-PUT is structurally idempotent).
      //
      // Empty `#indexes` short-circuits the entire block including
      // the pre-image GET, preserving zero behaviour change for
      // collections without declared indexes.
      let indexClassA = 0;
      if (this.#indexes.length > 0) {
        let newKeys: readonly string[] = [];
        let staleKeys: readonly string[] = [];
        if (input.op === "I") {
          newKeys = allIndexKeysFor(logPrefix, this.#indexes, input.body, input.docId);
        } else if (input.op === "U") {
          const preImage = await this.#readPreImage(
            logPrefix,
            input.collection,
            input.docId,
            nextSeq,
          );
          const oldKeys = allIndexKeysFor(logPrefix, this.#indexes, preImage, input.docId);
          newKeys = allIndexKeysFor(logPrefix, this.#indexes, input.body, input.docId);
          const newSet = new Set(newKeys);
          staleKeys = oldKeys.filter((k) => !newSet.has(k));
        } else {
          const preImage = await this.#readPreImage(
            logPrefix,
            input.collection,
            input.docId,
            nextSeq,
          );
          staleKeys = allIndexKeysFor(logPrefix, this.#indexes, preImage, input.docId);
        }
        const indexOps: Array<Promise<unknown>> = [];
        for (const k of newKeys) {
          indexOps.push(
            this.#storage
              .put(k, EMPTY_BODY, { ifNoneMatch: "*", contentType: APPLICATION_JSON })
              .catch((err: unknown) => {
                this.#observe429(err, input.collection);
                // Same-key zero-byte re-PUT — entry already present
                // from a prior attempt of this logical commit. Tolerate.
                if (isPreconditionFailed(err)) return;
                throw err;
              }),
          );
        }
        for (const k of staleKeys) {
          // Storage.delete is contractually idempotent (404 → no-op)
          // across every in-tree impl — no defensive catch needed.
          indexOps.push(this.#storage.delete(k));
        }
        if (indexOps.length > 0) await Promise.all(indexOps);
        indexClassA = newKeys.length + staleKeys.length;
        if (indexClassA > 0) {
          this.#metrics.histogram("db.write.index_ops_per_logical_write", indexClassA, {
            collection: input.collection,
          });
        }
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
      let result: StoragePutResult;
      try {
        result = await this.#storage.put(this.#currentJsonKey, nextBody, putOpts);
      } catch (err) {
        this.#observe429(err, input.collection);
        if (isCasConflict(err)) {
          this.#metrics.counter("db.r2.put.412_total", 1, {
            collection: input.collection,
            step: "current-json-cas",
          });
          await this.#backoff(attempt);
          continue;
        }
        throw err;
      }
      // CAS landed. Re-read current.json to verify the fence wasn't
      // bumped concurrently with our CAS. The CAS step only mutated
      // next_seq (the fence is preserved from `current`), so a post-
      // write epoch ≠ expectedEpoch can only mean another writer
      // claimed the fence between our step-1 read and step-6 PUT —
      // which is the exact split-brain WriterFence prevents. Surface
      // as Conflict, do NOT retry: retry would re-race the new
      // authority indefinitely. Note: the fence-verify GET is Class
      // B, NOT counted in class_a_ops_per_logical_write.
      const postRead = await readCurrentJson(this.#storage, this.#currentJsonKey);
      if (postRead !== null && postRead.json.writer_fence.epoch !== expectedEpoch) {
        const bumpLabels: Record<string, string> = { collection: input.collection };
        if (this.#tenant !== "") bumpLabels.tenant = this.#tenant;
        this.#metrics.counter("db.writer.fence_bump_observed_total", 1, bumpLabels);
        throw new BaerlyError(
          "Conflict",
          `ServerWriter: writer fence bumped from epoch ${expectedEpoch} to ${postRead.json.writer_fence.epoch} during commit on ${this.#currentJsonKey}; stale writer aborting`,
        );
      }
      // Emit class-A op count for this logical write. Content PUT
      // is skipped on `op:"D"`; one extra PUT is incurred per
      // backoff retry (the prior attempt's failed CAS still counts
      // as one billed PUT). `indexClassA` adds one Class A op per
      // index PUT and per index DELETE (DELETE is Class A on R2).
      const classAOps =
        (input.op !== "D" ? 1 : 0) /* content PUT */ +
        1 /* log PUT */ +
        indexClassA /* index PUTs + DELETEs */ +
        1 /* current.json CAS PUT */ +
        (attempt - 1); /* +1 per backoff retry */
      const histLabels: Record<string, string> = { collection: input.collection };
      if (this.#tenant !== "") histLabels.tenant = this.#tenant;
      this.#metrics.histogram("db.write.class_a_ops_per_logical_write", classAOps, histLabels);
      const rateLabels: Record<string, string> =
        this.#tenant !== "" ? { tenant: this.#tenant } : {};
      this.#metrics.gauge("db.tenant.put_rate", 1, rateLabels);
      return { entry: committedEntry, currentEtag: result.etag, attempts: attempt };
    }

    // Retry budget exhausted.
    throw new BaerlyError(
      "Conflict",
      `ServerWriter: CAS conflict on ${this.#currentJsonKey} after ${this.#maxRetries} attempts`,
    );
  }

  /**
   * Single-attempt batched commit. Reads `current.json` ONCE, mints
   * `inputs.length` log entries with contiguous `seq` numbers
   * starting at the current `next_seq`, PUTs each content body and
   * each log entry, then CAS-advances `current.json` from
   * `next_seq = N` to `next_seq = N + inputs.length` with
   * `If-Match`.
   *
   * NO retry on CAS loss. On `current.json` 412, throws
   * `BaerlyError{code:"Conflict"}` immediately — the caller (here:
   * `Db.transaction`) decides whether to retry by re-running the
   * body, or to surface to the app. Likewise on a log-entry 412
   * (a peer wrote our seq).
   *
   * Empty `inputs`: returns `{ entries: [], currentEtag: undefined }`
   * after zero storage operations.
   *
   * @throws BaerlyError code="Conflict" — CAS lost on `current.json`,
   *   or a log entry already exists at our seq (peer wrote ahead).
   * @throws BaerlyError code="Conflict" — the writer fence
   *   (`current.json.writer_fence.epoch`) was bumped by a concurrent
   *   `claimWriter` call between this batch's read of
   *   `current.json` and its CAS-advance. The stale writer aborts
   *   to honour the new authority — the kernel does NOT retry under
   *   the old epoch. See {@link claimWriter} for the rotation
   *   recipe.
   * @throws BaerlyError code="Internal" — protocol-invariant violation
   *   (missing log entry inside `[0, next_seq)`).
   * @throws BaerlyError code="InvalidResponse" — `current.json` does
   *   not exist (caller must bootstrap first), or malformed log
   *   body.
   * @throws BaerlyError code="SchemaError" — an input failed the
   *   `op === "D"` ↔ `body === undefined` invariant.
   */
  async commitBatch(inputs: readonly CommitInput[]): Promise<CommitBatchResult> {
    if (inputs.length === 0) {
      return { entries: [], currentEtag: undefined };
    }
    for (const input of inputs) validateInput(input);

    const session = uuid().slice(0, SESSION_ID_LENGTH);
    const logPrefix = this.#currentJsonKey.slice(0, this.#currentJsonKey.lastIndexOf("/"));

    // ── Step 1. Read current.json fresh and capture the ETag. ───────
    const read = await readCurrentJson(this.#storage, this.#currentJsonKey);
    if (read === null) {
      throw new BaerlyError(
        "InvalidResponse",
        `ServerWriter.commitBatch: current.json missing at ${this.#currentJsonKey}; bootstrap via createCurrentJson first`,
      );
    }
    const current = read.json;
    const baseEtag = read.etag;
    const expectedEpoch = current.writer_fence.epoch;

    // ── Step 2. Walk the log to validate integrity. ─────────────────
    // Same as single-mutation commit; observational today (Phase 5
    // will fold). Walks `[log_seq_start, next_seq)` so entries already
    // folded into a snapshot (and possibly swept off the bucket by
    // ticket 15) don't trip the `Internal` invariant. Pre-Phase-5
    // collections normalise to start=0 — legacy behaviour is preserved.
    await this.#walkLog(logPrefix, logSeqStartOf(current), current.next_seq);

    // ── Step 3. Mint N LogEntries with contiguous seqs. ─────────────
    // All entries share `session` (one session per transaction).
    const entries: LogEntry[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!;
      const seq = current.next_seq + i;
      const lsn = `${timestamp(Date.now())}_${session}_${countKey(seq)}`;
      const entry: LogEntry = {
        lsn,
        commit_ts: new Date().toISOString(),
        op: input.op,
        collection: input.collection,
        doc_id: input.docId,
        schema_version: 0,
        session,
        seq,
        ...(input.op !== "D" && input.body !== undefined
          ? { new: input.body, patch: input.body }
          : {}),
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
      };
      entries.push(entry);
    }

    // ── Step 4. PUT each content body in parallel. ──────────────────
    // `ifNoneMatch: "*"` makes a same-hash re-write a no-op (caught
    // and swallowed via `isPreconditionFailed`).
    //
    // Phase-8: index PUTs / DELETEs land in the SAME parallel batch
    // as content PUTs. For U/D the pre-image is sourced from an
    // earlier same-`docId` input in this batch (if any) before
    // falling back to a log back-walk — preserves correctness when
    // a transaction does [I, U] or [U, D] on the same doc.
    let contentPutCount = 0;
    let indexClassA = 0;
    const parallelPuts: Array<Promise<unknown>> = [];
    // Per-docId in-batch image map: tracks the latest post-image
    // each transactional input lays down so a later input on the
    // same docId reads the in-batch pre-image, not the on-disk one.
    const inBatchImage = new Map<string, JSONArraylessObject | undefined>();
    for (const input of inputs) {
      // Content PUT (skipped on D / when body is missing).
      if (input.op !== "D" && input.body !== undefined) {
        contentPutCount++;
        const bytes = new TextEncoder().encode(JSON.stringify(input.body));
        const version = await versionFromContent(bytes);
        const contentKey = `${logPrefix}/content/${version}.json`;
        parallelPuts.push(
          this.#storage
            .put(contentKey, bytes, { ifNoneMatch: "*", contentType: APPLICATION_JSON })
            .catch((err: unknown) => {
              this.#observe429(err, input.collection);
              if (isPreconditionFailed(err)) return;
              throw err;
            }),
        );
      }
      // Index PUTs / DELETEs (only when indexes are declared).
      if (this.#indexes.length > 0) {
        let newKeys: readonly string[] = [];
        let staleKeys: readonly string[] = [];
        if (input.op === "I") {
          newKeys = allIndexKeysFor(logPrefix, this.#indexes, input.body, input.docId);
        } else if (input.op === "U") {
          const preImage = inBatchImage.has(input.docId)
            ? inBatchImage.get(input.docId)
            : await this.#readPreImage(logPrefix, input.collection, input.docId, current.next_seq);
          const oldKeys = allIndexKeysFor(logPrefix, this.#indexes, preImage, input.docId);
          newKeys = allIndexKeysFor(logPrefix, this.#indexes, input.body, input.docId);
          const newSet = new Set(newKeys);
          staleKeys = oldKeys.filter((k) => !newSet.has(k));
        } else {
          const preImage = inBatchImage.has(input.docId)
            ? inBatchImage.get(input.docId)
            : await this.#readPreImage(logPrefix, input.collection, input.docId, current.next_seq);
          staleKeys = allIndexKeysFor(logPrefix, this.#indexes, preImage, input.docId);
        }
        for (const k of newKeys) {
          parallelPuts.push(
            this.#storage
              .put(k, EMPTY_BODY, { ifNoneMatch: "*", contentType: APPLICATION_JSON })
              .catch((err: unknown) => {
                this.#observe429(err, input.collection);
                if (isPreconditionFailed(err)) return;
                throw err;
              }),
          );
        }
        for (const k of staleKeys) {
          // Storage.delete is contractually idempotent — no defensive catch.
          parallelPuts.push(this.#storage.delete(k));
        }
        indexClassA += newKeys.length + staleKeys.length;
        if (newKeys.length + staleKeys.length > 0) {
          this.#metrics.histogram(
            "db.write.index_ops_per_logical_write",
            newKeys.length + staleKeys.length,
            { collection: input.collection },
          );
        }
        inBatchImage.set(input.docId, input.op === "D" ? undefined : input.body);
      }
    }
    await Promise.all(parallelPuts);

    // ── Step 5. PUT each log entry. ─────────────────────────────────
    // `ifNoneMatch: "*"` per entry. Single-attempt: on 412 throw
    // `Conflict` immediately — no own-session-adopt path (that's a
    // multi-attempt-retry feature of `commit()` and intentionally
    // out of scope here).
    const logPuts: Array<Promise<unknown>> = [];
    for (const entry of entries) {
      const logEntryKey = `${logPrefix}/log/${entry.seq}.json`;
      const logBytes = new TextEncoder().encode(JSON.stringify(entry));
      logPuts.push(
        this.#storage
          .put(logEntryKey, logBytes, { ifNoneMatch: "*", contentType: APPLICATION_JSON })
          .catch((err: unknown) => {
            this.#observe429(err, entry.collection);
            if (isPreconditionFailed(err)) {
              this.#metrics.counter("db.r2.put.412_total", 1, {
                collection: entry.collection,
                step: "log-put",
              });
              throw new BaerlyError(
                "Conflict",
                `ServerWriter.commitBatch: log entry already exists at ${logEntryKey}; peer wrote our seq`,
                err,
              );
            }
            throw err;
          }),
      );
    }
    await Promise.all(logPuts);

    // ── Step 6. CAS-advance current.json with If-Match. ─────────────
    // Bound to `baseEtag` from step 1. On 412, throw Conflict —
    // single-attempt is the contract.
    const next: CurrentJson = { ...current, next_seq: current.next_seq + inputs.length };
    const nextBody = new TextEncoder().encode(JSON.stringify(next));
    const putOpts: StoragePutOptions = {
      ifMatch: baseEtag,
      contentType: APPLICATION_JSON,
    };
    let result: StoragePutResult;
    try {
      result = await this.#storage.put(this.#currentJsonKey, nextBody, putOpts);
    } catch (err) {
      this.#observe429(err, inputs[0]!.collection);
      if (isCasConflict(err)) {
        this.#metrics.counter("db.r2.put.412_total", 1, {
          collection: inputs[0]!.collection,
          step: "current-json-cas",
        });
        throw new BaerlyError(
          "Conflict",
          `ServerWriter.commitBatch: CAS conflict on ${this.#currentJsonKey}`,
          err,
        );
      }
      throw err;
    }
    // CAS landed. Re-read current.json to verify the fence wasn't
    // bumped concurrently with our CAS. The CAS step only mutated
    // next_seq (the fence is preserved from `current`), so a post-
    // write epoch ≠ expectedEpoch can only mean another writer
    // claimed the fence between our step-1 read and step-6 PUT —
    // which is the exact split-brain WriterFence prevents. Surface
    // as Conflict; single-attempt — no retry. Note: the fence-verify
    // GET is Class B, NOT counted in class_a_ops_per_logical_write.
    const collection = inputs[0]!.collection;
    const postRead = await readCurrentJson(this.#storage, this.#currentJsonKey);
    if (postRead !== null && postRead.json.writer_fence.epoch !== expectedEpoch) {
      const bumpLabels: Record<string, string> = { collection };
      if (this.#tenant !== "") bumpLabels.tenant = this.#tenant;
      this.#metrics.counter("db.writer.fence_bump_observed_total", 1, bumpLabels);
      throw new BaerlyError(
        "Conflict",
        `ServerWriter.commitBatch: writer fence bumped from epoch ${expectedEpoch} to ${postRead.json.writer_fence.epoch} during commit on ${this.#currentJsonKey}; stale writer aborting`,
      );
    }
    // One histogram observation per landed batch. Class-A op count
    // = content PUTs (skipping op:"D") + log PUTs (= inputs.length)
    // + index PUTs + index DELETEs + 1 current.json CAS. The
    // fence-verify GET above is Class B and intentionally excluded
    // from this histogram.
    const classAOps = contentPutCount + inputs.length + indexClassA + 1;
    // Pick the first input's collection as the batch label; in the
    // current Db.transaction model every input shares one
    // collection, so this is exact. If future tickets relax that
    // we'll need a per-collection split here.
    const histLabels: Record<string, string> = { collection };
    if (this.#tenant !== "") histLabels.tenant = this.#tenant;
    this.#metrics.histogram("db.write.class_a_ops_per_logical_write", classAOps, histLabels);
    const rateLabels: Record<string, string> = this.#tenant !== "" ? { tenant: this.#tenant } : {};
    this.#metrics.gauge("db.tenant.put_rate", 1, rateLabels);
    return { entries, currentEtag: result.etag };
  }

  /**
   * Phase-8 — read the pre-image content body for a doc by walking
   * the live log backwards from `currentNextSeq` looking for the
   * most-recent I/U entry on this `(collection, docId)`. Returns
   * `undefined` when:
   *
   *   - the doc's most-recent op was `D` (tombstone — no live body);
   *   - no entry for this doc lives inside the visible log range
   *     `[log_seq_start, currentNextSeq)` (a fresh-insert race or
   *     the doc has been folded into the snapshot but is no longer
   *     referenced).
   *
   * Used ONLY by the index-emission path on `U` / `D` to compute
   * the stale-key set. Bounded by `log_seq_start`: entries below
   * have been folded into the snapshot and may already be swept
   * off the bucket — a snapshot fold is the rebuild command's job
   * (see `./rebuild-index.ts`), not the writer's.
   *
   * **Cost note:** linear walk, O(snapshot lag). For day-one Phase
   * 8 collections (helpdesk-shape: 100s of docs, <10k log entries)
   * this is fine — the compactor folds the live tail every ~100
   * entries (`packages/server/src/compactor.ts`). A follow-up ticket
   * caches per-doc index head in `current.json` for O(1) lookup.
   * The bound is documented; out of scope here.
   *
   * Emits `db.r2.preimage_get_total` (counter, labelled by
   * `collection`) on every successful pre-image find.
   */
  async #readPreImage(
    logPrefix: string,
    collection: string,
    docId: string,
    currentNextSeq: number,
  ): Promise<JSONArraylessObject | undefined> {
    // Walk newest-to-oldest so we hit the most-recent op first.
    // `s = -1` is the natural empty-bucket sentinel.
    for (let s = currentNextSeq - 1; s >= 0; s--) {
      const logKey = `${logPrefix}/log/${s}.json`;
      const got = await this.#storage.get(logKey);
      if (got === null) {
        // A hole below the visible range — either we walked past
        // `log_seq_start` (the entry was folded + swept) or a peer
        // is mid-CAS on a write we don't see yet. Bail; the
        // rebuild command (`rebuildIndex`) handles holes by
        // re-projecting from the snapshot.
        continue;
      }
      let entry: LogEntry;
      try {
        entry = JSON.parse(new TextDecoder().decode(got.body)) as LogEntry;
      } catch {
        // Malformed entry shouldn't propagate up the index-emission
        // path — let the outer commit's `#walkLog` (step 2) flag it
        // as the protocol violation. Skip.
        continue;
      }
      if (entry.collection !== collection || entry.doc_id !== docId) continue;
      if (entry.op === "D") return undefined; // last op was delete
      if ((entry.op === "I" || entry.op === "U") && entry.new !== undefined) {
        this.#metrics.counter("db.r2.preimage_get_total", 1, { collection });
        return entry.new;
      }
    }
    return undefined;
  }

  /**
   * Walk `log/<logSeqStart>.json` … `log/<nextSeq - 1>.json` in
   * parallel. Any missing entry is a protocol-invariant violation
   * (`BaerlyError{code:"Internal"}`). A malformed body surfaces as
   * `InvalidResponse`. The materialised entries are discarded in
   * Phase 3 — Phase 4 will fold them into a per-doc reducer.
   *
   * `logSeqStart` is the boundary set by the Phase-5 compactor
   * (ticket 14) on `current.json.log_seq_start`. Entries below it
   * have been folded into the snapshot and may have been swept off
   * the bucket (ticket 15), so the walk MUST NOT GET-require them.
   */
  async #walkLog(logPrefix: string, logSeqStart: number, nextSeq: number): Promise<void> {
    if (logSeqStart >= nextSeq) return;
    const reads: Array<Promise<LogEntry>> = [];
    for (let s = logSeqStart; s < nextSeq; s++) {
      reads.push(this.#readLogEntry(`${logPrefix}/log/${s}.json`));
    }
    await Promise.all(reads);
  }

  async #readLogEntry(key: string): Promise<LogEntry> {
    const got = await this.#storage.get(key);
    if (got === null) {
      throw new BaerlyError(
        "Internal",
        `ServerWriter: missing log entry at ${key}; protocol invariant violation`,
      );
    }
    try {
      return JSON.parse(new TextDecoder().decode(got.body)) as LogEntry;
    } catch (err) {
      throw new BaerlyError("InvalidResponse", `ServerWriter: malformed log entry at ${key}`, err);
    }
  }

  /**
   * Bump the `db.r2.put.429_total` counter when `err` looks like an
   * R2 prefix-partition rate-limit. Best-effort: detected via
   * `BaerlyError{code:"NetworkError"}` with a `429` token in the
   * message. Called from every PUT call site's catch arm; mutually
   * exclusive in practice with `isPreconditionFailed` (412 ≠ 429).
   */
  #observe429(err: unknown, collection: string): void {
    if (is429(err)) {
      this.#metrics.counter("db.r2.put.429_total", 1, { collection });
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
    throw new BaerlyError("SchemaError", `ServerWriter: op "D" must not carry a body`);
  }
  if (input.op !== "D" && input.body === undefined) {
    throw new BaerlyError(
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
  if (!(err instanceof BaerlyError)) return false;
  if (err.code === "Conflict") return true;
  return err.code === "InvalidResponse" && err.message.startsWith("PreconditionFailed:");
};

/**
 * `true` when an `If-Match` CAS guard lost. Same shape envelope as
 * {@link isPreconditionFailed} — kept as a separate predicate for
 * call-site clarity (step 6 reads better as "CAS conflict").
 */
const isCasConflict = (err: unknown): boolean => isPreconditionFailed(err);

/**
 * `true` when the underlying storage surfaced an R2 prefix-partition
 * rate-limit. Best-effort detection: every in-tree {@link Storage}
 * impl wraps transport-layer errors in
 * `BaerlyError{code:"NetworkError"}` and includes the upstream status
 * code in the message. A `429` token in that message is the canonical
 * "throttled" signal.
 */
const is429 = (err: unknown): boolean => {
  if (!(err instanceof BaerlyError)) return false;
  return err.code === "NetworkError" && /\b429\b/.test(err.message);
};
