/**
 * `Writer` — stateless multi-instance write engine.
 *
 * Each {@link Writer.commit} call reads `current.json` FRESH from
 * the bucket, mints the next {@link LogEntry}, PUTs the content body
 * and the log entry, and CAS-advances `current.json` with `If-Match`.
 * Up to {@link S3_REQUEST_MAX_RETRIES} attempts on contention before
 * surfacing `BaerlyError{code:"Conflict"}`. The optional integrity
 * walk over the live log tail is gated by
 * {@link WriterOptions.verifyLogIntegrityOnCommit} (default off
 * — see the option's docstring).
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
 * with missing content. The compactor sweeps the orphan content
 * later.
 *
 * **`LogEntry` shape.** Emitted entries follow the contract in
 * `packages/protocol/src/log.ts` (see {@link LogEntry}) and
 * `docs/spec/log-entry-shape.md`. The on-bucket key is
 * `log/<seq>.json` (the integer `seq` is the load-bearing
 * identifier; the `lsn` string is schema-only).
 *
 * @see docs/spec/sync-protocol.md for the protocol invariants this
 *      loop preserves.
 * @see docs/spec/log-entry-shape.md for the per-field contract.
 */

import {
  CURRENT_JSON_SCHEMA_VERSION,
  type CurrentJson,
  type CurrentJsonRead,
  type DocumentData,
  type LogEntry,
  type MetricsRecorder,
  createCurrentJson,
  decodeJsonBytes,
  encodeJsonBytes,
  logObjectKey,
  logSeqStartOf,
  BaerlyError,
  noopMetricsRecorder,
  type Storage,
  type StoragePutOptions,
  type StoragePutResult,
  MAINTENANCE_PROFILE_CF_FREE,
  S3_REQUEST_MAX_RETRIES,
  SESSION_ID_LENGTH,
  countKey,
  readCurrentJson,
  timestamp,
  uuid,
  versionFromContent,
} from "@baerly/protocol";
import { allIndexKeysFor, type IndexDefinition, validateIndexDefinition } from "./indexes.ts";
import { readLogEntry, walkLogRange } from "./log-walk.ts";
import { tryAdoptOwnSessionLogEntry } from "./log-conflict-adoption.ts";
import {
  dispatchInlineAwaited,
  runBoundedMaintenance,
  shouldFireMaintenance,
} from "./maintenance.ts";
import { getCurrentContext } from "./observability/context.ts";

const ctxMetrics = (): MetricsRecorder => getCurrentContext()?.recorder ?? noopMetricsRecorder;

/**
 * Tunables for {@link Writer}. All optional; defaults match the
 * legacy retry budget so the new loop is a drop-in replacement.
 */
export interface WriterOptions {
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
   * a no-op (writer behaves identically to the no-index path — no
   * extra GET, no extra PUTs).
   *
   * Note: `Writer` is per-collection (the `currentJsonKey`
   * is per-collection), so this array applies to one collection
   * only — adapters that serve multiple collections instantiate
   * one writer per collection.
   *
   * Emits one new metric when at least one index is declared:
   *   - `db.write.index_ops_per_logical_write` (histogram,
   *     labelled by `collection`) — `K (PUT) + L (DELETE)` per
   *     successful commit.
   */
  readonly indexes?: ReadonlyArray<IndexDefinition>;

  /**
   * When `true`, every commit walks the live log range
   * `[log_seq_start, next_seq)` before minting a new entry, surfacing
   * a missing or malformed entry as `BaerlyError{code:"Internal"}`
   * (or `"InvalidResponse"` for parse failures). The walk is purely
   * observational — the per-doc fold lives in the read path
   * (`./query.ts`) and any hole inside the visible range would also
   * fire on the next read.
   *
   * Production callers default this OFF: under contention the walk
   * issues `O(tail)` Class-B GETs per CAS attempt and the retry
   * budget multiplies that by {@link S3_REQUEST_MAX_RETRIES}. Tests
   * that intentionally puncture bucket state to exercise the
   * invariant trigger opt in by passing `true`.
   *
   * Default `false`.
   */
  readonly verifyLogIntegrityOnCommit?: boolean;
}

