/**
 * `Writer` — stateless multi-instance write engine (single-write commit).
 *
 * Each {@link Writer.commit} reads `current.json` FRESH (for
 * `log_seq_start` / `tail_hint` as a probe FLOOR — a lower bound, NOT a
 * CAS precondition), then **creates `log/<seq>` via `If-None-Match: "*"`.
 * That create IS the commit / linearization point.** The writer writes NOTHING to `current.json` on the commit
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
 * **First insert wins.** An `I` carrying {@link CommitInput.insertGuard}
 * reads the log window its caller's absence check could not see and
 * refuses to commit over a live row a peer's `I` put there
 * (`AlreadyExists`), so of concurrent inserts of one `doc_id` at most one
 * commits (exactly one, absent storage failures). See {@link InsertGuard}
 * and `docs/spec/sync-protocol.md` §"Insert: the first `I` wins".
 *
 * **Caller re-decisions.** A {@link CommitAdmission} re-runs the caller's
 * decision over the same window; its verdict may replace a `U`'s
 * post-image, which the write verbs use to re-apply an update to the
 * newest version of its row. See {@link CommitVerdict} and
 * `docs/spec/sync-protocol.md` §"Update and delete: decided on the newest
 * row version".
 *
 * **Crash safety.** The `log/<seq>` create is the commit's only write.
 * `LogEntry.after` is the authoritative post-image, so a crash before the
 * create leaves nothing of the commit on the bucket, and a crash after it
 * leaves a durable commit. The writer maintains no secondary objects:
 * declared indexes change no storage call (ADR-004 Q4, superseded in 0.7).
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
  assertDocumentSize,
  CODE_RESOLUTIONS,
  COMMIT_RESOLUTION_RESERVE,
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
  isWriteConflict,
  noopMetricsRecorder,
  type Storage,
  LOG_FORWARD_PROBE_CAP,
  MAX_PARALLEL_LOG_READS,
  MAINTENANCE_PROFILE_CF_FREE,
  MAINTENANCE_TAIL_HINT_REFRESH_WRITES,
  SESSION_ID_LENGTH,
  STORAGE_RETRY_MAX_ATTEMPTS,
  countKey,
  readCurrentJson,
  timestamp,
  uuid,
} from "@baerly/protocol";
import {
  assertDocId,
  assertStoredDocId,
  insertAlreadyExists,
  insertReplaysRow,
  recordInsertReplay,
} from "./doc-id.ts";
import { assertKeyWithinLimit } from "./key-limit.ts";
import { walkLogRange } from "./log-walk.ts";
import { findLogTail, probeTailFrom } from "./log-tail.ts";
import { tryAdoptOwnSessionLogEntry } from "./log-conflict-adoption.ts";
import { dispatchWriteTick, shouldFireMaintenance } from "./maintenance.ts";
import type { InternalBoundedMaintenanceOptions } from "./maintenance-options.ts";
import { getCurrentContext, runWithContext } from "./observability/context.ts";
import { assertPostImageIdentity } from "./post-image-identity.ts";
import { isOwnCollection } from "./collection-alias.ts";

const ctxMetrics = (): MetricsRecorder => getCurrentContext()?.recorder ?? noopMetricsRecorder;

/**
 * Tunables for {@link Writer}. All optional.
 *
 * There is no Writer retry knob: the `Storage` adapter retries each
 * request under the one storage retry policy, and the Writer resolves an
 * uncertain log create by occupant readback rather than resending it.
 */
export interface WriterOptions {
  /**
   * When `true`, every commit walks the live log range
   * `[log_seq_start, tail_hint)` before minting a new entry, surfacing
   * a missing or malformed entry as `BaerlyError{code:"Internal"}`
   * (or `"InvalidResponse"` for parse failures). The walk is purely
   * observational — the per-doc fold lives in the read path
   * (`./query.ts`) and any hole inside the visible range would also
   * fire on the next read.
   *
   * Production callers default this OFF: the walk issues `O(tail)`
   * Class-B GETs on every commit. Tests
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

  /**
   * The document primary key. Becomes {@link LogEntry.doc_id}. Must be
   * NFC for `I` / `U`; a `D` accepts any key-safe id, so a row stored
   * under a non-NFC id by an earlier release stays deletable.
   */
  readonly docId: string;

  /**
   * For `I` / `U`: the post-image. Becomes {@link LogEntry.after}. Must
   * be `undefined` for `op: "D"`.
   */
  readonly body?: DocumentData;

  /** Optional ISO-8601 origin marker; becomes {@link LogEntry.origin}. */
  readonly origin?: string;

  /**
   * First-insert-wins guard. Valid only with `op: "I"`; any other op
   * throws `InvalidConfig` before I/O. See {@link InsertGuard}.
   *
   * @internal — set by `Collection.insert` (`runInsert` in `./query.ts`).
   */
  readonly insertGuard?: InsertGuard;

  /**
   * Force the post-commit maintenance tick (main-10 G6): dispatch it even
   * when the ratio-OR-boundary gate is closed, and let it bypass Gate 1
   * inside the runner. Ignored under `BAERLY_MAINTENANCE_DISABLE`.
   *
   * @internal — set by the write verbs in `./query.ts` while a growth
   * write would be refused (`capacityDecision`'s `pressure`).
   */
  readonly forceMaintenance?: boolean;

  /**
   * Commit-time re-check of a decision the caller made at a log tail it
   * read (main-10 G5-race). See {@link CommitAdmission}.
   *
   * @internal — set by the write verbs in `./query.ts` for the capacity
   * re-check (`capacityDecision`).
   */
  readonly admission?: CommitAdmission;
}

