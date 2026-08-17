/**
 * `Writer` — stateless multi-instance write engine (single-write commit).
 *
 * Each {@link Writer.commit} reads `current.json` FRESH (for
 * `log_seq_start` / `tail_hint` as a probe FLOOR — a lower bound, NOT a
 * CAS precondition), publishes additive index markers, then **creates `log/<seq>`
 * via `If-None-Match: "*"`. That create IS the commit / linearization
 * point.** The writer writes NOTHING to `current.json` on the commit
 * path; `tail_hint` advances outside ordinary commits via compaction
 * folds, write-tick refreshes, and explicit operator/import paths. The
 * commit model and its invariants are recorded in ADR-004
 * (`docs/adr/004-single-write-commit.md`). The
 * optional integrity walk is gated by
 * {@link WriterOptions.verifyLogIntegrityOnCommit} (default off).
 *
 * No per-write cache: every commit re-reads + re-probes, so N stateless
 * instances contend at one place — the `If-None-Match` create of
 * `log/<seq>`. The loser gets a 412 and re-probes forward to the next
 * empty slot. A 412 from the writer's OWN session at the same seq is its
 * own lost-ack / crashed-but-durable commit → adopted (not retried), so
 * the write lands at EXACTLY `seq`, never duplicated.
 *
 * **Crash safety.** Order is additive index `newKeys` → `log/<seq>`
 * create → stale index-key DELETEs. `LogEntry.after` is the authoritative
 * post-image. A crash before the create leaves only orphan additive index
 * keys; a stray additive key only ever yields a false-POSITIVE candidate
 * that `matchesWire` (read path) drops. Emitting `newKeys` before the commit
 * means a committed row is ALWAYS index-findable; the stale-key DELETE
 * stays after the commit so a crash can never de-index a committed
 * doc. See `index-emit-order.test.ts` and ADR-004 Q4.
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
  certifiedDeleteFloor,
  createCurrentJson,
  decodeJsonBytes,
  encodeJsonBytes,
  logObjectKey,
  logSeqStartOf,
  mintGeneration,
  BaerlyError,
  noopMetricsRecorder,
  type Storage,
  LOG_FORWARD_PROBE_CAP,
  PREIMAGE_SCAN_MAX_GETS,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_TAIL_HINT_REFRESH_WRITES,
  S3_REQUEST_MAX_RETRIES,
  SESSION_ID_LENGTH,
  countKey,
  readCurrentJson,
  timestamp,
  uuid,
} from "@baerly/protocol";
import { assertDocId } from "./doc-id.ts";
import { allIndexKeysFor, type IndexDefinition, validateIndexDefinition } from "./indexes.ts";
import { assertKeyWithinLimit } from "./key-limit.ts";
import { readLogEntry, walkLogRange } from "./log-walk.ts";
import { findLogTail } from "./log-tail.ts";
import { tryAdoptOwnSessionLogEntry } from "./log-conflict-adoption.ts";
import {
  dispatchInlineAwaited,
  runBoundedMaintenance,
  shouldFireMaintenance,
} from "./maintenance.ts";
import { getCurrentContext } from "./observability/context.ts";

const CAS_CONFLICT_RESOLUTION = "Re-read and retry.";
const AMBIGUOUS_COMMIT_RESOLUTION =
  "Re-read the row before retrying: the mutation may already have been applied.";

const ctxMetrics = (): MetricsRecorder => getCurrentContext()?.recorder ?? noopMetricsRecorder;

/**
 * Tunables for {@link Writer}. All optional; defaults match the
 * legacy retry budget so the new loop is a drop-in replacement.
 */
export interface WriterOptions {
  /**
   * Max retryable `Conflict` attempts before throwing `Conflict`.
   * Foreign log-create 412s are resolved inside a single attempt by
   * occupant read-back plus bounded forward re-probe; this budget is
   * retained for future retryable conflicts and tests.
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
   * index (when the indexed field is set on the doc) — the additive
   * `newKeys` go down BEFORE the committing `log/<seq>` create, so a
   * committed row is always index-findable. On U/D, the writer reads
   * the prior `LogEntry.after` post-image from the log (one back-walk per
   * indexed collection, NOT per index) to compute the stale-key set;
   * stale keys are DELETE'd AFTER the commit, computed from the
   * resolved committing seq's pre-image.
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
   * `[log_seq_start, tail_hint)` before minting a new entry, surfacing
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

  /**
   * ETag of `current.json` as read at the start of the commit. The
   * commit path no longer writes `current.json` (the `log/<seq>`
   * create IS the commit), so this is the manifest's pre-commit ETag,
   * not a post-write one.
   */
  readonly currentEtag: string;

  /** How many commit attempts it took (1 = first try won). */
  readonly attempts: number;
}

const DEFAULT_INITIAL_BACKOFF_MS = 25;
const MAX_BACKOFF_MS = 1500;
const APPLICATION_JSON = "application/json";

/**
 * Empty body for index entries. Each index entry is a fact ("doc
 * `<docId>` has `<field> = <value>`"), not data — readers list the
 * prefix, extract the doc id, then read its authoritative `LogEntry.after`.
 * Pre-allocated module-level constant so every index PUT shares one
 * zero-length buffer.
 */
const EMPTY_BODY = new Uint8Array(0);