/**
 * Single-doc mutation request. One `commit()` ↔ one {@link LogEntry}.
 */
export interface CommitInput {
  /** The mutation op. Maps directly to {@link LogEntry.op}. */
  readonly op: "I" | "U" | "D";

  /** The collection (table) name. Becomes {@link LogEntry.collection}. */
  readonly collection: string;

  /** The document primary key. Becomes {@link LogEntry.doc_id}. */
  readonly docId: string;

  /**
   * For `I` / `U`: the post-image. Becomes {@link LogEntry.after}. Must
   * be `undefined` for `op: "D"`.
   */
  readonly body?: DocumentData;

  /** Optional ISO-8601 origin marker; becomes {@link LogEntry.origin}. */
  readonly origin?: string;
}

/** Return shape of {@link Writer.commit}. */
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
 * Empty body for index entries. Each index entry is a fact ("doc
 * `<docId>` has `<field> = <value>`"), not data — readers list the
 * prefix, extract the doc id, then GET the content body separately.
 * Pre-allocated module-level constant so every index PUT shares one
 * zero-length buffer.
 */
const EMPTY_BODY = new Uint8Array(0);

/**
 * Successful outcome of one full {@link Writer.#singleAttemptCommit}
 * attempt. Retryable failures (log-peer race, CAS 412) throw
 * `BaerlyError{code:"Conflict"}` directly; the caller catches via
 * {@link isPreconditionFailed} and decides whether to retry. Non-retryable
 * failures (fence bump, protocol-invariant violations, network errors)
 * also throw, but the caller verifies the fence OUTSIDE the catch arm so
 * the fence-bump `Conflict` propagates instead of being mistaken for a
 * retryable CAS loss.
 */
interface SingleAttemptSuccess {
  readonly entries: readonly LogEntry[];
  readonly currentEtag: string;
  readonly classAOps: number;
  readonly expectedEpoch: number;
}

/**
 * Stateless write engine for the multi-instance core.
 *
 * Construction is cheap and performs zero I/O — adapters build a
 * fresh `Writer` per request and discard it. All real work
 * happens in {@link commit}.
 *
 * @example
 * ```ts
 * import { Writer } from "@gusto/baerly-storage";
 * import { MemoryStorage } from "@gusto/baerly-storage";
 *
 * const writer = new Writer({
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
export class Writer {
  readonly #storage: Storage;
  readonly #currentJsonKey: string;
  readonly #maxRetries: number;
  readonly #initialBackoffMs: number;
  readonly #random: () => number;
  readonly #indexes: ReadonlyArray<IndexDefinition>;
  readonly #verifyLogIntegrityOnCommit: boolean;

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
    options?: WriterOptions;
  }) {
    this.#storage = opts.storage;
    this.#currentJsonKey = opts.currentJsonKey;
    this.#maxRetries = opts.options?.maxRetries ?? S3_REQUEST_MAX_RETRIES;
    this.#initialBackoffMs = opts.options?.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS;
    this.#random = opts.options?.random ?? Math.random;
    const indexes = opts.options?.indexes ?? [];
    for (const def of indexes) {
      validateIndexDefinition(def);
    }
    this.#indexes = indexes;
    this.#verifyLogIntegrityOnCommit = opts.options?.verifyLogIntegrityOnCommit ?? false;
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
   * @throws BaerlyError code="InvalidResponse" when a log-entry body
   *   isn't valid JSON.
   *
   * **Implicit provisioning.** When `current.json` does not exist at
   * `currentJsonKey` (fresh bucket, fresh collection), the writer
   * auto-creates it with a zero-state manifest before the commit
   * lands. The cost is one extra Class A PUT on the very first
   * commit per collection; steady-state cost is unchanged. A peer
   * racing the same first-write loses cleanly on the create CAS
   * and re-reads to pick up the winner's manifest.
   */
  async commit(input: CommitInput): Promise<CommitResult> {
    const session = uuid().slice(0, SESSION_ID_LENGTH);
    const logPrefix = this.#currentJsonKey.slice(0, this.#currentJsonKey.lastIndexOf("/"));

    for (let attempt = 1; attempt <= this.#maxRetries; attempt++) {
      let success: SingleAttemptSuccess;
      try {
        success = await this.#singleAttemptCommit(
          [input],
          session,
          logPrefix,
          "Writer",
          /* adoptOwnSessionOnLogConflict */ true,
        );
      } catch (error) {
        // Only retryable conflicts (storage 412 on log PUT or
        // current.json CAS) come back as `Conflict`. The fence-bump
        // throw happens AFTER the helper returns, so it never
        // reaches this catch arm. Anything else propagates.
        if (!isPreconditionFailed(error)) {
          throw error;
        }
        await this.#backoff(attempt);
        continue;
      }
      // Fence verify lives in the caller so its `Conflict` propagates
      // past the retry-catch arm above. Bypasses the retry loop —
      // the stale writer must defer to the new authority.
      await this.#verifyFenceUnchanged(success.expectedEpoch, "Writer");
      // `success.classAOps` is the per-attempt base; add `(attempt
      // - 1)` to bill prior failed attempts as one PUT each (the
      // simple-and-test-locked cost model — not a precise replay
      // of every PUT in every dropped attempt).
      this.#emitWriteMetrics(input.collection, success.classAOps + (attempt - 1));
      return {
        entry: success.entries[0]!,
        currentEtag: success.currentEtag,
        attempts: attempt,
      };
    }

    // Retry budget exhausted.
    throw new BaerlyError(
      "Conflict",
      `Writer: CAS conflict on ${this.#currentJsonKey} after ${this.#maxRetries} attempts`,
    );
  }

  /**
   * One full commit attempt — the body of {@link commit}. Reads
   * `current.json`, walks the log, mints the entry for the single
   * input, PUTs content + indexes in parallel, PUTs the log entry,
   * CAS-advances `current.json`. Returns the success payload + the
   * pre-commit fence epoch so the caller can run
   * {@link #verifyFenceUnchanged} outside the retry-catch arm.
   *
   * Called only as `#singleAttemptCommit([input], …)`: the array
   * shape is retained dead-generality (the genuine single-input
   * unroll is the deferred follow-up tracked as D1.5), but every
   * call mints exactly one entry and advances `next_seq` by 1.
   *
   * Retryable failures (a peer wrote our seq; a peer won the CAS on
   * `current.json`) throw `BaerlyError{code:"Conflict"}`. The caller
   * ({@link commit}) catches via {@link isPreconditionFailed} and
   * retries. Fence-bump and protocol-invariant violations are NOT
   * thrown from this helper — the fence check lives in the caller so
   * its `Conflict` propagates past the retry-catch arm. Other thrown
   * `BaerlyError`s (Internal, InvalidResponse, NetworkError) bypass
   * `isPreconditionFailed` and propagate naturally.
   *
   * Crash safety invariant: content / index PUTs are awaited before
   * log PUTs, which are awaited before the CAS. A crashed mid-attempt
   * writer leaves orphan content / index entries (no log entry
   * references them) — the compactor sweeps the orphans. The
   * inverse — orphan log entry with missing content — is never
   * produced.
   */
  async #singleAttemptCommit(
    inputs: readonly CommitInput[],
    session: string,
    logPrefix: string,
    errorPrefix: string,
    adoptOwnSessionOnLogConflict: boolean,
  ): Promise<SingleAttemptSuccess> {
    // ── Step 1. Read current.json (fresh; carries the ETag). ────────
    // On a fresh bucket / fresh collection the manifest doesn't exist
    // yet. Auto-create it with a zero-state initial so `db.collection(x)
    // .insert(...)` works zero-shot. A peer racing the same create
    // loses cleanly on `If-None-Match: "*"`; we re-read to pick up
    // the winner's manifest. Cost: one extra Class A PUT on the very
    // first commit per collection, zero overhead thereafter.
    const read =
      (await readCurrentJson(this.#storage, this.#currentJsonKey)) ??
      (await this.#provisionCurrentJson());
    const current = read.json;
    const baseEtag = read.etag;
    const expectedEpoch = current.writer_fence.epoch;

    // ── Step 2. Optional integrity walk (`verifyLogIntegrityOnCommit`,
    // default off). Surfaces missing / malformed entries inside
    // `[log_seq_start, next_seq)` as `Internal` / `InvalidResponse`;
    // entries below `log_seq_start` are folded into the snapshot
    // by `compact()` and possibly swept by `runGc()`, so the walk is
    // bounded to the live tail. The read path catches the same
    // conditions on the next consult — production callers leave the
    // walk off to avoid `O(tail)` Class-B GETs per CAS attempt.
    if (this.#verifyLogIntegrityOnCommit) {
      await this.#walkLog(logPrefix, logSeqStartOf(current), current.next_seq);
    }

    // ── Step 3. Mint N LogEntries with contiguous seqs. ─────────────
    // All entries share `session` (one session per logical commit) and
    // a single commit instant: `lsn`'s timestamp and `commit_ts` are
    // derived from ONE clock read so they can't drift apart under skew
    // (a reader validates `commit_ts` against `LAG_WINDOW_MILLIS`, and
    // two independent reads could straddle that band). Intra-batch
    // ordering is by `seq` (the `countKey` lsn suffix), not the shared
    // timestamp, so one instant for the whole batch is correct.
    const commitNowMs = Date.now();
    const commitTs = new Date(commitNowMs).toISOString();
    const lsnTimestamp = timestamp(commitNowMs);
    const entries: LogEntry[] = [];
    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i]!;
      const seq = current.next_seq + i;
      const lsn = `${lsnTimestamp}_${session}_${countKey(seq)}`;
      const entry: LogEntry = {
        lsn,
        commit_ts: commitTs,
        op: input.op,
        collection: input.collection,
        doc_id: input.docId,
        session,
        seq,
        ...(input.op !== "D" && input.body !== undefined ? { after: input.body } : {}),
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
      };
      entries.push(entry);
    }

    // ── Step 4. PUT content bodies + index entries in parallel. ─────
    // Content PUT: `ifNoneMatch: "*"` makes a same-hash re-write a
    // no-op (412 swallowed). Crash-recovery and same-body replay
    // both rely on this idempotency property.
    //
    // Index PUT: each declared index emits one zero-byte PUT per new
    // key. On `U` / `D` the pre-image is sourced from an earlier
    // same-`docId` input in this commit's input array (if any) before
    // falling back to a log back-walk — preserves correctness for an
    // `[I, U]` or `[U, D]` input array. (Always length 1 today; this is
    // the retained dead-generality the `#singleAttemptCommit` header notes.)
    //
    // Empty `#indexes` short-circuits the index block (including the
    // pre-image GET), preserving zero behaviour change for
    // collections without declared indexes.
    //
    // Filter-aware projection (T4): `allIndexKeysFor` short-circuits
    // on `def.predicate` miss. The writer's diff `oldKeys` vs
    // `newKeys` transparently covers all four U-quadrants without any
    // structural change here:
    //
    //   match → match : both non-empty; diff PUTs/DELETEs as today.
    //   match → miss  : oldKeys non-empty, newKeys empty → DELETE all.
    //   miss  → match : oldKeys empty, newKeys non-empty → PUT all.
    //   miss  → miss  : both empty → no-op for this def.
    //
    // All four quadrants are pinned by named tests in
    // `writer.test.ts` ("Writer — filtered index"). Do
    // not collapse them into one combined case — a regression in one
    // quadrant should fail exactly one named test so the bug is
    // localisable.
    let contentPutCount = 0;
    let indexClassA = 0;
    const parallelPuts: Array<Promise<unknown>> = [];
    // Per-docId in-batch image map: tracks the latest post-image
    // each input lays down so a later input on the same docId reads
    // the in-batch pre-image, not the on-disk one.
    const inBatchImage = new Map<string, DocumentData | undefined>();
    for (const input of inputs) {
      if (input.op !== "D" && input.body !== undefined) {
        contentPutCount++;
        const bytes = encodeJsonBytes(input.body);
        const version = await versionFromContent(bytes);
        const contentKey = `${logPrefix}/content/${version}.json`;
        parallelPuts.push(
          this.#storage
            .put(contentKey, bytes, { ifNoneMatch: "*", contentType: APPLICATION_JSON })
            .catch((error: unknown) => {
              this.#observe429(error, input.collection);
              if (isPreconditionFailed(error)) {
                return;
              }
              throw error;
            }),
        );
      }
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
              .catch((error: unknown) => {
                this.#observe429(error, input.collection);
                if (isPreconditionFailed(error)) {
                  return;
                }
                throw error;
              }),
          );
        }
        for (const k of staleKeys) {
          // Storage.delete is contractually idempotent — no defensive catch.
          parallelPuts.push(this.#storage.delete(k));
        }
        indexClassA += newKeys.length + staleKeys.length;
        if (newKeys.length + staleKeys.length > 0) {
          ctxMetrics().histogram(
            "db.write.index_ops_per_logical_write",
            newKeys.length + staleKeys.length,
            { collection: input.collection },
          );
        }
        inBatchImage.set(input.docId, input.op === "D" ? undefined : input.body);
      }
    }
    await Promise.all(parallelPuts);

    // ── Step 5. PUT log entries. ────────────────────────────────────
    // `ifNoneMatch: "*"` per entry. On 412 we bump the counter and
    // record the rejection; the disposition (adopt vs surface) is
    // computed below from the aggregated results.
    //
    // Two cases on 412:
    //   (a) a peer wrote a DIFFERENT entry at the same seq — we lost
    //       the race; the caller's CAS will also fail.
    //   (b) (single-input commit only) our OWN previous attempt
    //       landed step 5 but lost step 6, and we're now re-driving
    //       the same logical commit. Adopt it and proceed to CAS so
    //       the advance gets a chance to commit.
    //
    // We discriminate by `session`: the random per-call id uniquely
    // identifies "our own previous attempt." Adoption is only safe
    // when there's exactly one entry to compare — always true now that
    // `commit` (N=1) is the sole caller. The non-adopting path
    // (`adoptOwnSessionOnLogConflict: false`) is currently unreached; it
    // surfaced log-PUT 412s as `Conflict` for the removed batch commit.
    type LogPutOutcome = { readonly ok: true } | { readonly ok: false };
    const logPutOne = async (entry: LogEntry): Promise<LogPutOutcome> => {
      const logEntryKey = logObjectKey(logPrefix, entry.seq);
      const logBytes = encodeJsonBytes(entry);
      try {
        await this.#storage.put(logEntryKey, logBytes, {
          ifNoneMatch: "*",
          contentType: APPLICATION_JSON,
        });
        return { ok: true };
      } catch (error) {
        this.#observe429(error, entry.collection);
        if (!isPreconditionFailed(error)) {
          throw error;
        }
        ctxMetrics().counter("db.r2.put.412_total", 1, {
          collection: entry.collection,
          step: "log-put",
        });
        return { ok: false };
      }
    };
    const logPutResults = await Promise.all(entries.map(logPutOne));
    let committedEntries: readonly LogEntry[] = entries;
    const firstConflictIdx = logPutResults.findIndex((r) => !r.ok);
    if (firstConflictIdx !== -1) {
      const conflictedEntry = entries[firstConflictIdx]!;
      const logEntryKey = logObjectKey(logPrefix, conflictedEntry.seq);
      if (adoptOwnSessionOnLogConflict) {
        const existing = await readLogEntry(this.#storage, logEntryKey);
        const decision = tryAdoptOwnSessionLogEntry({
          self: conflictedEntry,
          existing,
          batchSize: inputs.length,
        });
        if (decision.adopt) {
          committedEntries = [decision.entry];
        } else {
          throw new BaerlyError(
            "Conflict",
            `${errorPrefix}: log entry already exists at ${logEntryKey}; ${decision.reason}`,
          );
        }
      } else {
        throw new BaerlyError(
          "Conflict",
          `${errorPrefix}: log entry already exists at ${logEntryKey}; peer wrote our seq`,
        );
      }
    }

    // ── Step 6. CAS-advance current.json with If-Match. ─────────────
    // Bind to `baseEtag` from step 1 — re-reading would risk advancing
    // `next_seq` past a seq we never wrote a log entry for.
    //
    // Accumulate `tail_bytes` EXACTLY. The compactor later subtracts the
    // bytes of the log objects it folds, summed from the fetched object
    // bodies — i.e. exactly what the writer PUT per entry
    // (`encodeJsonBytes(entry)` in `logPutOne`). Counting the writer-add
    // and the compactor-subtract over the identical bytes keeps
    // `tail_bytes` exact under the full-fence CAS. Sum over
    // `committedEntries` (the source of truth for what's actually in the
    // tail — `entries` normally, or the single adopted entry on the
    // own-session-adoption path), NOT `inputs`.
    const batchLogBytes = committedEntries.reduce(
      (sum, e) => sum + encodeJsonBytes(e).byteLength,
      0,
    );
    const next: CurrentJson = {
      ...current,
      next_seq: current.next_seq + inputs.length,
      tail_bytes: current.tail_bytes + batchLogBytes,
    };
    // Cadence-invariant assert (cheap, load-bearing). The GC write-tick
    // cadence keys off `next_seq` advancing by exactly the number of log
    // entries written. Today one input ⇒ one log entry, so `next_seq`
    // advances by `inputs.length` and `committedEntries.length ===
    // inputs.length` (the adoption path adopts the single in-flight
    // entry of a 1-input commit, preserving the identity). Pin it so a
    // future change that makes one input emit ≠1 entries fails LOUD here
    // instead of silently skewing the GC cadence.
    if (next.next_seq - current.next_seq !== inputs.length) {
      throw new BaerlyError(
        "Internal",
        `${errorPrefix}: GC-cadence invariant violated — next_seq advanced by ${
          next.next_seq - current.next_seq
        } but ${inputs.length} input(s) were committed on ${this.#currentJsonKey}`,
      );
    }
    const nextBody = encodeJsonBytes(next);
    const putOpts: StoragePutOptions = {
      ifMatch: baseEtag,
      contentType: APPLICATION_JSON,
    };
    let result: StoragePutResult;
    try {
      result = await this.#storage.put(this.#currentJsonKey, nextBody, putOpts);
    } catch (error) {
      this.#observe429(error, inputs[0]!.collection);
      if (isPreconditionFailed(error)) {
        ctxMetrics().counter("db.r2.put.412_total", 1, {
          collection: inputs[0]!.collection,
          step: "current-json-cas",
        });
        throw new BaerlyError(
          "Conflict",
          `${errorPrefix}: CAS conflict on ${this.#currentJsonKey}`,
        );
      }
      throw error;
    }

    // ── Step 6b. Write-tick maintenance dispatch. ───────────────────
    // Single funnel site: write-tick maintenance dispatch. Reached by
    // `commit()` exactly once per logical commit (a CAS retry re-enters
    // this helper and dispatches once per successful attempt — but a
    // successful CAS ends the retry loop, so a logical commit
    // dispatches once). Sits
    // BEFORE the caller's `#verifyFenceUnchanged` — a write that then
    // fails its fence check may have paid for one bounded maintenance
    // pass; that's the intended single funnel, bounded and safe.
    //
    // Config rides the per-request observability context
    // (`getCurrentContext()?.maintenance`), set by the adapter — NOT the
    // Writer constructor / `Db.create`. Absent ⇒ inline dispatch +
    // CF-free-safe caps, so a bare `Db.create(...).collection(...)
    // .insert(...)` maintains inline by default once enough writes
    // accrue.
    const prevSeq = current.next_seq; // pre-CAS seq, already in scope
    const maint = getCurrentContext()?.maintenance;
    if (maint?.disabled !== true) {
      // Same absent-context default as runBoundedMaintenance's
      // `options?.profile ?? MAINTENANCE_PROFILE_CF_FREE` — keep the two in
      // step (this gate reads only gcInterval; the runner resolves the whole
      // profile) so the pre-fire cadence can't diverge from the fold's.
      const gcInterval =
        maint?.options?.profile?.gcInterval ?? MAINTENANCE_PROFILE_CF_FREE.gcInterval;
      if (shouldFireMaintenance(next, prevSeq, gcInterval)) {
        const dispatch = maint?.dispatch ?? dispatchInlineAwaited;
        // `await dispatch(...)`: `dispatchInlineAwaited` returns the
        // task's promise (awaited inline — deterministic for tests +
        // correct for serverful Node). A `ctx.waitUntil`-style dispatch
        // returns void (fire-and-forget off the ack); `await void` is a
        // no-op. The `.then(() => {}, () => {})` is belt-and-suspenders:
        // `runBoundedMaintenance` already swallows internally, but this
        // guarantees a dispatched task can NEVER reject the commit even
        // if a future change makes it throw.
        await dispatch(() =>
          runBoundedMaintenance(
            {
              storage: this.#storage,
              currentJsonKey: this.#currentJsonKey,
              prevSeq,
              // `disabled` is intentionally NOT forwarded: the outer
              // `maint?.disabled !== true` gate already guarantees we only
              // reach here when maintenance is enabled, so passing it would
              // only ever forward `false` (a no-op) and imply a coupling
              // that doesn't exist.
              ...(maint?.maxFoldBytes !== undefined && { maxFoldBytes: maint.maxFoldBytes }),
            },
            maint?.options,
          ).then(
            () => {},
            () => {},
          ),
        );
      }
    }

    // Step 7 — the fence-verify GET — lives in the caller, not here.
    // Both fence-bump and a 412-driven CAS retry use
    // `BaerlyError{code:"Conflict"}`; keeping the fence check outside
    // this helper's body lets the caller's retry-catch arm
    // (`isPreconditionFailed`) match ONLY retryable conflicts thrown
    // from inside, while the fence-bump throw propagates.

    // Base class-A op count for this attempt: content PUTs (skipping
    // `op:"D"`) + log PUTs (= N) + index PUTs + index DELETEs + 1
    // current.json CAS. The fence-verify GET is Class B and excluded.
    // The caller of `commit()` adds `(attempt - 1)` for retry cost.
    const classAOps = contentPutCount + entries.length + indexClassA + 1;
    return {
      entries: committedEntries,
      currentEtag: result.etag,
      classAOps,
      expectedEpoch,
    };
  }

  /**
   * Read the pre-image content body for a doc by walking the live
   * log backwards from `currentNextSeq` looking for the
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
   */
  /**
   * Auto-create the per-collection `current.json` at
   * `this.#currentJsonKey` with a zero-state initial manifest. Called
   * by `#singleAttemptCommit` when the read returned `null` (fresh
   * bucket / fresh collection).
   *
   * Concurrency: `createCurrentJson` uses `If-None-Match: "*"`. If a
   * peer raced us and won, the storage layer surfaces `Conflict`; we
   * recover by re-reading the now-present manifest. We do NOT retry
   * the create — a single recover-via-read covers every race that
   * could have produced our null read.
   *
   * The seed shape (`snapshot: null`, `next_seq: 0`, `log_seq_start:
   * 0`, `writer_fence: { epoch: 0, owner: "", claimed_at: "" }`)
   * matches `ensureTable` and `baerly deploy`'s pre-warm path, so an
   * operator who pre-provisions and a writer who auto-creates land
   * on byte-identical bytes.
   *
   * @throws BaerlyError code="InvalidResponse" — the post-recover
   *   re-read also returned null. Defensive guard; in practice
   *   unreachable because the Conflict implies the key now exists.
   */
  async #provisionCurrentJson(): Promise<CurrentJsonRead> {
    const initial: CurrentJson = {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      next_seq: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "", claimed_at: "" },
      tail_bytes: 0,
      snapshot_bytes: 0,
      snapshot_rows: 0,
    };
    try {
      return await createCurrentJson(this.#storage, this.#currentJsonKey, initial);
    } catch (error) {
      if (!(error instanceof BaerlyError) || error.code !== "Conflict") {
        throw error;
      }
    }
    const recovered = await readCurrentJson(this.#storage, this.#currentJsonKey);
    if (recovered === null) {
      throw new BaerlyError(
        "InvalidResponse",
        `Writer: current.json missing at ${this.#currentJsonKey} after auto-create raced and recover read returned null`,
      );
    }
    return recovered;
  }

  async #readPreImage(
    logPrefix: string,
    collection: string,
    docId: string,
    currentNextSeq: number,
  ): Promise<DocumentData | undefined> {
    // Walk newest-to-oldest so we hit the most-recent op first.
    // `s = -1` is the natural empty-bucket sentinel.
    for (let s = currentNextSeq - 1; s >= 0; s--) {
      const logKey = logObjectKey(logPrefix, s);
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
        entry = decodeJsonBytes<LogEntry>(got.body);
      } catch {
        // Malformed entry shouldn't propagate up the index-emission
        // path — let the outer commit's `#walkLog` (step 2) flag it
        // as the protocol violation. Skip.
        continue;
      }
      if (entry.collection !== collection || entry.doc_id !== docId) {
        continue;
      }
      if (entry.op === "D") {
        return undefined;
      } // last op was delete
      if ((entry.op === "I" || entry.op === "U") && entry.after !== undefined) {
        return entry.after;
      }
    }
    return undefined;
  }

  /**
   * Walk `log/<logSeqStart>.json` … `log/<nextSeq - 1>.json` with
   * bounded parallelism via `walkLogRange`. Materialised entries are
   * discarded — the walk's only job is to surface a hole or a
   * malformed body inside the visible range as
   * `BaerlyError{code:"Internal"}` / `"InvalidResponse"`.
   *
   * Gated on `verifyLogIntegrityOnCommit`; default off in production
   * because the per-doc fold already lives in the read path. See the
   * option's docstring for the rationale and the opt-in convention.
   *
   * `logSeqStart` is the boundary set by the compactor on
   * `current.json.log_seq_start`. Entries below it have been folded
   * into the snapshot and may have been swept off the bucket, so the
   * walk MUST NOT GET-require them.
   */
  async #walkLog(logPrefix: string, logSeqStart: number, nextSeq: number): Promise<void> {
    await walkLogRange(this.#storage, logPrefix, logSeqStart, nextSeq);
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
      ctxMetrics().counter("db.r2.put.429_total", 1, { collection });
    }
  }

  /**
   * Emit the per-logical-write `class_a_ops_per_logical_write`
   * histogram for `commit`. `classAOps` is the per-attempt base plus
   * a charge for prior failed attempts (the retry-budget cost model),
   * computed by the caller.
   */
  #emitWriteMetrics(collection: string, classAOps: number): void {
    ctxMetrics().histogram("db.write.class_a_ops_per_logical_write", classAOps, { collection });
  }

  /**
   * Re-read `current.json` after a successful CAS and assert the
   * writer-fence epoch is still ours. The CAS only mutated `next_seq`
   * (the fence is preserved from `current`), so a post-write epoch
   * mismatch can only mean another writer claimed the fence between
   * our step-1 read and step-6 PUT — the exact split-brain
   * `WriterFence` prevents. Throws `Conflict`; no retry, since the
   * stale writer must defer to the new authority.
   *
   * The fence-verify GET is Class B and intentionally NOT counted in
   * `class_a_ops_per_logical_write`.
   */
  async #verifyFenceUnchanged(expectedEpoch: number, where: string): Promise<void> {
    const postRead = await readCurrentJson(this.#storage, this.#currentJsonKey);
    if (postRead === null) {
      return;
    }
    if (postRead.json.writer_fence.epoch === expectedEpoch) {
      return;
    }
    throw new BaerlyError(
      "Conflict",
      `${where}: writer fence bumped from epoch ${expectedEpoch} to ${postRead.json.writer_fence.epoch} during commit on ${this.#currentJsonKey}; stale writer aborting`,
    );
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
    if (sleepMs <= 0) {
      return;
    }
    await new Promise<void>((r) => setTimeout(r, sleepMs));
  }
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

/**
 * `true` when the underlying storage surfaced a `PreconditionFailed`
 * 412 (or its non-S3 equivalents). Every in-tree {@link Storage} impl
 * surfaces a lost CAS as `BaerlyError{code:"Conflict"}`.
 */
const isPreconditionFailed = (err: unknown): boolean =>
  err instanceof BaerlyError && err.code === "Conflict";

/**
 * `true` when the underlying storage surfaced an R2 prefix-partition
 * rate-limit. {@link S3HttpStorage} stamps the upstream HTTP status
 * onto `BaerlyError.cause` as `{ status }`; we discriminate on that
 * structured field rather than regex-matching the message.
 */
const is429 = (err: unknown): boolean => {
  if (!(err instanceof BaerlyError) || err.code !== "NetworkError") {
    return false;
  }
  const cause = err.cause as { status?: number } | undefined;
  return cause?.status === 429;
};