/**
 * Backward validation of a caller's decision, like {@link InsertGuard}
 * but with the decision supplied by the caller. The caller decided to
 * commit from the collection state folded through log tail `fromSeq`.
 * The writer reads every log entry in `[fromSeq, seq)` (the same window
 * read as the insert guard, shared with it when both are set) and passes
 * it to `check` before the first create, and again with the longer
 * window after each lost create race, before the next create.
 * `check` throws to refuse; nothing is committed. It may instead return a
 * {@link CommitVerdict} whose `body` replaces a `U`'s post-image: the
 * write verbs re-apply an update to the newest version of its row this
 * way (EvalPlanQual; `docs/spec/sync-protocol.md` §"Update and delete:
 * decided on the newest row version").
 *
 * Precondition: `fromSeq` is a tail a read-path probe observed on this
 * collection's log, or one past a seq the caller's own commit landed at.
 * With an `insertGuard`, it must equal `absentBelowSeq`.
 *
 * @internal
 */
export interface CommitAdmission {
  /** The log tail the caller's decision folded through. */
  readonly fromSeq: number;
  /**
   * Re-decide over `window`, every entry in `[fromSeq, tail)` in seq
   * order, where `tail` is the slot the next create targets. Throw to
   * refuse the commit. The verdict of the last call before the winning
   * create decides what commits; `undefined` keeps the input as given.
   */
  readonly check: (
    window: readonly LogEntry[],
    tail: number,
  ) => CommitVerdict | undefined | Promise<CommitVerdict | undefined>;
}

/**
 * What a {@link CommitAdmission.check} call decided.
 *
 * @internal
 */
export interface CommitVerdict {
  /**
   * Force the post-commit maintenance tick, as
   * {@link CommitInput.forceMaintenance} does.
   */
  readonly forceMaintenance?: boolean;
  /**
   * The post-image to commit instead of {@link CommitInput.body}; valid
   * only on a `U`, and identity-checked like the input body.
   */
  readonly body?: DocumentData;
}

/**
 * Backward validation for an `I` commit. The caller has already checked
 * that the doc has no live row in the collection state folded through
 * log tail `absentBelowSeq`. The writer then reads every log entry in
 * `[absentBelowSeq, seq)` — the window that check could not see — and
 * refuses the commit with `AlreadyExists` when the last entry for this
 * `(collection, doc_id)` in it is an `I` or `U`. So the first `I` for a
 * `doc_id` wins, and a concurrent later insert commits nothing.
 *
 * With `replayIdentical`, a live last entry whose `after` equals the
 * insert's body is not a collision but this insert's own earlier success
 * (an SDK resending an auto-ID insert): the commit returns that entry and
 * writes nothing.
 *
 * Precondition: `absentBelowSeq` is a tail observed on this
 * collection's log by a read-path probe (the first empty slot it found).
 * A value above the true tail would make the writer create past a hole.
 *
 * @internal
 */
export interface InsertGuard {
  /** The log tail the caller's absence check folded through. */
  readonly absentBelowSeq: number;
  /**
   * Treat a live `I` / `U` for the doc whose `after` equals the body
   * (`insertReplaysRow`) as this insert's original success: return it
   * as the commit result, with no create and no maintenance tick. Set only for an
   * SDK-minted `_id` (`runInsert`'s `mintedId`); a caller-chosen `_id`
   * keeps strict `AlreadyExists`. Default `false`.
   */
  readonly replayIdentical?: boolean;
}

/** Return shape of {@link Writer.commit}. */
export interface CommitResult {
  /**
   * The committed `LogEntry`. Caller can ack on `entry.lsn`. For a
   * guarded insert that replayed ({@link InsertGuard.replayIdentical}),
   * it is instead the stored live `I` / `U` in the guarded window whose
   * `after` the body matched, written by an earlier commit, and this call
   * wrote nothing.
   */
  readonly entry: LogEntry;

  /**
   * ETag of `current.json` as read at the start of the commit (Step 1),
   * on a replay as on a commit. The commit path never writes
   * `current.json` (the `log/<seq>` create IS the commit), so this is the
   * manifest's pre-commit ETag, not a post-write one.
   */
  readonly currentEtag: string;
}

const APPLICATION_JSON = "application/json";

/**
 * Successful outcome of one full {@link Writer.#singleAttemptCommit}
 * attempt: either it committed (`replayed: false`, with the commit's
 * Class A op count), or a guarded insert replayed a stored identical row
 * (`replayed: true`) and committed nothing, so it is not a logical write.
 * Rejected creates resolve by readback or throw non-retriable
 * `AmbiguousCommit`; exceeding the foreign-occupant forward-probe budget
 * throws `Internal`. Failures before dispatching the create, and a
 * definitive rejection of the slot's only send, propagate.
 */