/**
 * Successful outcome of one full {@link Writer.#singleAttemptCommit}
 * attempt. A retryable log-create 412 that resolved to a foreign-session
 * occupant beyond the forward-probe budget throws
 * `BaerlyError{code:"Conflict"}`; the caller catches via
 * {@link isPreconditionFailed} and decides whether to retry. Non-retryable
 * failures (protocol-invariant violations, network errors) propagate.
 */
interface SingleAttemptSuccess {
  readonly entries: readonly LogEntry[];
  readonly currentEtag: string;
  readonly classAOps: number;
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
     * log and index keys are derived from it.
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
   * Atomically commit one mutation. Reads `current.json` fresh (as a
   * probe FLOOR, not a CAS precondition), PUTs any additive index
   * `newKeys`, then creates `log/<seq>` via
   * `If-None-Match: "*"` — that create IS the commit (single-write
   * commit; no `current.json` CAS follows it). Stale index keys are
   * DELETE'd after the commit.
   *
   * The hot-path cost under no contention on an unindexed collection is
   * 3 GETs + 1 PUT: the Step 1 `current.json` read, `findLogTail`'s
   * forward probe (one 404 GET when `tail_hint` is accurate, `O(log gap)`
   * GETs when it lags a fold interval), the committing `log/<seq>`
   * create, and the post-create `current.json` re-read that rejects a
   * create landing below the certified delete floor
   * (`#assertCommitAboveDeleteFloor`). Each
   * declared index that projects a key on this write adds one PUT
   * (new key, before the commit) and, on U/D, up to one DELETE (stale
   * key, after the commit). An in-flight peer write costs one extra GET
   * + the backoff sleep per retry.
   *
   * Idempotency: `LogEntry.after` carries the full post-image, and the
   * `log/<seq>` create uses `If-None-Match: "*"`, so two writers racing
   * the same tail cause
   * exactly one create to win; the loser reads back the occupant,
   * adopts its own lost-ack write or re-probes forward to the next
   * empty slot.
   *
   * **At-least-once under one fault.** If the committing create wins at a
   * `seq` the collection has already certified deleted — reachable when a
   * create PUT or a lost-ack retry straddles a fold plus a retirement pass —
   * the object it wrote is beneath every reader's floor. The commit then fails
   * with `AmbiguousCommit` rather than acknowledging a mutation no fresh
   * reader can see. The writer cannot tell whether an earlier attempt of its
   * own landed and was folded before retirement removed the slot, so the
   * mutation may or may not have been applied: retrying is the intended
   * recovery and may apply it twice. `err.retriable` is `false` precisely so a
   * generic conflict-retry wrapper cannot absorb this silently. Every other
   * path remains exactly-once.
   *
   * @throws BaerlyError code="AmbiguousCommit" when the committing create
   *   landed below `min(log_delete_floor, log_seq_start)`. The mutation's fate
   *   is unknown; see the at-least-once note above.
   * @throws BaerlyError code="Conflict" when a retryable conflict
   *   escapes the single-attempt helper and exhausts the retry budget
   *   (presently unreachable on the log-create 412 path).
   * @throws BaerlyError code="Internal" when a log entry expected in
   *   `[0, tail_hint)` is missing — a protocol-invariant violation
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
    // Validate the doc id BEFORE any I/O so every commit caller — the
    // public write path AND a direct caller like `baerly admin restore`
    // — is covered (defense in depth, mirroring the db-layer guard).
    // Rejects empty / `"/"` / `"."`|`".."` / control / leading `"_"` /
    // overlong `docId` as `BaerlyError{code:"InvalidConfig"}`, so a
    // traversal-shaped `_id` can never become a written key segment.
    assertDocId(input.docId);
    const session = uuid().slice(0, SESSION_ID_LENGTH);
    const logPrefix = this.#currentJsonKey.slice(0, this.#currentJsonKey.lastIndexOf("/"));