type SingleAttemptSuccess =
  | {
      readonly replayed: false;
      readonly entries: readonly LogEntry[];
      readonly currentEtag: string;
      readonly classAOps: number;
    }
  | {
      readonly replayed: true;
      readonly entries: readonly LogEntry[];
      readonly currentEtag: string;
    };

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
 * console.log(result.entry.seq);
 * ```
 */
export class Writer {
  readonly #storage: Storage;
  readonly #currentJsonKey: string;
  readonly #verifyLogIntegrityOnCommit: boolean;

  constructor(opts: {
    storage: Storage;
    /**
     * Full bucket-relative key of the CAS pointer, e.g.
     * `app/tickets/tenant/acme/manifests/tickets/current.json`. The
     * collection-prefix half lives at
     * `currentJsonKey.slice(0, currentJsonKey.lastIndexOf("/"))` — the
     * log keys are derived from it.
     */
    currentJsonKey: string;
    options?: WriterOptions;
  }) {
    this.#storage = opts.storage;
    this.#currentJsonKey = opts.currentJsonKey;
    this.#verifyLogIntegrityOnCommit = opts.options?.verifyLogIntegrityOnCommit ?? false;
  }

  /**
   * Atomically commit one mutation. Reads `current.json` fresh (as a
   * probe FLOOR, not a CAS precondition), then creates `log/<seq>` via
   * `If-None-Match: "*"` — that create IS the commit (single-write
   * commit; no `current.json` CAS follows it).
   *
   * The hot-path cost under no contention is 3 GETs + 1 PUT, whatever
   * indexes the collection declares: the Step 1 `current.json` read,
   * `findLogTail`'s forward probe (one 404 GET when `tail_hint` is
   * accurate, `O(log gap)` GETs when it lags a fold interval), the
   * committing `log/<seq>` create, and the post-create `current.json`
   * re-read that rejects a create landing below the certified delete
   * floor (`#assertCommitAboveDeleteFloor`). A peer that won the slot
   * costs one occupant readback GET, the forward probe's GETs, and one
   * more create at the next slot.
   *
   * Idempotency: `LogEntry.after` carries the full post-image, and the
   * `log/<seq>` create uses `If-None-Match: "*"`, so two writers racing
   * the same tail cause
   * exactly one create to win; the loser reads back the occupant,
   * adopts its own lost-ack write or re-probes forward to the next
   * empty slot.
   *
   * **Uncertain commit fate.** If the committing create wins at a
   * `seq` the collection has already certified deleted — reachable when a
   * create PUT or a lost-ack retry straddles a fold plus a retirement pass —
   * the object it wrote is beneath every reader's floor. The commit then fails
   * with `AmbiguousCommit` rather than acknowledging a mutation no fresh
   * reader can see. The writer cannot tell whether an earlier attempt of its
   * own landed and was folded before retirement removed the slot, so the
   * mutation may or may not have been applied. The same uncertainty exists
   * when a rejected create cannot be resolved by reading its slot, including
   * rejections that follow a send of unknown outcome. The Writer never
   * resends a create at the same slot (the adapter already retried it); it
   * reads the slot back once instead. A missing readback does not prove that
   * an earlier send will not land. Exact own-entry readback is adopted; an
   * unresolved fate throws `AmbiguousCommit` with `err.retriable === false`.
   * Reconcile state before deliberately retrying: a new logical call can
   * duplicate work, including minting a second auto-ID document.
   *
   * @throws BaerlyError code="AmbiguousCommit" when the committing create
   *   landed below `min(log_delete_floor, log_seq_start)`, or a possibly
   *   durable create could not be resolved. The mutation's fate is unknown;
   *   `err._id` is `input.docId`.
   * @throws BaerlyError code="Internal" when a log entry expected in
   *   `[0, tail_hint)` is missing — a protocol-invariant violation
   *   (compactor bug or stale `current.json`).
   * @throws BaerlyError code="InvalidResponse" when a log-entry body
   *   isn't valid JSON.
   * @throws BaerlyError code="InvalidConfig" when `docId` breaks the
   *   key-segment rule, when an `I` / `U` `docId` is not NFC, when an
   *   `I` / `U` body is not a plain object whose own `_id` is the string
   *   `docId`, when an `I` / `U` post-image encodes to more than
   *   `MAX_DOCUMENT_BYTES`, or when `insertGuard` is set on a non-`I` op.
   *   Checked before any I/O (an admission verdict's replacement
   *   post-image is size-checked when it is returned).
   * @throws BaerlyError code="AlreadyExists" when `insertGuard` is set and
   *   the log window `[absentBelowSeq, seq)` holds a live `I` / `U` for
   *   this doc (unless `replayIdentical` is set and its `after` equals the
   *   body, which returns that entry instead). Nothing was committed;
   *   `err._id` is `input.docId`.
   * @throws BaerlyError code="WriteConflict" when `insertGuard` or
   *   `admission` is set and part of its window was folded and retired (or
   *   is longer than `LOG_FORWARD_PROBE_CAP`) before the writer could read
   *   it. Nothing was committed; re-read and retry.
   * @throws BaerlyError code="CapacityExceeded" when the request ledger
   *   cannot afford this commit's create and `COMMIT_RESOLUTION_RESERVE`,
   *   checked before each create; or when the ledger refused the create
   *   itself before any attempt was sent (`cause.notApplied`), or any
   *   storage call before it. Nothing was committed.
   * @throws whatever `admission.check` throws (the write verbs throw
   *   `CapacityExceeded` or `MaintenancePending`). Nothing was committed.
   *
   * **Window cost.** A commit with `insertGuard` or `admission` probes the
   * tail linearly from `max(windowFrom, log_seq_start)` with
   * `probeTailFrom` instead of galloping from
   * `max(log_seq_start, tail_hint)`. Uncontended, `windowFrom` is the
   * tail, so that is one 404 GET. Each entry a peer committed after the
   * caller's read costs one more GET, and if a fold moved `log_seq_start`
   * past `windowFrom`, each folded slot in between costs one GET too.
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
    // An `I` / `U` mints a row identity, so it must also be NFC: one id
    // has one byte form, whatever key canonicalization a backend applies
    // to a future id-keyed object. A `D` only names an existing row, which
    // an earlier release may have stored under a non-NFC id.
    if (input.op === "D") {
      assertStoredDocId(input.docId);
    } else {
      assertDocId(input.docId);
    }
    // An `I` / `U` post-image must name the document it is stored under:
    // a plain object whose own `_id` is the string `docId`. Without this,
    // `log/<seq>` would record a row whose `after._id` disagrees with its
    // `doc_id`, and later reads key that row by the wrong id.
    if (input.op !== "D") {
      assertPostImageIdentity(input.docId, input.body, "InvalidConfig");
      // The committed post-image is bounded, whatever the write path: an
      // in-process call has no body cap, and a merge-patch within one can
      // still grow the row. A `D` is never checked, so a row stored larger
      // by an earlier release stays deletable.
      assertDocumentSize(input.body, "Writer");
    }
    if (input.insertGuard !== undefined) {
      assertInsertGuardShape(input);
    }
    if (input.admission !== undefined) {
      assertAdmissionShape(input);
    }
    const session = uuid().slice(0, SESSION_ID_LENGTH);
    const logPrefix = this.#currentJsonKey.slice(0, this.#currentJsonKey.lastIndexOf("/"));

    // One attempt: a log-create 412 is resolved inside it (own-session
    // adoption or a bounded forward-probe), and nothing after the create
    // may re-run it — a durable create re-run at a fresh tail would
    // duplicate the logical write.
    const success = await this.#singleAttemptCommit(input, session, logPrefix, "Writer");
    // A replay committed nothing, so it is not a logical write and records
    // no write-amplification sample; it is counted as a replay instead.
    if (success.replayed) {
      recordInsertReplay(input.collection);
    } else {
      this.#emitWriteMetrics(input.collection, success.classAOps);
    }
    return {
      entry: success.entries[0]!,
      currentEtag: success.currentEtag,
    };
  }

  /**
   * One full commit attempt — the body of {@link commit}. Reads
   * `current.json`, then forward-probes the tail and creates `log/<seq>`
   * once via `If-None-Match: "*"` — the numbered log create IS the commit
   * (single-write commit; no `current.json` CAS follows it). Returns the
   * success payload.
   *
   * Commits exactly one {@link CommitInput} — the numbered log create is
   * the single linearization point per call.
   *
   * A log-create 412 is disambiguated by session read-back: own session
   * / own seq ⇒ our crashed-or-lost-ack commit is already durable ⇒
   * adopt; foreign session ⇒ re-probe forward and create at the next
   * empty slot. Each slot gets one `Storage.put` and never a same-slot
   * resend, because the adapter already retried it. A definitive
   * `AccessDenied` / `InvalidConfig` propagates as-is. A 412 or an uncertain
   * failure resolves by one occupant readback, because adapters can hide
   * earlier sends. When the call reports every attempt refused unapplied
   * (`cause.notApplied`), the same readback runs because a throttle can hide
   * a lost race: a foreign occupant forward-probes, a slot read back as
   * empty or unreadable propagates the retriable `NetworkError`: the
   * adapter already guarantees no attempt applied or can still apply.
   * Unresolved creates throw non-retriable `AmbiguousCommit`; failures
   * before the create propagate.
   *
   * Crash safety: the create is the attempt's only write. A crash before
   * it leaves nothing; a crash after it is a durable, committed write at
   * `seq`, carrying its full post-image in `LogEntry.after`.
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
    //
    // A guarded insert (`input.insertGuard`) or an admission re-check
    // (`input.admission`) instead reads every entry in its unseen window
    // `[windowFrom, tail)`: Step 3a GETs the part a fold already moved
    // below `log_seq_start`, and Step 3b probes the rest with
    // `probeTailFrom`, which returns the entries it passes.
    const guard = input.insertGuard;
    const admission = input.admission;
    const windowFrom = guard?.absentBelowSeq ?? admission?.fromSeq;
    const logSeqStart = logSeqStartOf(current);
    let commitWindow: LogEntry[] | undefined;
    // Whether the latest `admission.check` asked to force the write tick.
    let admissionForces = false;
    // The post-image this attempt commits: the input's, or the latest
    // `admission.check` verdict's.
    let body = input.body;
    const decide = async (window: readonly LogEntry[], tail: number): Promise<void> => {
      if (admission === undefined) {
        return;
      }
      const verdict = await admission.check(window, tail);
      admissionForces = verdict?.forceMaintenance === true;
      if (verdict?.body !== undefined) {
        if (input.op !== "U") {
          throw new BaerlyError(
            "InvalidConfig",
            `${errorPrefix}: an admission verdict may replace only a U post-image; got op ${JSON.stringify(input.op)}`,
          );
        }
        assertPostImageIdentity(input.docId, verdict.body, "InvalidConfig");
        assertDocumentSize(verdict.body, errorPrefix);
        body = verdict.body;
      }
    };
    let preCommitTail: number;
    if (windowFrom === undefined) {
      const probeFloor = Math.max(logSeqStart, current.tail_hint);
      // `findLogTail`'s density precondition holds: the floor sits in the
      // dense prefix because tail_hint advancers probe or derive known tails
      // from committed entries, while ordinary writer commits never stamp
      // `tail_hint`, so nothing advances the floor past a hole.
      preCommitTail = await findLogTail(this.#storage, logPrefix, probeFloor);
    } else {
      // ── Step 3a. Folded part of the window, `[windowFrom, floor)`.
      const folded = await this.#readFoldedWindow(logPrefix, windowFrom, logSeqStart, errorPrefix);
      // ── Step 3b. Live part, probed from `max(windowFrom, floor)`.
      // That start meets `probeTailFrom`'s retention precondition (it is
      // at or above this manifest read's `log_seq_start`) and sits in the
      // dense prefix: `windowFrom` was the first empty slot a read probe
      // found with every slot from its floor up occupied (or one past a
      // slot the caller's own create won), creates only ever land at a
      // first-empty slot, and retirement stays below `log_seq_start`.
      // Starting below `tail_hint` re-reads the slots in
      // `[windowFrom, tail_hint)`; those are exactly the window entries the
      // caller's decision could not see, so none of the GETs is wasted.
      // Uncontended, `windowFrom` is the tail: one 404 GET, never more
      // than the gallop above.
      const probe = await probeTailFrom(
        this.#storage,
        logPrefix,
        Math.max(windowFrom, logSeqStart),
      );
      commitWindow = [...folded, ...probe.entries];
      // ── Step 3c. Window decisions, BEFORE the first create, so a loser
      // caught here writes nothing at all, and a replay of an identical
      // live row returns it having written nothing.
      // The insert decision runs first: a peer's live row is
      // `AlreadyExists` whatever the capacity re-check would say.
      if (guard !== undefined) {
        const replayed = decideInsertTarget(commitWindow, input);
        if (replayed !== undefined) {
          return { replayed: true, entries: [replayed], currentEtag: baseEtag };
        }
      }
      await decide(commitWindow, probe.tail);
      preCommitTail = probe.tail;
    }
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
      ...(input.op !== "D" && body !== undefined ? { after: body } : {}),
      ...(input.origin !== undefined ? { origin: input.origin } : {}),
    });
    let entry = mintEntry(seq);

    // ── Step 4. Create the commit: PUT log/<seq> via If-None-Match. ─
    // The numbered log create IS the commit (single-write commit). No
    // `current.json` CAS follows it — the create is the linearization
    // point (exactly-one-winner, CI-gated across all backends).
    //
    // The commit-resolution reserve (`COMMIT_RESOLUTION_RESERVE`): each
    // slot's attempt (the create, the readback, and on a resolved commit
    // the Step 4a floor check) runs under a request ledger hold of
    // everything it may spend, taken only if it fits; otherwise
    // `CapacityExceeded`, with nothing of the attempt sent.
    //
    // Each slot gets exactly ONE `storage.put`: the adapter already retried
    // it under the storage retry policy, so a Writer-level resend would
    // multiply that policy's attempts (retry at one layer). The outcome of
    // that one call decides the next step:
    //   - success ⇒ committed at `seq`;
    //   - `cause.notApplied` (every attempt provably unapplied) ⇒ one
    //     occupant readback, because a throttle may hide a lost race: own
    //     entry ⇒ adopt; foreign ⇒ forward-probe; an observed empty slot
    //     or unreadable ⇒ the retriable `NetworkError` propagates;
    //   - `AccessDenied` / `InvalidConfig` ⇒ definitive under the
    //     `Storage.put` contract; propagates as-is;
    //   - a 412, or any other failure (an uncertain send — e.g. a dropped
    //     ack on a create that may already have landed) ⇒ one occupant
    //     readback. Own entry ⇒ adopt; foreign ⇒ forward-probe (a new
    //     slot, not a resend); absent or unreadable ⇒ `AmbiguousCommit`,
    //     because an absent slot cannot prove an in-flight send won't land.
    // A lost ack resolves without a resend: the adapter's own next attempt
    // sees the landed object as a 412, or the readback finds it.
    let committedEntry: LogEntry;
    let probes = 0;
    const ambiguous = (cause: unknown): BaerlyError => {
      ctxMetrics().counter("db.write.unresolved_create_total", 1, {
        collection: entry.collection,
      });
      return new BaerlyError(
        "AmbiguousCommit",
        `${errorPrefix}: the committing create at seq ${seq} on ${this.#currentJsonKey} was rejected and its fate could not be resolved; an earlier send may already have landed or may still land, so retrying may duplicate logical work`,
        { cause, resolution: CODE_RESOLUTIONS.AmbiguousCommit, _id: entry.doc_id },
      );
    };
    for (;;) {
      const outcome = await this.#withCommitHold(
        errorPrefix,
        async (): Promise<{ committed: LogEntry } | { foreign: LogEntry }> => {
          const logEntryKey = logObjectKey(logPrefix, seq);
          assertKeyWithinLimit(logEntryKey);
          // Encoded outside the try: an unencodable entry is the caller's
          // error, and no send was made that a readback would need to resolve.
          const entryBody = encodeJsonBytes(entry);
          let resolved: LogEntry | undefined;
          let createFailure: unknown;
          let notApplied = false;
          try {
            await this.#storage.put(logEntryKey, entryBody, {
              ifNoneMatch: "*",
              contentType: APPLICATION_JSON,
            });
            resolved = entry;
          } catch (error) {
            createFailure = error;
            this.#observe429(error, entry.collection);
            if (isWriteConflict(error)) {
              ctxMetrics().counter("db.r2.put.412_total", 1, {
                collection: entry.collection,
                step: "log-put",
              });
              // Even a visible 412 can be our entry: the adapter may have
              // retried a landed send internally.
            } else if (isDefinitiveCreateRejection(error)) {
              // `Storage.put` contract: no attempt of this call was applied,
              // and this is the slot's only send, so nothing of ours is at
              // `seq`.
              throw error;
            } else if (isCreateNotApplied(error)) {
              // A throttle can hide a lost race (R2 can answer a same-key
              // create race with a 429, not a 412), so the readback still
              // tells a peer's slot from an empty one.
              notApplied = true;
            }
          }
          if (resolved === undefined) {
            let occupant: LogEntry;
            let decision: ReturnType<typeof tryAdoptOwnSessionLogEntry>;
            try {
              occupant = await this.#readLogOccupant(logEntryKey);
              decision = tryAdoptOwnSessionLogEntry({ self: entry, existing: occupant });
            } catch (error) {
              if (notApplied) {
                // The adapter guarantees no attempt applied or can still
                // apply. An empty, unreadable, or malformed slot cannot make
                // retry unsafe.
                throw createFailure;
              }
              throw ambiguous(
                new AggregateError(
                  [createFailure, error],
                  "The create and its readback could not be resolved",
                ),
              );
            }
            if (!decision.adopt) {
              return { foreign: occupant };
            }
            // Own crashed/lost-ack commit already durable at `seq`. Adopt it
            // (byte-identical to the attempted `entry`, INCLUDING
            // `commit_ts` — adoption compares the full entry) — the logical
            // write lands at EXACTLY `seq`, never duplicated.
            resolved = decision.entry;
          }
          // ── Step 4a. Refuse a create that re-filled a retired hole. ─────
          // Both resolved paths above land here with the resolved committing
          // `seq`: the fresh win and the own-session adoption.
          await this.#assertCommitAboveDeleteFloor(
            logPrefix,
            seq,
            input.collection,
            input.docId,
            errorPrefix,
          );
          return { committed: resolved };
        },
      );
      if ("committed" in outcome) {
        committedEntry = outcome.committed;
        break;
      }
      const occupant = outcome.foreign;
      // Foreign session (or wrong seq) — re-probe forward from seq+1 and
      // create at the new first-empty slot, re-minting seq + LSN. The hold
      // is released: the occupant proves nothing of this commit landed, so
      // a refusal from here to the next hold is clean.
      if (++probes > LOG_FORWARD_PROBE_CAP) {
        throw new BaerlyError(
          "Internal",
          `${errorPrefix}: log-tail forward-probe exceeded ${LOG_FORWARD_PROBE_CAP} on ${this.#currentJsonKey}`,
        );
      }
      if (commitWindow === undefined) {
        seq = await findLogTail(this.#storage, logPrefix, seq + 1);
      } else {
        // Windowed commit: the occupant and every entry the forward probe
        // passes join the window, and the window decisions re-run before
        // the next create. A refusal here (`AlreadyExists`, or the
        // admission's own error) is sound because a foreign occupant at
        // `seq` proves this commit's send did not land there. A replay of
        // an identical live row returns here for the same reason: nothing
        // of this commit landed.
        commitWindow.push(occupant);
        const probe = await probeTailFrom(this.#storage, logPrefix, seq + 1);
        commitWindow.push(...probe.entries);
        if (guard !== undefined) {
          const replayed = decideInsertTarget(commitWindow, input);
          if (replayed !== undefined) {
            return { replayed: true, entries: [replayed], currentEtag: baseEtag };
          }
        }
        await decide(commitWindow, probe.tail);
        seq = probe.tail;
      }
      entry = mintEntry(seq);
    }
    const committedEntries: readonly LogEntry[] = [committedEntry];

    // ── Step 5. Write-tick maintenance dispatch. ────────────────────
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
    // A forced tick (main-10 G6) skips the ratio-OR-boundary gate: the
    // verb found the collection at its growth-refusal point.
    const forceFold =
      (input.forceMaintenance === true || admissionForces) && maint?.disabled !== true;
    // The adapter's host trigger (`InternalBoundedMaintenanceOptions`): a
    // live tail this long fires too, so the runner's Gate 1 sees it.
    const foldAtTailEntries = (maint?.options as InternalBoundedMaintenanceOptions | undefined)
      ?.foldAtTailEntries;
    const maintenanceDue =
      maint?.disabled === true
        ? observedTail - current.tail_hint >= MAINTENANCE_TAIL_HINT_REFRESH_WRITES
        : forceFold ||
          (foldAtTailEntries !== undefined &&
            observedTail - current.log_seq_start >= foldAtTailEntries) ||
          shouldFireMaintenance(current, prevSeq, gcInterval, observedTail);
    if (maintenanceDue) {
      await dispatchWriteTick({
        storage: this.#storage,
        currentJsonKey: this.#currentJsonKey,
        collection: input.collection,
        prevSeq,
        observedTail,
        ...(forceFold && { forceFold: true }),
      });
    }

    // Class-A op count for this commit: the committing log create alone.
    // No current.json CAS. Forward-probe and readback GETs are Class B and
    // excluded, as are creates refused at slots a foreign writer won.
    const classAOps = 1;
    return {
      replayed: false,
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
   * peer raced us and won, the storage layer surfaces `WriteConflict`; we
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
   *   unreachable because the WriteConflict implies the key now exists.
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
    let createFailure: unknown;
    try {
      return await createCurrentJson(this.#storage, this.#currentJsonKey, initial);
    } catch (error) {
      // A provably unapplied create may hide a peer provisioning the same
      // key, so it recovers by re-read like a 412.
      if (!isWriteConflict(error) && !isCreateNotApplied(error)) {
        throw error;
      }
      createFailure = error;
    }
    const recovered = await readCurrentJson(this.#storage, this.#currentJsonKey);
    if (recovered === null && isCreateNotApplied(createFailure)) {
      throw createFailure;
    }
    if (recovered === null) {
      throw new BaerlyError(
        "InvalidResponse",
        `Writer: current.json missing at ${this.#currentJsonKey} after auto-create raced and recover read returned null`,
      );
    }
    return recovered;
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
   * floor (invariant 5). A failed cleanup is recorded on the counter and never masks the
   * throw.
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
   * it is one of the calls `COMMIT_RESOLUTION_RESERVE` keeps on the request
   * ledger.
   *
   * @throws BaerlyError code="AmbiguousCommit"
   */
  async #assertCommitAboveDeleteFloor(
    logPrefix: string,
    seq: number,
    collection: string,
    docId: string,
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
      // `lsn`. The maintenance dispatch after it swallows its non-abort
      // failures for the same reason. Failing closed is not the answer either
      // — throwing `AmbiguousCommit` on an unreadable manifest would reject
      // durable commits far more often than the fault this check catches.
      ctxMetrics().counter("db.write.delete_floor_check_skipped_total", 1, { collection });
      countPostCommitRefusal(error, collection, "delete-floor-check");
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
      { resolution: CODE_RESOLUTIONS.AmbiguousCommit, _id: docId },
    );
  }

  /**
   * Run one commit slot's attempt, `fn` (the committing create and the
   * calls that resolve it), under a hold on the active request ledger of
   * everything it may spend: the create at full retries, plus
   * {@link COMMIT_RESOLUTION_RESERVE} for the readback and the delete-floor
   * check. `fn` runs in a child observability context carrying the hold, so
   * only its own storage calls draw on it; work outside that context (a
   * `ctx.waitUntil` write tick of an earlier row, the read cache) sees the
   * ledger net of it and cannot spend it. The hold is released when `fn`
   * settles.
   *
   * Refuses, before `fn` sends anything, when the ledger's room is short
   * of the hold. No create of this commit has landed or can land then:
   * before the first slot nothing was sent, and before a later one a
   * foreign occupant holds the slot this commit's only send targeted. A host without request
   * limits (Node, or no ledger) never refuses and takes no hold.
   *
   * @throws BaerlyError code="CapacityExceeded", cause `{ refused: true }`.
   */
  async #withCommitHold<T>(errorPrefix: string, fn: () => Promise<T>): Promise<T> {
    const ctx = getCurrentContext();
    const ledger = ctx?.ledger;
    const remaining = ledger?.storageRemaining() ?? Infinity;
    if (ctx === undefined || ledger === undefined || remaining === Infinity) {
      return await fn();
    }
    const needed = STORAGE_RETRY_MAX_ATTEMPTS + COMMIT_RESOLUTION_RESERVE;
    if (remaining < needed) {
      throw new BaerlyError(
        "CapacityExceeded",
        `${errorPrefix}: this request has ${String(remaining)} storage calls left, fewer than the ${String(needed)} a commit on ${this.#currentJsonKey} may need (the committing create, with retries, plus resolving it), so nothing was committed; the work this request needs does not fit in one request on this host`,
        // The HTTP envelope fills in the code's canonical resolution.
        { cause: { refused: true, needed, remaining } },
      );
    }
    const hold = ledger.hold(needed);
    try {
      return await runWithContext({ ...ctx, hold }, fn);
    } finally {
      hold.release();
    }
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
   * Read `[fromSeq, logSeqStart)` for a windowed commit (insert guard or
   * admission) whose window starts below the floor of this commit's
   * manifest read: a fold absorbed those entries after the caller's read. Slots below the floor stay
   * readable until log retirement deletes them, so a missing slot means
   * this commit can no longer check its window: `WriteConflict`, nothing
   * committed, and the caller's next read sees the folded state. A window
   * longer than {@link LOG_FORWARD_PROBE_CAP} is refused the same way
   * rather than spending an unbounded run of GETs on the write path.
   *
   * @throws BaerlyError code="WriteConflict" — a slot is missing, or the
   *   range exceeds the cap.
   * @throws BaerlyError code="InvalidResponse" — a slot's body is not JSON.
   */
  async #readFoldedWindow(
    logPrefix: string,
    fromSeq: number,
    logSeqStart: number,
    errorPrefix: string,
  ): Promise<LogEntry[]> {
    if (fromSeq >= logSeqStart) {
      return [];
    }
    const refuse = (detail: string): BaerlyError =>
      new BaerlyError(
        "WriteConflict",
        `${errorPrefix}: commit window [${fromSeq}, ${logSeqStart}) on ${this.#currentJsonKey} ${detail}; nothing was committed`,
      );
    // Backstop only. In practice the window holds just the entries a fold
    // absorbed between two reads in one request, and the host's
    // subrequest budget ends that request long before 100k GETs.
    if (logSeqStart - fromSeq > LOG_FORWARD_PROBE_CAP) {
      throw refuse(`exceeds ${LOG_FORWARD_PROBE_CAP} folded entries`);
    }
    const entries: LogEntry[] = [];
    for (let chunk = fromSeq; chunk < logSeqStart; chunk += MAX_PARALLEL_LOG_READS) {
      const end = Math.min(chunk + MAX_PARALLEL_LOG_READS, logSeqStart);
      const keys = Array.from({ length: end - chunk }, (_, i) =>
        logObjectKey(logPrefix, chunk + i),
      );
      const bodies = await Promise.all(keys.map((key) => this.#storage.get(key)));
      for (let i = 0; i < bodies.length; i++) {
        const got = bodies[i];
        if (got === null || got === undefined) {
          throw refuse(`was retired at seq ${chunk + i} before it could be checked`);
        }
        try {
          entries.push(decodeJsonBytes<LogEntry>(got.body));
        } catch (error) {
          throw new BaerlyError(
            "InvalidResponse",
            `${errorPrefix}: malformed log entry at ${keys[i]!}`,
            { cause: error },
          );
        }
      }
    }
    return entries;
  }

  /**
   * Read the occupant of a slot whose committing create was rejected, with
   * one `Storage.get` (the adapter retries it; the Writer does not). A failed
   * read, an empty slot, or an occupant without a writer identity throws:
   * none of them proves the slot holds a foreign entry rather than a pending
   * send of our own.
   */
  async #readLogOccupant(key: string): Promise<LogEntry> {
    const got = await this.#storage.get(key);
    if (got === null) {
      throw new BaerlyError("NotFound", `Writer: ${key} is empty after its create was rejected`);
    }
    let existing: unknown;
    try {
      existing = decodeJsonBytes(got.body);
    } catch (error) {
      throw new BaerlyError("InvalidResponse", `Writer: malformed log occupant at ${key}`, {
        cause: error,
      });
    }
    if (!hasWriterIdentity(existing)) {
      // Parsed JSON alone cannot establish a conflicting writer's identity.
      throw new BaerlyError("InvalidResponse", `Writer: malformed log occupant at ${key}`);
    }
    return existing;
  }

  /**
   * Bump the `db.r2.put.429_total` counter when `err` looks like an
   * R2 prefix-partition rate-limit. Best-effort: detected via
   * `BaerlyError{code:"NetworkError"}` with a `429` token in the
   * message. Called from every PUT call site's catch arm; mutually
   * exclusive in practice with `isWriteConflict` (412 ≠ 429).
   */
  #observe429(err: unknown, collection: string): void {
    if (is429(err)) {
      ctxMetrics().counter("db.r2.put.429_total", 1, { collection });
    }
  }

  /**
   * Emit the per-logical-write `class_a_ops_per_logical_write`
   * histogram for `commit`. `classAOps` is the committing create, computed
   * by `#singleAttemptCommit`.
   */
  #emitWriteMetrics(collection: string, classAOps: number): void {
    ctxMetrics().histogram("db.write.class_a_ops_per_logical_write", classAOps, { collection });
  }
}

// ---------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------

/**
 * `true` when a create rejection proves the create did not land. Under the
 * `Storage.put` contract an adapter that retried internally reports such a
 * rejection as `NetworkError`, so these codes describe the only attempt.
 */
const isDefinitiveCreateRejection = (err: unknown): boolean =>
  err instanceof BaerlyError && (err.code === "AccessDenied" || err.code === "InvalidConfig");

/**
 * `true` when a create-only put reports, per the `Storage.put` contract,
 * that no attempt of the call was applied: a `NetworkError` after every
 * attempt was throttled or refused before issue, or the request ledger's
 * `CapacityExceeded` when it refused the call before any attempt of
 * unknown outcome. `cause.notApplied` is the proof either way.
 */
const isCreateNotApplied = (err: unknown): boolean =>
  err instanceof BaerlyError &&
  (err.code === "NetworkError" || err.code === "CapacityExceeded") &&
  ((err as BaerlyError).cause as { notApplied?: boolean } | undefined)?.notApplied === true;

/**
 * Count a post-commit step the request ledger refused on
 * `db.write.post_commit_refused_total`. The step runs after a known
 * commit and swallows its failure, so the refusal leaves the commit
 * acknowledged; `phase` names the step that went without (the delete-floor
 * check is the only one).
 */
const countPostCommitRefusal = (
  err: unknown,
  collection: string,
  phase: "delete-floor-check",
): void => {
  if (
    err instanceof BaerlyError &&
    err.code === "CapacityExceeded" &&
    (err.cause as { refused?: boolean } | undefined)?.refused === true
  ) {
    ctxMetrics().counter("db.write.post_commit_refused_total", 1, { collection, phase });
  }
};