    // NOTE: with the post-commit fence-verify removed, no `Conflict`
    // currently escapes `#singleAttemptCommit` — a log-create 412 is
    // always resolved internally (own-session adoption or a bounded
    // forward-probe to the next empty slot; only an exhausted probe cap
    // throws, as `Internal`, not `Conflict`). So the retry-catch arm and
    // the budget-exhausted `Conflict` throw below are presently
    // unreachable. They are retained deliberately: they cost nothing on
    // the happy path and re-arm automatically if a future change ever
    // re-introduces a retryable `Conflict` out of the helper.
    for (let attempt = 1; attempt <= this.#maxRetries; attempt++) {
      let success: SingleAttemptSuccess;
      try {
        success = await this.#singleAttemptCommit(input, session, logPrefix, "Writer");
      } catch (error) {
        // Only a retryable `Conflict` (see NOTE above — currently none)
        // backs off and retries. Anything else propagates.
        if (!isPreconditionFailed(error)) {
          throw error;
        }
        await this.#backoff(attempt);
        continue;
      }
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
      undefined,
      undefined,
      undefined,
      CAS_CONFLICT_RESOLUTION,
      true,
    );
  }

  /**
   * One full commit attempt — the body of {@link commit}. Reads
   * `current.json`, PUTs additive index `newKeys`,
   * then forward-probes the tail and creates `log/<seq>` once via
   * `If-None-Match: "*"` — the numbered log create IS the commit
   * (single-write commit; no `current.json` CAS follows it). Stale index
   * keys are DELETE'd after the commit. Returns the success payload.
   *
   * Commits exactly one {@link CommitInput} — the numbered log create is
   * the single linearization point per call.
   *
   * A log-create 412 is disambiguated by session read-back: own session
   * / own seq ⇒ our crashed-or-lost-ack commit is already durable ⇒
   * adopt; foreign session ⇒ re-probe forward and retry at the next
   * empty slot. Thrown `BaerlyError`s (Internal, InvalidResponse,
   * NetworkError) propagate.
   *
   * Crash safety invariant: additive index `newKeys` PUTs are awaited
   * before the log create. `LogEntry.after` is the authoritative post-image.
   * A crash before the create leaves orphan additive index keys only. A crash
   * AFTER the create is a durable, committed write at `seq` whose index
   * `newKeys` are already present (so it's index-findable); the only residual
   * is a possibly-undeleted stale OLD-value key, dropped by `matchesWire` and
   * cleaned by a later write / `rebuild-index`. The inverse — de-indexing a
   * committed doc — is never produced.
   */
  async #singleAttemptCommit(
    input: CommitInput,
    session: string,
    logPrefix: string,
    errorPrefix: string,
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

    // ── Step 2. Optional integrity walk (`verifyLogIntegrityOnCommit`,
    // default off). Surfaces missing / malformed entries inside
    // `[log_seq_start, tail_hint)` as `Internal` / `InvalidResponse`;
    // entries below `log_seq_start` are folded into the snapshot
    // by `compact()` and possibly swept by `runGc()`, so the walk is
    // bounded to the live tail. The read path catches the same
    // conditions on the next consult — production callers leave the
    // walk off to avoid `O(tail)` Class-B GETs per CAS attempt.
    if (this.#verifyLogIntegrityOnCommit) {
      await this.#walkLog(logPrefix, logSeqStartOf(current), current.tail_hint);
    }

    // ── Step 3. Find the true tail (Class B forward-probe), then mint. ─
    // `tail_hint` is a non-authoritative lower bound (the writer no
    // longer advances it — only the compactor stamps it durably). The
    // forward-probe discovers the first empty seq >= the floor: the slot
    // this commit will create. Floor at `max(log_seq_start, tail_hint)`
    // so a compactor that advanced `log_seq_start` past a stale
    // `tail_hint` doesn't make us re-walk folded-but-unswept entries.
    // Bind to a local (oxlint `no-await-expression-member`).
    const probeFloor = Math.max(logSeqStartOf(current), current.tail_hint);
    // `findLogTail`'s density precondition holds: the floor sits in the
    // dense prefix because tail_hint advancers probe or derive known tails
    // from committed entries, while ordinary writer commits never stamp
    // `tail_hint`, so nothing advances the floor past a hole.
    const preCommitTail = await findLogTail(this.#storage, logPrefix, probeFloor);
    let seq = preCommitTail;

    // All entries share `session` (one session per logical commit) and
    // a single commit instant: `lsn`'s timestamp and `commit_ts` are
    // derived from ONE clock read so they can't drift apart under skew
    // (a reader validates `commit_ts` against `LAG_WINDOW_MILLIS`, and
    // two independent reads could straddle that band). The LSN's
    // `countKey(seq)` suffix MUST track the probed seq — it's compared on
    // adoption, so a stale suffix would misfire the disambiguation.
    const commitNowMs = Date.now();
    const commitTs = new Date(commitNowMs).toISOString();
    const lsnTimestamp = timestamp(commitNowMs);
    const mintEntry = (atSeq: number): LogEntry => ({
      lsn: `${lsnTimestamp}_${session}_${countKey(atSeq)}`,
      commit_ts: commitTs,
      op: input.op,
      collection: input.collection,
      doc_id: input.docId,
      session,
      seq: atSeq,
      ...(input.op !== "D" && input.body !== undefined ? { after: input.body } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
    });
    let entry = mintEntry(seq);

    // ── Step 4. PUT additive index `newKeys` (BEFORE the commit). ───
    // Additive index `newKeys` (the markers for the doc's NEW value)
    // ALSO go down here, before the committing create. `newKeys`
    // depend only on `body` + `docId` (NOT on `seq`), so they're
    // stable across the forward re-probe — emit them once. Emitting
    // BEFORE the commit guarantees a committed row is ALWAYS index-
    // findable (no false-negative). A crash after a `newKey` PUT but
    // before the commit leaves an orphan additive key for an
    // UNcommitted write — benign: the index read includes the
    // candidate docId, the fold finds no committed (or the prior)
    // value, and `matchesWire` (query.ts) drops the false-positive.
    // The stale-key DELETEs (de-indexing the OLD value) stay AFTER the
    // commit (Step 5b), so a crash can never de-index a committed doc.
    // See ADR-004 Q4 + `index-emit-order.test.ts`.
    let newKeysClassA = 0;
    const parallelPuts: Array<Promise<unknown>> = [];
    // Additive index keys for the NEW value — emitted before the
    // commit on I/U (a D has no new value). `op:"D"` and a missing
    // body project to no keys. Empty `#indexes` short-circuits.
    if (this.#indexes.length > 0 && input.op !== "D") {
      const newKeys = allIndexKeysFor(logPrefix, this.#indexes, input.body, input.docId);
      for (const k of newKeys) {
        assertKeyWithinLimit(k);
        newKeysClassA++;
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
    }
    await Promise.all(parallelPuts);

    // ── Step 5. Create the commit: PUT log/<seq> via If-None-Match. ─
    // The numbered log create IS the commit (single-write commit). No
    // `current.json` CAS follows it — the create is the linearization
    // point (exactly-one-winner, CI-gated across all backends).
    //
    // 200 ⇒ committed at `seq`. 412 ⇒ disambiguate by session read-back:
    //   - own session / own seq ⇒ our crashed-or-lost-ack commit is
    //     already durable at `seq` ⇒ adopt the resolved `seq` and fall
    //     through to the SAME stale-key cleanup (Step 5b). The adopted
    //     commit is EXACTLY the attempt that may have died after creating
    //     `log/<seq>` but before deleting stale keys, so re-running the
    //     (idempotent) cleanup completes it.
    //   - foreign session / wrong seq ⇒ re-probe forward and retry at the
    //     new first-empty slot (bounded by LOG_FORWARD_PROBE_CAP).
    // A transient NetworkError (e.g. a dropped ack on a create that may
    // already have landed) retries the SAME `seq`: the retry either
    // re-creates (write never landed) or hits the durable write → 412 →
    // own-session adoption. Either way the write lands at EXACTLY `seq`,
    // never duplicated.
    let committedEntry: LogEntry = entry;
    let probes = 0;
    let transientRetries = 0;
    for (;;) {
      const logEntryKey = logObjectKey(logPrefix, seq);
      assertKeyWithinLimit(logEntryKey);
      let conflicted = false;
      try {
        await this.#storage.put(logEntryKey, encodeJsonBytes(entry), {
          ifNoneMatch: "*",
          contentType: APPLICATION_JSON,
        });
      } catch (error) {
        this.#observe429(error, entry.collection);
        if (isPreconditionFailed(error)) {
          ctxMetrics().counter("db.r2.put.412_total", 1, {
            collection: entry.collection,
            step: "log-put",
          });
          conflicted = true;
        } else if (isTransientWrite(error) && transientRetries < this.#maxRetries) {
          // Possible lost-ack — retry the SAME seq (idempotent: adoption
          // closes the double-commit window). Bounded backoff (full jitter,
          // same as the outer loop) so a backend in transient distress
          // isn't hammered; a persistent NetworkError still surfaces.
          transientRetries++;
          await this.#backoff(transientRetries);
          continue;
        } else {
          throw error;
        }
      }
      if (!conflicted) {
        committedEntry = entry;
        break;
      }
      // 412 — read back the occupant and decide.
      const existing = await readLogEntry(this.#storage, logEntryKey);
      const decision = tryAdoptOwnSessionLogEntry({
        self: entry,
        existing,
      });
      if (decision.adopt) {
        // Own crashed/lost-ack commit already durable at `seq`. Adopt it
        // (byte-identical to the attempted `entry`, INCLUDING `commit_ts`
        // — adoption compares the full entry) — the logical write lands at
        // EXACTLY `seq`, never duplicated. Fall through to Step 5b: the
        // adopted attempt may have died after the create but before the
        // stale-key cleanup, so the (idempotent) cleanup must still run.
        committedEntry = decision.entry;
        break;
      }
      // Foreign session (or wrong seq) — re-probe forward from seq+1 and
      // retry at the new first-empty slot, re-minting seq + LSN.
      if (++probes > LOG_FORWARD_PROBE_CAP) {
        throw new BaerlyError(
          "Internal",
          `${errorPrefix}: log-tail forward-probe exceeded ${LOG_FORWARD_PROBE_CAP} on ${this.#currentJsonKey}`,
        );
      }
      seq = await findLogTail(this.#storage, logPrefix, seq + 1);
      entry = mintEntry(seq);
    }

    // ── Step 5a. Refuse a create that re-filled a retired hole. ─────
    // Both break paths above land here with the resolved committing
    // `seq`: the fresh win and the own-session adoption. This check
    // runs BEFORE Step 5b on purpose — an invisible commit must not
    // get to delete the OLD value's index keys, because the doc's
    // live value may still BE that old value, and de-indexing it
    // would be the one failure the hybrid emission polarity exists to
    // prevent (invariant 7).
    await this.#assertCommitAboveDeleteFloor(logPrefix, seq, input.collection, errorPrefix);
    const committedEntries: readonly LogEntry[] = [committedEntry];

    // ── Step 5b. DELETE stale secondary-index keys (AFTER the commit). ─
    // The additive `newKeys` already went down in Step 4 (before the
    // commit), so a committed row is always index-findable. This block
    // handles only the OTHER half: deleting the OLD value's now-obsolete
    // markers. Keeping the stale-key DELETE AFTER the commit is the
    // load-bearing polarity (ADR-004 Q4): a crash here leaves the OLD
    // value's marker lingering — benign, the index read includes the
    // candidate, the fold sees the doc's NEW committed value, and
    // `matchesWire` (query.ts) drops the false-positive; the lingering
    // key is cleaned by a later same-doc write or operator
    // `rebuild-index`. The inverse — de-indexing a committed doc with no
    // log entry to drive repair — can NEVER happen, since the DELETE is
    // strictly after the commit.
    //
    // BOTH the fresh-win and the own-session-adoption break above reach
    // here with the resolved committing `seq`. Adoption correctness: an
    // adopted lost-ack commit is EXACTLY the attempt that may have died
    // after the create but before this DELETE, so it MUST run it too (do
    // not skip it). Idempotent under re-run: `Storage.delete` is
    // contractually idempotent, and the Step-4 `newKeys` PUT is
    // `ifNoneMatch: "*"` (412 swallowed).
    //
    // Empty `#indexes` short-circuits the whole block (including the
    // pre-image GET), preserving zero behaviour change for collections
    // without declared indexes. An `op:"I"` has no pre-image and no
    // stale keys, so it never reads.
    //
    // The pre-image is read at the RESOLVED committing `seq` (Step 5
    // may have advanced `seq` past a foreign winner): `#readPreImage`
    // back-walks from `seq - 1`, so it skips the just-committed entry
    // and finds the prior same-doc image.
    //
    // Filter-aware projection (T4): `allIndexKeysFor` short-circuits on
    // `def.predicate` miss. The diff `oldKeys \ newKeys` covers all four
    // U-quadrants (match→match deletes only the changed keys; match→miss
    // DELETEs all; miss→match deletes nothing; miss→miss no-ops), each
    // pinned by a named test in `writer.test.ts` ("Writer — filtered
    // index").
    const staleKeysClassA = await this.#cleanupStaleIndexKeysBestEffort({
      input,
      logPrefix,
      seq,
    });
    // The per-logical-write index-op histogram counts BOTH halves: the
    // `newKeys` PUTs (Step 4) and the `staleKeys` DELETEs (Step 5b).
    const indexClassA = newKeysClassA + staleKeysClassA;
    if (this.#indexes.length > 0 && indexClassA > 0) {
      ctxMetrics().histogram("db.write.index_ops_per_logical_write", indexClassA, {
        collection: input.collection,
      });
    }

    // ── Step 6. (removed). No current.json write on the commit path. ─
    // The numbered log create above IS the commit. `tail_hint` is
    // refreshed durably only by the compactor; the writer never advances
    // it. The maintenance trigger below reads a DERIVED tail-byte
    // estimate (`estimateTailBytes`), so there is no stored byte counter.

    // ── Step 6b. Write-tick maintenance dispatch. ───────────────────
    // Single funnel site: write-tick maintenance dispatch. Reached by
    // `commit()` exactly once per logical commit, after the committing
    // log create has landed.
    //
    // Config rides the per-request observability context
    // (`getCurrentContext()?.maintenance`), set by the adapter — NOT the
    // Writer constructor / `Db.create`. Absent ⇒ inline dispatch +
    // CF-free-safe caps, so a bare `Db.create(...).collection(...)
    // .insert(...)` maintains inline by default once enough writes
    // accrue.
    //
    // `prevSeq` is the pre-commit tail (`preCommitTail`); the slot we won
    // is `seq` (== prevSeq unless a forward re-probe moved it past a
    // foreign winner), so the boundary check spans `(prevSeq,
    // observedTail]`. `observedTail = seq+1` is a fresh in-memory lower
    // bound on the true tail: winning `log/<seq>` means `[tail_hint, seq)`
    // were observed occupied, so `seq+1 ≤ true tail`. We pass `current`
    // (the Step-1 read) for the snapshot fields — there is no `next`.
    const prevSeq = preCommitTail;
    const observedTail = seq + 1;
    const maint = getCurrentContext()?.maintenance;
    // Same absent-context default as runBoundedMaintenance's
    // `options?.profile ?? MAINTENANCE_PROFILE_CF_FREE` — keep the two in
    // step (this gate reads only gcInterval; the runner resolves the whole
    // profile) so the pre-fire cadence can't diverge from the fold's.
    const gcInterval =
      maint?.options?.profile?.gcInterval ?? MAINTENANCE_PROFILE_CF_FREE.gcInterval;
    const maintenanceDue =
      maint?.disabled === true
        ? observedTail - current.tail_hint >= MAINTENANCE_TAIL_HINT_REFRESH_WRITES
        : shouldFireMaintenance(current, prevSeq, gcInterval, observedTail);
    if (maintenanceDue) {
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
            // Thread the in-memory observed tail so the runner's Gate-1
            // ratio + GC cadence key off the true tail without an
            // O(gap) re-probe (the stored `tail_hint` is only a lower
            // bound under single-write commit).
            observedTail,
            // `disabled` disables fold/GC phases inside the runner but
            // still permits the bounded tail_hint refresh that prevents a
            // maintenance-off collection from drifting past the probe cap.
            ...(maint?.disabled === true && { disabled: true }),
            ...(maint?.maxFoldBytes !== undefined && { maxFoldBytes: maint.maxFoldBytes }),
          },
          maint?.options,
        ).then(
          () => {},
          () => {},
        ),
      );
    }

    // Base class-A op count for this attempt: the single log create +
    // index PUTs + index DELETEs.
    // No current.json CAS anymore. Forward-probe GETs are Class B and
    // excluded. The caller of `commit()` adds `(attempt - 1)` for retry
    // cost.
    const classAOps = 1 + indexClassA;
    return {
      entries: committedEntries,
      // No current.json write on the commit path — return the manifest
      // etag read in Step 1 (still a valid etag of the current manifest).
      currentEtag: baseEtag,
      classAOps,
    };
  }

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
   * The seed shape (`snapshot: null`, `tail_hint: 0`, `log_seq_start:
   * 0`, `writer_fence: { epoch: 0, owner: "", claimed_at: "" }`)
   * matches `ensureTable`, so an
   * operator who pre-provisions and a writer who auto-creates land on
   * equivalent state. NOT byte-identical any more: `generation` is a
   * fresh nonce per provisioner. That is harmless — `If-None-Match`
   * means exactly one of them ever lands, and no reader compares a
   * generation across provisioners, only against the cursor it minted.
   *
   * @throws BaerlyError code="InvalidResponse" — the post-recover
   *   re-read also returned null. Defensive guard; in practice
   *   unreachable because the Conflict implies the key now exists.
   */
  async #provisionCurrentJson(): Promise<CurrentJsonRead> {
    const initial: CurrentJson = {
      schema_version: CURRENT_JSON_SCHEMA_VERSION,
      snapshot: null,
      tail_hint: 0,
      log_seq_start: 0,
      writer_fence: { epoch: 0, owner: "", claimed_at: "" },
      snapshot_bytes: 0,
      snapshot_rows: 0,
      generation: mintGeneration(),
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

  async #cleanupStaleIndexKeysBestEffort(args: {
    input: CommitInput;
    logPrefix: string;
    seq: number;
  }): Promise<number> {
    if (this.#indexes.length === 0) {
      return 0;
    }

    const { input } = args;
    let staleKeys: readonly string[] = [];
    try {
      if (input.op === "U") {
        const preImage = await this.#readPreImage(
          args.logPrefix,
          input.collection,
          input.docId,
          args.seq,
        );
        const oldKeys = allIndexKeysFor(args.logPrefix, this.#indexes, preImage, input.docId);
        const newSet = new Set(
          allIndexKeysFor(args.logPrefix, this.#indexes, input.body, input.docId),
        );
        staleKeys = oldKeys.filter((k) => !newSet.has(k));
      } else if (input.op === "D") {
        const preImage = await this.#readPreImage(
          args.logPrefix,
          input.collection,
          input.docId,
          args.seq,
        );
        staleKeys = allIndexKeysFor(args.logPrefix, this.#indexes, preImage, input.docId);
      }
    } catch {
      ctxMetrics().counter("db.write.index_cleanup_errors_total", 1, {
        collection: input.collection,
        step: "pre-image-read",
      });
      return 0;
    }

    // (op:"I" has no pre-image → no stale keys.)
    const indexDeletes: Array<Promise<unknown>> = [];
    for (const k of staleKeys) {
      indexDeletes.push(
        this.#storage.delete(k).catch(() => {
          ctxMetrics().counter("db.write.index_cleanup_errors_total", 1, {
            collection: input.collection,
            step: "delete",
          });
        }),
      );
    }
    await Promise.all(indexDeletes);
    return staleKeys.length;
  }

  /**
   * Read a doc's pre-image from authoritative `LogEntry.after` payloads by walking the log
   * backwards from `currentNextSeq` looking for the most-recent I/U
   * entry on this `(collection, docId)`. Returns `undefined` when:
   *
   *   - the doc's most-recent op was `D` (tombstone — no live body);
   *   - no entry for this doc is found within the descent budget
   *     (a fresh-insert race, or the doc's last write has been folded
   *     into the snapshot and swept off the bucket).
   *
   * Used ONLY by the index-emission path's stale-key half (Step 5b, on
   * `U` / `D`) to compute which OLD-value keys to DELETE.
   *
   * **Not bounded by `log_seq_start`.** GC only marks sub-floor
   * entries and sweeps them a {@link GC_GRACE_PERIOD_MILLIS} (7-day)
   * grace later, so a doc's last I/U often survives below the floor
   * and is worth reading. The walk is 404-tolerant for a related
   * reason: a swept entry and a peer mid-CAS look identical from
   * here, so a hole cannot be a stop signal.
   *
   * **Cost, and what it buys.** One SEQUENTIAL GET per seq, hard-
   * capped at {@link PREIMAGE_SCAN_MAX_GETS}. The cap is load-bearing,
   * not a tuning knob: `seq` grows monotonically forever, so an
   * uncapped walk is O(seq) on the write path (post-commit but inline,
   * before the response) for any doc whose last entry GC has swept.
   * The cap is sized against the Cloudflare free-tier 50-subrequest
   * wall, which a `U` commit has already largely spent — the
   * derivation is on the constant. At that size the walk reaches a doc
   * rewritten within the last few log entries and nothing colder, so
   * on any collection with more than a handful of active docs it
   * normally finds nothing.
   *
   * That is the accepted trade, not a silent failure. Giving up is
   * benign by construction: the caller computes no stale keys, and an
   * extra index key is a false positive the read path drops
   * (`matchesWire`), never a missing candidate — `docs/spec/sync-
   * protocol.md` invariant 7. `rebuildIndex` (`./rebuild-index.ts`)
   * and `baerly admin fsck --indexes` are the authoritative
   * reconcilers. The give-up is deliberately NOT counted on
   * `db.write.index_cleanup_errors_total`: at this budget it is the
   * common path, so it would swamp the two entries on that counter
   * that do mean something went wrong (`"pre-image-read"` — the read
   * threw; `"delete"` — a stale-key DELETE failed).
   *
   * Reading below the floor cannot delete a LIVE index key: keys are
   * docId-scoped (`./indexes.ts`), and on `U` the caller diffs
   * `oldKeys \ newKeys`, so anything still live is in `newKeys`. The
   * residual hazard is the pre-existing compute-then-delete-after-
   * commit ABA (a peer may re-PUT a key between the diff and the
   * DELETE), which the cap narrows but does not close.
   */
  async #readPreImage(
    logPrefix: string,
    collection: string,
    docId: string,
    currentNextSeq: number,
  ): Promise<DocumentData | undefined> {
    // Walk newest-to-oldest so we hit the most-recent op first.
    // `s = -1` is the natural empty-bucket sentinel; `floor` is the
    // budget guard, NOT `log_seq_start` (see the docstring above).
    const floor = Math.max(0, currentNextSeq - PREIMAGE_SCAN_MAX_GETS);
    for (let s = currentNextSeq - 1; s >= floor; s--) {
      const logKey = logObjectKey(logPrefix, s);
      const got = await this.#storage.get(logKey);
      if (got === null) {
        // A hole — either the entry was folded and swept, or a peer
        // is mid-CAS on a write we don't see yet. Indistinguishable
        // from here, so a hole cannot be a stop signal: keep
        // descending until the budget runs out. The rebuild command
        // (`rebuildIndex`) handles holes by re-projecting from the
        // snapshot.
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
    // Fell through: either the budget stopped the walk or the doc
    // genuinely has no prior image. Both are reported the same way and
    // neither is counted — see the docstring on why a give-up counter
    // would be noise at this budget.
    return undefined;
  }

  /**
   * Fail the commit if the create landed at a sequence the collection has
   * already certified deleted.
   *
   * **What a sub-floor `seq` proves, and what it does not.** A winning
   * `If-None-Match: "*"` create means the slot was empty immediately before the
   * PUT, so the object this commit just wrote sits beneath every reader's floor
   * and no reader will ever consult it. What a sub-floor `seq` does NOT prove
   * is that the *logical mutation* is invisible. Two histories reach this
   * branch: the create re-filled a hole retirement had already certified
   * deleted (invisible — the defect this check exists for), or it landed in a
   * live empty slot that a fold and then a retirement pass swept out from under
   * it (visible through the snapshot). That second history is a real
   * over-rejection, pinned as contract by a test in
   * `./log-retirement-aba.test.ts`, not an accident. It is the safe direction,
   * and "What the caller is being told" below is why guessing between the two
   * is worse than reporting both as ambiguous.
   *
   * **`log_delete_floor <= seq < log_seq_start` is NOT a failure.** Not because
   * that band is provably safe — it is undecidable in the very same way. A
   * winning create means the slot was empty just before the PUT, so what a fold
   * absorbed there was either an earlier attempt of ours (mutation visible) or
   * a foreign writer's entry (ours invisible), and the fold keeps no writer
   * identity to tell them apart. The band is accepted because keying the check
   * on `log_seq_start` would reject ordinary post-fold commits — a far
   * larger harm than the residual it would catch. That residual is the
   * invisible half of the undecidable band `docs/spec/sync-protocol.md`
   * invariant 5 describes; it is not reachable by the certified-floor check,
   * by construction.
   *
   * The floor is clamped to `min(log_delete_floor, log_seq_start)` for the
   * reason invariant 12 gives: the `<= log_seq_start` bound is
   * transition-scoped, so an out-of-bound stored floor is readable off disk
   * and would otherwise fail a perfectly good commit.
   *
   * **What the caller is being told.** Not "your write failed" —
   * `AmbiguousCommit`. An earlier attempt by this same writer may have landed
   * and been folded before retirement removed the slot, and nothing durable
   * distinguishes that history from a foreign writer's entry being folded
   * instead: the fold keeps no writer identity, tombstones are purged,
   * `current.json` holds no per-writer completion state, and `writer_fence` is
   * not a replay filter (invariant 11). So the write contract under this fault
   * is at-least-once, and re-probing-and-re-applying is emphatically not a
   * safe default: `LogEntry.after` is a full post-image, so a duplicate
   * clobbers a concurrent newer value and mints a second `lsn` for one logical
   * mutation.
   *
   * The phantom object is DELETEd best-effort, and it is the only thing
   * standing between a rejected commit and a permanently leaked object.
   * Nothing reclaims the phantom afterwards: it sits at a seq *below*
   * `log_delete_floor` — that is the precondition for reaching this branch —
   * and `computeRetirableRange` (`./log-retention.ts`) *starts* at the
   * certified floor, so retirement never revisits a slot beneath its own
   * floor. GC does not reclaim log objects at all. So a `cleanup: "failed"`
   * on `db.write.ambiguous_commit_total` is a genuine permanent leak, not a
   * deferral. Deleting it is safe: no reader may read below the certified
   * floor (invariant 5), and the one deliberate sub-floor reader,
   * `#readPreImage`, treats a hole as "keep descending" rather than a stop
   * signal. A failed cleanup is recorded on the counter and never masks the
   * throw.
   *
   * **The Step 4 additive index keys are left behind.** The failure path does
   * not roll back the `newKeys` PUTs, and deliberately so — it is the same
   * benign residual invariant 7 already covers. If the mutation did land, those
   * keys are correct; if it did not, each is a false-positive candidate that
   * `matchesWire` drops on read, never a missing one.
   *
   * **A failed manifest read skips the check rather than failing the commit —
   * except an abort, which propagates.** The check runs over an already-durable
   * create, and an unreadable manifest is no evidence of a sub-floor `seq`, so a
   * transient read failure is swallowed. An `AbortError` is rethrown instead: it
   * is the caller's own cancellation rather than a blip, and it carries none of
   * the `retriable` re-run hazard that motivates swallowing the rest. The skip
   * is recorded on `db.write.delete_floor_check_skipped_total` so a sustained
   * rate is visible to an operator rather than silent.
   *
   * Cost: one Class B GET per commit.
   * `billableClassAOps = puts + lists` excludes GET, so billing is unchanged;
   * the subrequest arithmetic on {@link PREIMAGE_SCAN_MAX_GETS} carries the
   * re-derivation.
   *
   * @throws BaerlyError code="AmbiguousCommit"
   */
  async #assertCommitAboveDeleteFloor(
    logPrefix: string,
    seq: number,
    collection: string,
    errorPrefix: string,
  ): Promise<void> {
    let read: CurrentJsonRead | null;
    try {
      read = await readCurrentJson(this.#storage, this.#currentJsonKey);
    } catch (error) {
      if (isAbortError(error)) {
        // An abort is the caller's deliberate cancellation, not a transient
        // blip, and the caller already knows it cancelled. The hazard the
        // swallow below exists for is specific to `retriable` errors; an
        // `AbortError` is not one, so rethrowing costs that reasoning nothing.
        throw error;
      }
      // A failed read is not evidence of a sub-floor commit, so skipping the
      // check preserves the pre-existing commit contract exactly and forgoes
      // only a safety net on a rare blip. Propagating instead would be worse
      // than useless: the create already committed, and `NetworkError` is
      // `retriable`, so a generic retry wrapper would re-run the whole logical
      // write at a fresh tail — duplicating the mutation and minting a second
      // `lsn`. The other post-create steps here swallow their non-abort
      // failures for the same reason (`#cleanupStaleIndexKeysBestEffort`, the
      // maintenance dispatch). Failing closed is not the answer either
      // — throwing `AmbiguousCommit` on an unreadable manifest would reject
      // durable commits far more often than the fault this check catches.
      ctxMetrics().counter("db.write.delete_floor_check_skipped_total", 1, { collection });
      return;
    }
    if (read === null) {
      // The manifest vanished between Step 1 and here. Unreachable in
      // practice (Step 1 read or provisioned it), and a missing manifest
      // certifies no deleted prefix, so there is nothing to reject against.
      return;
    }
    const deleteFloor = certifiedDeleteFloor(read.json);
    // `deleteFloor === 0` means no deleted prefix is certified — same silent
    // arm as `Db.assertAtOrAboveLogFloor`.
    if (deleteFloor <= 0 || seq >= deleteFloor) {
      return;
    }
    let cleanup: "deleted" | "failed" = "deleted";
    await this.#storage.delete(logObjectKey(logPrefix, seq)).catch(() => {
      cleanup = "failed";
    });
    ctxMetrics().counter("db.write.ambiguous_commit_total", 1, { collection, cleanup });
    throw new BaerlyError(
      "AmbiguousCommit",
      `${errorPrefix}: the committing create at seq ${seq} on ${this.#currentJsonKey} landed below the certified delete floor ${deleteFloor}; that log object is beneath every reader's floor, and this mutation may or may not have been applied by an earlier attempt — retry is at-least-once`,
      undefined,
      undefined,
      undefined,
      AMBIGUOUS_COMMIT_RESOLUTION,
    );
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
 * `true` when a log-create PUT failed transiently (a `NetworkError`) —
 * the write may or may not have landed (a dropped ack). Safe to retry
 * the SAME seq: own-session adoption closes the double-commit window if
 * it did land. NOT a 412 (that's handled by adoption directly).
 */
const isTransientWrite = (err: unknown): boolean =>
  err instanceof BaerlyError && err.code === "NetworkError";

/**
 * `true` when a rejection is an `AbortError` — the caller's own cancellation
 * through an `AbortSignal`, never a transient storage failure. Matched
 * structurally on `name` rather than `instanceof DOMException` because a host
 * may surface an abort as a plain `Error` so named (as `Storage` impls and the
 * test fixtures do). `@baerly/client` carries the same predicate; it is
 * duplicated rather than shared because `server` may not import `client`
 * (`scripts/lint-package-layers.mjs`) and one predicate does not earn a new
 * module in `@baerly/protocol`.
 */
const isAbortError = (err: unknown): boolean =>
  typeof err === "object" && err !== null && "name" in err && err.name === "AbortError";

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