/**
 * Reject an `insertGuard` on anything but an `I`, or with an
 * `absentBelowSeq` that is not a log seq. Runs before any I/O.
 */
const assertInsertGuardShape = (input: CommitInput): void => {
  if (input.op !== "I") {
    throw new BaerlyError(
      "InvalidConfig",
      `Writer: insertGuard is valid only with op "I"; got op ${JSON.stringify(input.op)}`,
    );
  }
  const seq = input.insertGuard?.absentBelowSeq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    throw new BaerlyError(
      "InvalidConfig",
      `Writer: insertGuard.absentBelowSeq must be a non-negative safe integer; got ${String(seq)}`,
    );
  }
  const replay = input.insertGuard?.replayIdentical;
  if (replay !== undefined && typeof replay !== "boolean") {
    throw new BaerlyError(
      "InvalidConfig",
      `Writer: insertGuard.replayIdentical must be a boolean; got ${typeof replay}`,
    );
  }
};

/**
 * Reject an `admission` whose `fromSeq` is not a log seq, or differs from
 * the insert guard's window start. Runs before any I/O.
 */
const assertAdmissionShape = (input: CommitInput): void => {
  const seq = input.admission?.fromSeq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    throw new BaerlyError(
      "InvalidConfig",
      `Writer: admission.fromSeq must be a non-negative safe integer; got ${String(seq)}`,
    );
  }
  if (typeof input.admission?.check !== "function") {
    throw new BaerlyError("InvalidConfig", "Writer: admission.check must be a function");
  }
  const guarded = input.insertGuard?.absentBelowSeq;
  if (guarded !== undefined && guarded !== seq) {
    throw new BaerlyError(
      "InvalidConfig",
      `Writer: admission.fromSeq ${seq} must equal insertGuard.absentBelowSeq ${guarded}`,
    );
  }
};

/**
 * Window decision for a guarded insert. `window` holds the log entries
 * in `[absentBelowSeq, seq)` in seq order, unfiltered. The LAST entry for
 * this `(collection, doc_id)` decides: a `D`, or no entry, means the row
 * is absent and the insert may commit (`undefined`). An `I` or `U` means a
 * row is live: with `replayIdentical` set and that entry's `after` equal
 * to the body, the insert is a replay of its own earlier success and the
 * entry is returned; otherwise the insert throws `AlreadyExists`.
 *
 * @throws BaerlyError code="AlreadyExists"
 */
const decideInsertTarget = (
  window: readonly LogEntry[],
  input: CommitInput,
): LogEntry | undefined => {
  for (let i = window.length - 1; i >= 0; i--) {
    const e = window[i]!;
    if (!isOwnCollection(e.collection, input.collection) || e.doc_id !== input.docId) {
      continue;
    }
    if (e.op === "D") {
      return undefined;
    }
    if (
      input.insertGuard?.replayIdentical === true &&
      input.body !== undefined &&
      insertReplaysRow(input.body, e.after)
    ) {
      return e;
    }
    throw insertAlreadyExists(input.collection, input.docId);
  }
  return undefined;
};

/** `true` when a decoded log occupant carries the identity adoption compares. */
const hasWriterIdentity = (value: unknown): value is LogEntry => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const { session, seq } = value as { session?: unknown; seq?: unknown };
  return (
    typeof session === "string" &&
    session.length > 0 &&
    typeof seq === "number" &&
    Number.isSafeInteger(seq) &&
    seq >= 0
  );
};

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
