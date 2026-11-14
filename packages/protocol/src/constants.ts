/**
 * Leading and trailing path segments an `assertDocumentValues` error keeps
 * (`a.b.c.d.….w.x.y.z`). The document is caller-controlled and unbounded
 * in depth, so the message's path is capped; 4 + 4 segments name the
 * field's top-level location and its immediate container, which is what a
 * caller needs to find it.
 */
export const DOCUMENT_ERROR_PATH_EDGE_SEGMENTS = 4;

/**
 * Characters of one object key an `assertDocumentValues` error path shows
 * before eliding the rest. Keys are caller-controlled and unbounded, so
 * this keeps one long key from making the message unbounded.
 */
export const DOCUMENT_ERROR_PATH_KEY_CHARS = 64;

/**
 * Max total object-key length S3 and R2 accept (UTF-8 bytes). A key
 * over this fails the PUT with an opaque provider 400; baerly surfaces
 * it early as InvalidConfig. See docs/spec/storage-compatibility.md.
 */
export const MAX_KEY_BYTES = 1024;

/**
 * Half-window (in milliseconds) within which a `LogEntry`'s embedded
 * `commit_ts` must agree with wall-clock time for downstream consumers
 * to accept the entry as causally ordered. Bound on tolerated
 * client/server clock skew across the protocol.
 *
 * 5 s is the protocol's tolerance for client/server clock skew.
 * Tightening this can cause spurious rejections on machines that
 * haven't synced NTP; loosening it widens the window during which
 * causal ordering can be disturbed by skew.
 *
 * @see docs/spec/sync-protocol.md
 * @see packages/protocol/src/storage/types.ts (`Storage` JSDoc)
 */
export const LAG_WINDOW_MILLIS: number = 5000;

/**
 * Bit width of the descending base-32 seq segment in every LSN
 * (`<base32-time>_<session>_<seq>`, minted in `Writer.commit`).
 * The output character width is `Math.ceil(COUNT_BIT_WIDTH / 5) = 11`.
 *
 * **Domain:** 0 .. `Number.MAX_SAFE_INTEGER` (2^53 − 1). A collection
 * would need 2^53 writes before the seq counter could overflow — an
 * unreachable ceiling in practice.
 *
 * **Why 53 bits:** JavaScript numbers are IEEE-754 doubles; the safe
 * integer range is exactly [0, 2^53 − 1]. Encoding at this width keeps
 * the arithmetic in the encoder and decoder (`uint2strDesc` /
 * `str2uintDesc` in `packages/protocol/src/types.ts`) exact and
 * leaves no headroom for the negative-overflow path that manifested
 * at the old 10-bit width (domain 0..1023).
 *
 * **Ordering property:** fixed-width base-32 encoding preserves
 * descending lex order across the entire domain
 * (`countKey(a) > countKey(b)` iff `a < b`), which the reverse-walk
 * on `Storage.list` relies on.
 *
 * **Three production consumers** must all agree on this value:
 *  1. Encoder — `countKey` in `packages/protocol/src/types.ts`
 *  2. Decoder — `lsnParts` in `packages/protocol/src/log.ts`
 *  3. Validator regex — `LSN_RE` in `packages/server/src/http/since.ts`
 *     (derives its `{N}` from `Math.ceil(COUNT_BIT_WIDTH / 5)`)
 *
 * The independent shape-assertion literal in
 * `tests/fixtures/collection-api-cascade.ts` is kept hand-written and
 * is NOT a consumer of this constant (importing the production
 * validator into the test that checks it would make the assertion
 * a tautology).
 *
 * Changing this constant is a protocol-breaking change — it reshapes
 * every emitted LSN cursor.
 *
 * @see packages/protocol/src/types.ts (`countKey`, `uint2strDesc`)
 * @see packages/protocol/src/log.ts (`lsnParts`, `str2uintDesc` call)
 * @see packages/server/src/http/since.ts (`LSN_RE`)
 * @see docs/spec/log-entry-shape.md
 */
export const COUNT_BIT_WIDTH: number = 53;

/**
 * Bit width of the base-32 timestamp prefix encoded into every
 * {@link LogEntry.lsn} (`<base32-time>_<session>_<seq>`, minted in
 * `Writer.commit`). 42 bits gives ~139 years of millisecond
 * precision, which is enough for the protocol's lifetime.
 *
 * Changing this is a protocol-breaking change — it would re-shape
 * every emitted LSN.
 *
 * @see packages/protocol/src/time.ts (`timestamp`)
 * @see packages/server/src/writer.ts (`Writer.commit`)
 * @see docs/spec/sync-protocol.md
 */
export const TIMESTAMP_BIT_WIDTH: number = 42;

/**
 * Length of the random-prefix `session` segment embedded in every
 * {@link LogEntry.lsn} (`<base32-time>_<session>_<seq>`). 6 hex chars
 * from `crypto.randomUUID()` give 16⁶ ≈ 1.7 × 10⁷ distinct sessions;
 * birthday-collision rate at N=100 is ~3 × 10⁻⁴, comfortably below
 * the 1 % bound asserted in `tests/regressions.test.ts`. Collisions
 * within a single commit's writer set are also disambiguated by the
 * trailing `<seq>` counter.
 *
 * @see packages/server/src/writer.ts (`Writer.commit` —
 *      `session = uuid().slice(0, SESSION_ID_LENGTH)`)
 */
export const SESSION_ID_LENGTH: number = 6;

/**
 * Upper clamp on a server-provided `Retry-After` hint, in seconds.
 * RFC 7231 §7.1.3 allows arbitrary delta-seconds or HTTP-dates, but a
 * client that blindly honours a multi-hour hint hands a misbehaving
 * proxy a denial-of-service primitive. 60s covers any plausible S3-
 * compatible throttle while keeping the worst-case bounded.
 *
 * @see packages/adapter-node/src/http-transport.ts (`parseRetryAfter`)
 */
export const RETRY_AFTER_MAX_SECONDS: number = 60;

/**
 * Total attempts (first try included) every storage adapter makes for
 * one `Storage` call before surfacing the last failure: S3, GCS, and
 * the R2 binding, for `get` / `put` / `delete` and for each `list`
 * page. 429 and 5xx share this one counter, so a failing call costs at
 * most 3 requests on every host. Applied by `retryStorageCall`. An
 * `ifMatch` put (a compare-and-swap) is the exception: one attempt,
 * since a resend after a lost ack would meet its own write as a 412.
 *
 * 3 is the common prior-art cap: AWS SDK standard retry mode allows 3
 * attempts (https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html),
 * and the Google SRE book caps per-request retries at 3
 * (https://sre.google/sre-book/handling-overload/). Retrying happens at
 * this one layer only: stacked retry loops multiply ("3 retries at 5
 * layers = 243x", AWS Builders' Library, "Timeouts, retries and backoff
 * with jitter"). A store failing three times in a row is reported as a
 * retriable `NetworkError` rather than ridden out here.
 *
 * @see packages/protocol/src/storage/retry.ts (`retryStorageCall`)
 */
export const STORAGE_RETRY_MAX_ATTEMPTS: number = 3;

/**
 * Full-jitter backoff base, in milliseconds, after a transient failure
 * (5xx, network error): retry `n` (0-based) waits
 * `random() * min(STORAGE_RETRY_MAX_DELAY_MILLIS, base * 2^n)`.
 *
 * 50 ms is the AWS SDKs' transient base
 * (https://aws.amazon.com/blogs/developer/announcing-updated-retry-behavior-for-aws-sdks-and-tools/).
 *
 * @see packages/protocol/src/storage/retry.ts (`storageRetryDelayMillis`)
 */
export const STORAGE_RETRY_TRANSIENT_BASE_MILLIS: number = 50;

/**
 * Full-jitter backoff base, in milliseconds, after a throttle (`429`,
 * S3 `503 SlowDown`; any error whose cause carries `throttled: true`).
 * Longer than {@link STORAGE_RETRY_TRANSIENT_BASE_MILLIS} because a
 * throttle says the store is overloaded, and an early resend adds load.
 *
 * 1 s is the AWS SDKs' throttle base
 * (https://aws.amazon.com/blogs/developer/announcing-updated-retry-behavior-for-aws-sdks-and-tools/).
 *
 * @see packages/protocol/src/storage/retry.ts (`storageRetryDelayMillis`)
 */
export const STORAGE_RETRY_THROTTLE_BASE_MILLIS: number = 1000;

/**
 * Upper bound, in milliseconds, on one backoff between storage
 * attempts, jittered or server-hinted (`Retry-After` is clamped to
 * it). 20 s is the AWS SDKs' backoff cap
 * (https://aws.amazon.com/blogs/developer/announcing-updated-retry-behavior-for-aws-sdks-and-tools/).
 *
 * @see packages/protocol/src/storage/retry.ts (`storageRetryDelayMillis`)
 */
export const STORAGE_RETRY_MAX_DELAY_MILLIS: number = 20_000;

/**
 * Request-ledger limit on the `internal` pool on Workers Free (the
 * `cf-free` maintenance profile): every storage call one invocation may
 * issue, R2 binding calls and `fetch` calls alike. Cloudflare documents
 * 1,000 subrequests to internal services per Free invocation
 * (https://developers.cloudflare.com/workers/platform/limits/); 900 keeps
 * a 10% margin for calls the ledger cannot see but the platform counts:
 * app code in the same Worker, redirects, and any per-call multiplier on
 * the binding. The 1,000 is documented, not observed (a Free probe saw 60
 * binding calls succeed); the R2 adapter's "Too many subrequests" refusal
 * is the backstop if the real cap is lower.
 *
 * @see packages/protocol/src/storage/ledger.ts (`RequestLedger`)
 */
export const CF_FREE_INTERNAL_REQUEST_LIMIT: number = 900;

/**
 * Request-ledger limit on the `external` pool on Workers Free: storage
 * calls that leave through `fetch` (S3 over HTTP, GCS) plus Cache API
 * calls. Free allows 50 external subrequests per invocation, and a
 * `fetch` past the 50th throws before it is sent (observed at exactly
 * call 51). 45 keeps 5 for calls outside the ledger: the verifier's JWKS
 * fetch on a cold isolate and a write's cache invalidation.
 * `CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES` and `CF_FREE_FETCH_GC_MAX_SWEEPS`
 * are sized so a whole request fits it.
 */
export const CF_FREE_EXTERNAL_REQUEST_LIMIT: number = 45;

/**
 * Request-ledger limit on both pools on Workers Paid (the `cf-paid`
 * maintenance profile): Paid's default 10,000 subrequests per invocation
 * less a 10% margin. An operator who lowers `limits.subrequests` in the
 * Wrangler config is invisible to the Worker, so `cf-paid` assumes the
 * default.
 */
export const CF_PAID_REQUEST_LIMIT: number = 9000;

/**
 * Most Cache API calls (`match` / `put` / `delete`) the Worker's read
 * cache spends per invocation. They share the subrequest quota, so each
 * is charged to the ledger's `external` pool. The read cache issues at
 * most `match` + `put` on a cacheable GET and one `delete` after a write;
 * a `match` or `put` without room in the ledger is skipped and the
 * request is served from storage, never refused.
 */
export const CF_CACHE_API_MAX_CALLS: number = 3;

/**
 * Storage requests a commit keeps on the request ledger for resolving its
 * committing `log/<seq>` create: `2 * STORAGE_RETRY_MAX_ATTEMPTS` = 6.
 *
 * Once the create is sent, the writer may still need, each retried up to
 * `STORAGE_RETRY_MAX_ATTEMPTS` times by the adapter:
 *
 * - one occupant readback GET of the slot, when the create fails (a 412, a
 *   send of unknown outcome, or a throttle that can hide a lost race), and
 * - the `current.json` GET of the delete-floor check, after a win or an
 *   adopted lost-ack create.
 *
 * Without room for both, a create that landed but lost its reply cannot be
 * resolved and becomes `AmbiguousCommit`, and a won create skips the
 * delete-floor check. Everything else after the create (the write tick) is
 * best effort and is not reserved.
 *
 * Each slot's attempt runs under a request-ledger hold
 * (`RequestLedger.hold`) of
 * `STORAGE_RETRY_MAX_ATTEMPTS + COMMIT_RESOLUTION_RESERVE` = 9 requests: the
 * create at full retries, plus this reserve. The create is the commit's only
 * write, so the hold is the same for every collection, whatever indexes it
 * declares. Other work in the invocation (a `ctx.waitUntil` write tick)
 * cannot spend held requests. The writer refuses with `CapacityExceeded`,
 * before it writes anything, when the ledger's room cannot cover the hold.
 * After a lost create race it takes a new hold before the next create.
 *
 * The arithmetic assumes the default adapter retry policy; an adapter
 * configured with more retries can need more than it reserves.
 *
 * @see packages/server/src/writer.ts (`#withCommitHold`)
 */
export const COMMIT_RESOLUTION_RESERVE: number = 2 * STORAGE_RETRY_MAX_ATTEMPTS;

/**
 * Maximum concurrent log-entry GETs issued by a single `walkLogRange`
 * call. Bounds Class-B fan-out per read and per CAS attempt — without
 * a bound, a reader on a collection whose compactor has fallen behind
 * fans out one GET per live-tail entry (measured at 150-360 entries at
 * steady state on the free-tier profile).
 *
 * 16 bounds CONCURRENCY, not the per-request total: a walk still issues
 * one GET per live-tail entry, 16 at a time, and every GET is charged to
 * the invocation's request ledger, which refuses a read whose tail does
 * not fit the host's limit. On Workers the platform also caps an
 * invocation at 6 simultaneous outgoing connections, R2 binding calls
 * included, so the walk runs at most 6 at a time there whatever this
 * value is. A reader relies on the compactor keeping the live tail short
 * enough that the walk fits; see `docs/spec/scale-ceilings.md`
 * §Per-tier bounds.
 *
 * @see packages/server/src/log-walk.ts (`walkLogRange`)
 */
export const MAX_PARALLEL_LOG_READS: number = 16;

/**
 * Runaway guard on the tolerant forward-probe walk (`probeTailFrom`):
 * max `log/<seq>` GETs past `tail_hint` before it THROWS `Internal`
 * (rather than silently truncating reads). A runaway alarm only — the
 * maintenance tick keeps `tail_hint` near the tail, so a >cap gap means
 * maintenance is off or the collection is far past graduation.
 *
 * @see packages/server/src/log-tail.ts (`probeTailFrom`)
 */
export const LOG_FORWARD_PROBE_CAP: number = 100_000;

/**
 * Sequence distance retained below `log_seq_start` before `log/<seq>.json`
 * objects become retirable: a rate limit on how fast retirement approaches the
 * live floor.
 *
 * Folded entries stay readable below the floor for this long, which is what a
 * windowed commit (`Writer#readFoldedWindow`, for an insert guard or an
 * admission re-check whose read predates a fold) needs to finish rather than
 * refuse with `WriteConflict`; it reads at most the entries a fold absorbed
 * between two reads in one request, far fewer than 1024. The value is a
 * literal: it carries no derivation, and shrinking it is a measured change of
 * its own.
 *
 * **This window is NOT a paused-writer fence, and no safety property may be
 * derived from it.** It is a cost margin and a rate limit on how fast
 * retirement approaches the live floor — nothing more. The withdrawn argument
 * was that a certified-deleted slot needs `log_seq_start` to advance by more
 * than this window "during one in-flight commit". The arithmetic is correct and
 * the quantifier is vacuous: one in-flight commit bounds no wall-clock and no
 * commit count, so this is a rate x duration assumption expressed in sequences,
 * the same class as `GC_GRACE_PERIOD_MILLIS` in seconds. Lowering the value on
 * cost grounds costs windowed-commit headroom and retirement smoothness; it
 * does not weaken a safety proof, because there was never one here.
 *
 * Withdrawing the claim does not leave the schedule open, because the commit
 * path closes it directly. After the committing `log/<seq>` create resolves,
 * `Writer#assertCommitAboveDeleteFloor` re-reads `current.json` and fails a
 * create that won at a `seq` below `min(log_delete_floor, log_seq_start)` with
 * `BaerlyError{code:"AmbiguousCommit"}`, rather than acknowledging a mutation
 * no reader can see. That check keys on the certified delete floor, not on this
 * window, which is exactly why the window may keep being a cost margin without
 * carrying a safety obligation. Do not re-derive a fence from this value.
 *
 * @see packages/server/src/writer.ts (`Writer#assertCommitAboveDeleteFloor`)
 * @see packages/server/src/log-retention.ts
 * @see docs/spec/sync-protocol.md invariant 12
 * @see docs/adr/002-ephemeral-coordination.md § Closed paths
 */
export const LOG_RETENTION_SEQ_WINDOW: number = 1024;

/**
 * Maximum log-object DELETEs a retention pass may attempt on one write tick.
 * Twenty keeps a GC tick plus retirement at 48 calls (144 with every call
 * retried), inside Workers Free's 900-call R2 binding limit, and drains faster
 * than the fold floor advances in steady state.
 *
 * `retireLogRange` is the pass that spends this budget. Every maintenance
 * trigger runs it via the shared `retireLogs` helper in `maintenance.ts`:
 * `runScheduledMaintenance` after its GC phase, and `runBoundedMaintenance`
 * both on the hard-GC early-return path and as its final step. The combined
 * per-tick storage-call arithmetic, against the worst cases `maintenance.ts`'s
 * `CLOUDFLARE_FREE_TIER` JSDoc documents (fault-free; times
 * {@link STORAGE_RETRY_MAX_ATTEMPTS} with every call retried):
 *
 * - One retirement pass, worst case, is 23 calls: 1 advisory-gate GET
 *   + `casUpdateCurrentJson`'s own GET + 1 CAS PUT + up to 20 DELETEs.
 * - A maximally contended write-tick GC including the retirement gate read
 *   is 26 storage operations, pinned exactly by `maintenance-budget.test.ts`.
 *   When the gate finds work, the pass adds its CAS read + CAS write + up to
 *   20 DELETEs on top (48, or 144 retried).
 * - A compaction pass is ≤49, so compact + retirement would be 72. **Retirement
 *   cannot share a tick with a fold**: in `"single"` phase mode a write-tick
 *   fold returns before the runner's retirement step, and
 *   `maintenance-budget.test.ts` pins that a fold tick issues zero retirement
 *   storage ops.
 * - The write-tick host request also spends one `current.json` GET on the
 *   commit path's certified-delete-floor check, outside the tick's pinned
 *   figures above. Nothing here changes the value 20: retirement never
 *   shares a tick with a fold, so the DELETE budget only ever stacks onto a
 *   GC tick.
 *
 * A pass whose range is empty returns `{deleted: 0}` and spends 1 GET. Its
 * observability is the `db.log_retention.deleted_total` counter `retireLogs`
 * emits per pass, so a permanently-stalled retirement (a floor wedged at the
 * live floor) is visible as a counter that stays flat while the log object
 * count grows.
 *
 * @see packages/server/src/log-retention.ts
 * @see packages/server/src/maintenance.ts (`retireLogs`)
 */
export const LOG_RETENTION_MAX_DELETES_PER_TICK: number = 20;

/**
 * Current major version of the `current.json` control-object schema.
 * Readers MUST reject unknown versions with
 * `BaerlyError{code:"InvalidResponse"}` rather than try to coerce.
 *
 * Bump only on a breaking change to `CurrentJson` field semantics.
 * Adding a new optional field is NOT breaking; renaming or removing
 * a field IS breaking.
 *
 * @see packages/protocol/src/coordination/current-json.ts
 */
export const CURRENT_JSON_SCHEMA_VERSION = 3 as const;

/**
 * MIME type written for `current.json` PUTs. S3 round-trips this on
 * subsequent GETs; useful for diagnostics when staring at a bucket
 * via the AWS console.
 *
 * @see packages/protocol/src/coordination/current-json.ts
 */
export const CURRENT_JSON_CONTENT_TYPE: string = "application/json";

/**
 * Current major version of the `gc/pending.json` control-object
 * schema. Readers MUST reject unknown versions with
 * `BaerlyError{code:"InvalidResponse"}` rather than try to coerce.
 *
 * Bump only on a breaking change to `GcPending` field semantics.
 * Adding a new optional field is NOT breaking; renaming or removing
 * a field IS breaking.
 *
 * @see packages/protocol/src/coordination/gc-pending.ts
 */
export const GC_PENDING_SCHEMA_VERSION = 1 as const;

/**
 * Current major version of the snapshot control-object schema
 * ({@link SnapshotBody}). Readers MUST reject unknown versions with
 * `BaerlyError{code:"InvalidResponse"}` rather than try to coerce.
 *
 * Bump only on a breaking change to `SnapshotBody` field semantics.
 * Adding a new optional field is NOT breaking; renaming or removing
 * a field IS breaking.
 *
 * @see packages/server/src/snapshot.ts
 */
export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

/**
 * MIME type written for `gc/pending.json` PUTs.
 *
 * @see packages/protocol/src/coordination/gc-pending.ts
 */
export const GC_PENDING_CONTENT_TYPE: string = "application/json";

/**
 * Default grace period between "marking" a key for GC and "sweeping"
 * (deleting) it. 7 days, chosen to span the worst plausible writer-
 * retry window (a paused-process writer that resumes hours later
 * should still find its idempotency anchor on the bucket). The
 * `runGc()` function accepts an override for tests.
 *
 * Why 7 days specifically:
 *  - **1 day is too aggressive for batch workloads.** Worker isolate
 *    scheduling pauses, cross-region replication lag, and
 *    {@link STORAGE_RETRY_THROTTLE_BASE_MILLIS} retry cascades can plausibly
 *    exceed an hour under pathological conditions.
 *  - **30 days is conservative beyond the worst plausible pause.**
 *    Doubles `gc/pending.json` size at steady state and slows
 *    visibility into "did GC actually run?" by 4×.
 *  - **7 days spans the realistic upper bound** — long-running batch
 *    jobs, multi-region propagation delays, queue backlogs, and
 *    downstream outages the writer is retrying through. The protocol
 *    is unaffected by the choice of value within the [hours, weeks]
 *    range; this constant is the operator-tunable knob.
 *
 * Production code MUST NOT call `runGc` with `graceMillis` below the
 * default outside maintenance windows — going below the longest
 * plausible writer-retry latency risks deleting an anchor a writer
 * is about to find on retry. Test code that sets `graceMillis: 0` is
 * exercising the sweep path deliberately, not modelling production.
 *
 * @see packages/server/src/gc.ts
 */
// Stryker disable next-line ArithmeticOperator: internal tuning value, not an off-process contract — asserting the literal would be a tautological change-detector. See docs/contributing/mutation-testing.md constants policy.
export const GC_GRACE_PERIOD_MILLIS: number = 7 * 24 * 60 * 60 * 1000;

/**
 * Cap on candidates kept in `gc/pending.json` to bound the size of
 * the file. The compactor marks at most this many candidates per
 * pass; subsequent passes pick up the rest. Larger collections will
 * lag GC by one pass per `GC_MAX_PENDING_CANDIDATES` orphans, which
 * is acceptable.
 *
 * @see packages/server/src/gc.ts
 */
export const GC_MAX_PENDING_CANDIDATES: number = 1000;

/**
 * Keys per LIST response page on every in-tree object-store adapter:
 * S3 and GCS `max-keys` and R2 binding `limit` all cap at 1000. `runGc`
 * widens its orphan-snapshot mark window past already-pending keys only
 * up to this size, so the widening never adds a full LIST page (a
 * provider may still truncate a page short and cost another request).
 *
 * @see packages/server/src/gc.ts
 * @see docs/spec/storage-compatibility.md
 */
export const GC_MARK_LIST_PAGE_KEYS: number = 1000;

/**
 * Bounded retry cap for the `gc/pending.json` CAS read-modify-write
 * loop in {@link casUpdateGcPending}. On `WriteConflict` (a concurrent GC
 * pass landed between this pass's read and its write) the loop
 * re-reads `latest` and re-applies the pure merge mutator, retrying up
 * to this many total attempts before surfacing `WriteConflict`. Safe to
 * retry because the mutator is pure and the sweep DELETEs are
 * idempotent and already performed; a re-merge against fresh state
 * never loses a concurrently-marked candidate. Small fixed cap — under
 * one writer per collection at steady state, contention is rare; this
 * just bounds the worst case so a pathological storm can't spin.
 *
 * @see packages/protocol/src/coordination/gc-pending.ts
 */
export const GC_PENDING_CAS_MAX_ATTEMPTS: number = 3;

/**
 * Fold-trigger ratio: fold fires at tail ≥ R×snapshot. Pure READ-AMP / fold-frequency
 * knob — with the ceiling on the snapshot axis (Decision 3a, tail sliced) the
 * auto-maintained snapshot ceiling is S_max = C, NOT C/(1+R). R=1.0 caps steady-state
 * read-amp at ~2× and keeps compaction write-amp (≈1+1/R) moderate. See
 * docs/spec/scale-ceilings.md for the derivation.
 *
 * @see docs/spec/scale-ceilings.md
 * @see packages/server/src/maintenance.ts
 */
export const MAINTENANCE_TARGET_RATIO: number = 1;

/**
 * Floor for the ratio denominator — avoid div-by-tiny on a fresh collection. Also
 * sets the first-fold threshold: until a snapshot exists, fold fires at tail ≈ this.
 *
 * @see packages/server/src/maintenance.ts
 */
// Stryker disable next-line ArithmeticOperator: internal tuning value, not an off-process contract — asserting the literal would be a tautological change-detector. See docs/contributing/mutation-testing.md constants policy.
export const MAINTENANCE_MIN_LIVE_BYTES: number = 64 * 1024;

/**
 * Cold-start per-entry byte estimate for the ratio TRIGGER's derived live-tail
 * size (`estimateTailBytes`), used until the compactor stamps a real
 * `current.json.mean_entry_bytes` on the first fold. Folding too-few entries is
 * barred by Gate-1's entry-count floor (`minEntriesToCompact`), NOT by this
 * value — so over-estimating is equally safe; this is a first-fold-TIMING
 * choice. A small typical log-entry size keeps the first fold's cadence close
 * to a precisely measured path for typical entries; must be non-zero so a
 * bare `Db.create()` still bootstraps its first auto-fold (a 0 fallback leaves
 * the ratio dead pre-stamp). Large-body collections see a bounded first-fold
 * delay; after it stamps a real mean the estimate tracks the exact tail.
 *
 * @see packages/server/src/maintenance.ts (`estimateTailBytes`)
 */
// Stryker disable next-line ArithmeticOperator: internal cold-start tuning value, not an off-process contract — asserting the literal would be a tautological change-detector. See docs/contributing/mutation-testing.md constants policy.
export const MAINTENANCE_COLD_START_ENTRY_BYTES: number = 128;

/**
 * Per-tick GC budget — these are DEFAULTS (= the most-constrained tier, CF free, reusing
 * the TESTED `CLOUDFLARE_FREE_TIER` values in maintenance.ts / maintenance-budget.test.ts).
 * The adapter THREADS per-tier overrides into the context (§8.4); Node/CF-paid raise them.
 * NOT universal constants — a Node-sized value here would exceed the CF-free budget on every fold
 * (round-4 Tier-1). `gcMaxMarks` bounds each LIST classification window and the resulting
 * ledger growth; `gcMaxSweeps` bounds DELETEs. Cadence is BOUNDARY-CROSSING (§3.1), not
 * modulo.
 *
 * @see packages/server/src/maintenance.ts
 * @see packages/server/src/maintenance-budget.test.ts
 */
export const WRITE_TICK_GC_INTERVAL: number = 4; // tuned so maxSweeps/interval ≥ p (§7.1)

/**
 * Fold-starvation guard (critique A): on `phasesPerTick:"single"`, every Nth GC-interval is a
 * HARD GC boundary the fold may NOT preempt, so a long fold-heavy drain can't starve GC to zero.
 * Stateless (seq-derived) — no per-isolate preemption counter (CF recycles isolates). At 4 a
 * sustained drain still yields ~1 GC tick per 4 GC-intervals.
 *
 * @see packages/server/src/maintenance.ts
 */
export const GC_STARVATION_GUARD: number = 4;

/**
 * Maximum keys classified per GC category per write-tick pass. Bounds the LIST window and
 * the candidate-ledger growth it can cause.
 *
 * @see packages/server/src/maintenance.ts
 */
export const WRITE_TICK_GC_MAX_MARKS: number = 20;

/**
 * Maximum candidate DELETEs per write-tick pass.
 *
 * @see packages/server/src/maintenance.ts
 */
export const WRITE_TICK_GC_MAX_SWEEPS: number = 10;

/**
 * Per-pass tail SLICE default — compact()'s maxEntriesPerRun. Fold ≤ this+3 subrequests, so
 * a large tail drains incrementally over write-ticks (Decision 3). Adapter-overridable.
 *
 * @see packages/server/src/maintenance.ts
 */
export const WRITE_TICK_FOLD_ENTRIES_PER_PASS: number = 20;

/**
 * Cloudflare Free scheduled-compactor tail-discovery budget (`P`). A
 * prior-snapshot fold pass costs 1 GET current + P GETs tail probe +
 * 1 GET prior snapshot + N GETs log + 1 PUT snapshot + 1 PUT current
 * = 4 + N + P storage operations. With P=25 and the Free profile's
 * N=20 slice, the worst pass is 49 operations, 147 with every call
 * retried, inside the 900 a Free invocation may spend through the R2
 * binding ({@link CF_FREE_INTERNAL_REQUEST_LIMIT}). Through `fetch` (45)
 * the worst pass does not fit, and a pass about 20 or more entries behind
 * its `tail_hint` stalls there; see `CLOUDFLARE_FREE_TIER`. Kept at 25
 * because Free CPU, not the request count, binds first on the binding,
 * and the maintenance-backlog baselines were measured at it.
 *
 * @see packages/server/src/maintenance.ts
 * @see packages/server/src/maintenance-budget.test.ts
 */
export const CF_FREE_COMPACT_TAIL_PROBE_GETS: number = 25;

/**
 * Cloudflare Paid scheduled-compactor tail-discovery budget (`P`) for
 * `CLOUDFLARE_PAID_TIER`. Without one, the scheduled probe may walk up to
 * {@link LOG_FORWARD_PROBE_CAP} (100,000) GETs past a stale `tail_hint`,
 * which no Paid invocation can issue: the request ledger refuses the pass
 * at {@link CF_PAID_REQUEST_LIMIT} and nothing folds. With a budget, a
 * pass that exhausts it checkpoints the certified lower bound in
 * `current.json` and the next pass resumes there.
 *
 * With the Paid profile's per-pass slice
 * `N` = {@link NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS} (200), the worst
 * pass is `4 + N + P` = 1,204 storage calls, 3,612 with every call retried
 * {@link STORAGE_RETRY_MAX_ATTEMPTS} times, well inside 9,000. 1,000 is
 * five slices of discovery per pass: large enough that a pass behind by
 * a normal backlog still folds, small enough that a scheduled compact, GC
 * and retirement pass together stay under the limit at full retries.
 *
 * @see packages/server/src/maintenance.ts (`CLOUDFLARE_PAID_TIER`)
 * @see packages/server/src/maintenance-budget.test.ts
 */
export const CF_PAID_COMPACT_TAIL_PROBE_GETS: number = 1000;

/**
 * compact()'s minEntriesToCompact, set EXPLICITLY by the runner so it agrees with Gate 1
 * rather than inheriting compact()'s silent default 100 (which would contradict the 64 KB
 * first-fold story — round-4 Tier-3). Adapter-overridable; CF-free value.
 *
 * @see packages/server/src/maintenance.ts
 */
export const WRITE_TICK_MIN_ENTRIES_TO_COMPACT: number = 50;

/**
 * Storage requests a write-tick fold issues besides its log GETs, on its
 * common path (every call answered first time, no concurrent writer): the
 * `current.json` GET, one tail-probe GET at the writer's observed tail, the
 * prior-snapshot GET, the snapshot PUT and the `current.json` CAS PUT. A
 * fold of `e` entries costs `5 + e` after the runner's own `current.json`
 * GET (the `6 + e` in {@link CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES}'s
 * derivation counts that GET too).
 *
 * `runBoundedMaintenance` skips the fold when the invocation's request
 * ledger has less than this plus the tail it would fold left. Retries and
 * a tail a concurrent writer lengthened can still overrun; the ledger
 * refuses that call before it is sent and the next tick folds again.
 *
 * @see packages/server/src/maintenance.ts (`runBoundedMaintenance`)
 */
export const MAINTENANCE_FOLD_BASE_REQUESTS: number = 5;

/**
 * Storage requests a write-tick GC slice issues besides its sweep DELETEs,
 * on its common path: the `current.json` GET, the `gc/pending.json` GET,
 * one snapshot LIST page, the fresh `current.json` GET before a due sweep,
 * and the pending CAS (GET + PUT). A slice sweeping `S` costs `6 + S`.
 * Contention adds at most 6 (the pending-bootstrap race, two more CAS
 * attempts), the `12 + S` worst case in `CLOUDFLARE_FREE_TIER`'s JSDoc.
 *
 * `runBoundedMaintenance` lowers the slice's sweep cap to what the
 * invocation's request ledger has left after this, and skips the slice
 * when not even this is left. A deferred sweep stays pending for the next
 * slice.
 *
 * @see packages/server/src/maintenance.ts (`runBoundedMaintenance`)
 */
export const MAINTENANCE_GC_BASE_REQUESTS: number = 6;

/**
 * Most storage requests a log-retirement pass can be charged before its
 * floor CAS lands: the advisory `current.json` GET and the CAS's own GET,
 * each up to {@link STORAGE_RETRY_MAX_ATTEMPTS} attempts, plus the CAS PUT,
 * which an If-Match PUT sends once. 7 at 3 attempts.
 *
 * `retireLogRange` moves `log_delete_floor` past the range BEFORE it
 * DELETEs it, and the next pass starts at the floor, so a DELETE refused
 * after the CAS leaks that log object for good. `runBoundedMaintenance`
 * therefore caps the pass at `(remaining - this) / STORAGE_RETRY_MAX_ATTEMPTS`
 * DELETEs, so every DELETE can spend all its attempts, and skips the pass
 * when that leaves none. The range not retired stays retirable.
 *
 * @see packages/server/src/maintenance.ts (`runBoundedMaintenance`)
 * @see packages/server/src/log-retention.ts (`retireLogRange`)
 */
export const MAINTENANCE_RETIRE_PRE_FLOOR_REQUESTS: number = 2 * STORAGE_RETRY_MAX_ATTEMPTS + 1;

/**
 * Storage requests the write tick's `tail_hint` refresh issues: one
 * non-retrying `casUpdateCurrentJson` (GET + PUT). `runBoundedMaintenance`
 * skips the refresh when the invocation's request ledger has less left; a
 * later tick refreshes instead.
 *
 * @see packages/server/src/maintenance.ts (`runBoundedMaintenance`)
 */
export const MAINTENANCE_TAIL_HINT_REFRESH_REQUESTS: number = 2;

/**
 * Live-tail length at which the write tick folds on Workers Free when the
 * Worker reaches its bucket through `fetch` (S3 over HTTP) rather than the
 * R2 binding, whatever the tail-to-snapshot ratio. The Cloudflare adapter
 * detects that host from the storage it was given and threads this as
 * `foldAtTailEntries`, with {@link CF_FREE_FETCH_GC_MAX_SWEEPS}; Free with
 * the R2 binding, Paid, and Node keep the ratio trigger alone.
 *
 * **Why the ratio trigger fails there.** Every storage call on that host is
 * one of Free's 50 external subrequests per invocation; the budget is 45,
 * leaving 5 for the verifier and platform. The Cloudflare limits page counts
 * subrequests per invocation and does not exempt `ctx.waitUntil` work, so
 * the tick a write dispatches is assumed to share the write's cap. A write
 * and a read both replay the live tail, one GET per entry, so a request
 * costs at least its tail. The ratio trigger first folds near 512 entries
 * (`MAINTENANCE_MIN_LIVE_BYTES` / 128-byte entries) and no sooner than
 * {@link WRITE_TICK_MIN_ENTRIES_TO_COMPACT} (50): at that tail an insert
 * alone costs 57 calls, so the fold never fits and every read fails once
 * the tail passes ~41.
 *
 * **Derivation of 7.** From `request-counts.json` (100-doc snapshot, live
 * tail `t`): an insert, an update and a delete each cost `7 + t`, whatever
 * indexes the collection declares; the commit's only write is its log
 * create. A fold of `e` entries costs `6 + e`. A fold and GC never share a
 * tick (`phasesPerTick: "single"`), so a request costs its route plus one
 * of:
 *
 * - the fold, triggered at tail `T`, or `T + 1` when the hard-GC guard
 *   pre-empts it: at most `14 + 2T`, 28 at `T = 7`;
 * - a GC slice sweeping `D` = {@link CF_FREE_FETCH_GC_MAX_SWEEPS} due
 *   snapshots, plus log retirement, including a write whose tail reaches
 *   `T + 1` while the hard-GC guard pre-empts the fold.
 *
 * Plus one Cache API `delete` (which shares the subrequest quota) on a
 * PATCH or DELETE. The `free-fetch:*` cells measure inserts, cold updates
 * and a mixed rotation through a full cycle of fold and GC phases with
 * every GC slice sweeping its cap; the worst is 30 + 1 = 31 at `T = 7`,
 * `D = 3`, set by the GC arm. `T = 8`, `D = 2` would only match snapshot
 * creation at the guaranteed GC cadence; `T = 7`, `D = 3` leaves sweep
 * throughput headroom. The 14 calls of room left are deliberately unspent:
 * a later fold trigger moves the snapshot-creation rate, the GC throughput
 * argument on {@link CF_FREE_FETCH_GC_MAX_SWEEPS} and the documented Free +
 * S3 envelope, so raising `T` is a measured change of its own.
 * The longest live tail a read then sees is `T + 1` = 8: any read, with or
 * without declared indexes (`$in` included), costs 11, plus 2 Cache API
 * calls for a GET by id.
 * Retried calls (up to `STORAGE_RETRY_MAX_ATTEMPTS` each) are outside this
 * budget: that host is best effort.
 *
 * Changing this value, a fold or GC cost, or the GC cadence moves the
 * `free-fetch:*` cells; `tests/unit/request-counts.test.ts` asserts they
 * stay within 45.
 *
 * @see packages/adapter-cloudflare/src/worker.ts (`cfMaintenanceDispatch`)
 * @see tests/fixtures/request-count-free-fetch.ts
 * @see https://developers.cloudflare.com/workers/platform/limits/#subrequests
 */
export const CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES: number = 7;

/**
 * Most replaced snapshots one write-tick GC slice deletes on Workers Free
 * when storage is reached through `fetch`; replaces
 * {@link WRITE_TICK_GC_MAX_SWEEPS} (10) there. Each DELETE is one of the
 * request's external subrequests, and a full 10-delete slice on top of the
 * write that dispatched it exceeds the 45-call budget at the tail lengths a
 * write tick folds from. At 3 every `free-fetch:*` cell fits with room to
 * spare at {@link CF_FREE_FETCH_FOLD_AT_TAIL_ENTRIES} (derivation there);
 * the sweep stays at 3 because it is sized by the throughput argument below,
 * which a larger sweep only widens.
 *
 * **Sweep throughput must outrun the fold rate.** Every landed fold
 * replaces one snapshot, so a collection produces at most one sweep
 * candidate per `T` commits (`T` = the fold trigger). On
 * `phasesPerTick: "single"` a fold may pre-empt a cadence GC tick but never
 * the hard-GC tick, which runs once per
 * `WRITE_TICK_GC_INTERVAL * GC_STARVATION_GUARD` = 16 commits, so the
 * guaranteed sweep rate alone must cover it:
 *
 *     D / 16 > 1 / T,  i.e.  D > 16 / T = 2.3 at T = 7.
 *
 * `D = 3` clears that with about 31% margin before counting the cadence
 * GC ticks folds do not pre-empt. This sizes the sweep only; it assumes
 * marking keeps pace with the fold rate.
 *
 * @see packages/adapter-cloudflare/src/worker.ts (`cfMaintenanceDispatch`)
 */
export const CF_FREE_FETCH_GC_MAX_SWEEPS: number = 3;

/**
 * The scheduled pass's own `minEntriesToCompact` floor (`runMaintenancePass`,
 * which `runScheduledMaintenance` runs), applied when no
 * `options.compact.minEntriesToCompact` is set. Deliberately NOT
 * `DEFAULT_MIN_TO_COMPACT` (compact()'s own 100) or
 * {@link WRITE_TICK_MIN_ENTRIES_TO_COMPACT} (50): both of those floors exist
 * for the IN-BAND write tick, where a write is not a scheduling decision and
 * folding on every one would thrash snapshot rewrites. A scheduler that
 * fires has already decided it is time to do work, so the only live tail
 * worth leaving unfolded is none — a count floor on the scheduled path
 * parks a low-write collection's tail permanently between the floor and
 * the reads' per-entry GET cost (measured: a 36-entry tail costing 36 S3
 * GETs, ~1.2s, on every read because a 100-floor cron tick skipped it for
 * months; a consumer independently converged on 1). Each fold rewrites
 * the whole snapshot, so write-amplification-sensitive callers can still
 * raise it via `options.compact.minEntriesToCompact`; see
 * docs/spec/sync-protocol.md § Maintenance runtime model.
 *
 * @see packages/server/src/maintenance.ts
 */
export const SCHEDULED_MIN_ENTRIES_TO_COMPACT: number = 1;

/**
 * Node-tier write-tick maintenance caps — a MODERATE multiple of the CF-free `WRITE_TICK_*`
 * defaults, threaded into the per-request observability context by `baerlyNode` /
 * `createFetchHandler` (§8.4). Node v1 runs maintenance INLINE on the commit path (no
 * `waitUntil`), so the cap is NOT the CF subrequest wall — it's the worst-case single-write
 * added latency. A maintenance tick only fires on a ratio/boundary trip (rare), and when it
 * does it performs bounded fold work plus bounded GC LIST classification and DELETE sweeps
 * against a co-located S3/R2 — sub-second on the occasional boundary write at a 10×
 * multiple. These are deliberately BOUNDED (10× CF-free), NOT unbounded: the deleted
 * scheduled full-tail sweep folded the entire live tail in one shot, which a 100× multiple
 * here would reintroduce as multi-second commit stalls. Raise the snapshot ceiling separately
 * via `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`; these caps slice the per-pass work, not the
 * ceiling.
 *
 * @see packages/adapter-node/src/server.ts
 * @see packages/server/src/maintenance.ts
 * @see docs/spec/scale-ceilings.md
 */
export const NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS: number = 200;

/** Node-tier per-category LIST classification/ledger-growth cap. 10× CF-free. @see {@link NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS} */
export const NODE_MAINTENANCE_GC_MAX_MARKS: number = 200;

/** Node-tier candidate DELETE cap per pass. 10× CF-free. @see {@link NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS} */
export const NODE_MAINTENANCE_GC_MAX_SWEEPS: number = 100;

/**
 * Node-tier GC cadence (boundary-crossing). Shorter than the CF-free `WRITE_TICK_GC_INTERVAL`
 * (4) so the per-write sweep budget keeps up: `gcMaxSweeps / gcInterval = 100 / 2 = 50`
 * comfortably clears the garbage-per-write rate `p` (the `maxSweeps/interval ≥ p` invariant,
 * §7.1) with a wide margin.
 *
 * @see {@link NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS}
 */
export const NODE_MAINTENANCE_GC_INTERVAL: number = 2;

/**
 * SNAPSHOT-rebuild ceiling `C` (the unsliceable axis — Decision 3a), memory. A
 * conservative configured budget for the CF-free ~10 ms CPU limit; the ~5.5 ms
 * rebuild-time figure behind it is a sizing estimate, not an observed platform
 * limit. Raise via BAERLY_MAINTENANCE_MAX_FOLD_BYTES on capable
 * hosts. Auto-maintained snapshot ceiling S_max = C. NOT snapshot+tail (tail is sliced).
 *
 * @see docs/spec/scale-ceilings.md
 * @see packages/server/src/maintenance.ts
 */
// Stryker disable next-line ArithmeticOperator: internal tuning value, not an off-process contract — asserting the literal would be a tautological change-detector. See docs/contributing/mutation-testing.md constants policy.
export const MAINTENANCE_MAX_FOLD_BYTES_DEFAULT: number = 512 * 1024;

/**
 * The largest snapshot a Cloudflare **free-tier** isolate can safely
 * rebuild in ONE fold under the ~10 ms CPU budget. This is the WARN
 * THRESHOLD, not a runtime cap: an operator who raises
 * `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` ABOVE this value on a free Worker
 * is past the conservative budget, and a larger snapshot rebuild may
 * exceed an invocation's CPU or memory resources. If an invocation is
 * terminated mid-rebuild the CAS does not land, so that fold does not
 * advance `log_seq_start`. This value is a configured budget; no
 * particular snapshot size is established to cause termination.
 *
 * Sized at 2× {@link MAINTENANCE_MAX_FOLD_BYTES_DEFAULT}. The ~5.5 ms
 * rebuild estimate for the default (512 KiB) and the linear
 * extrapolation to ~1 MiB are sizing estimates, not observed platform
 * limits; anything strictly larger is simply outside the budget
 * this constant documents. On CF **paid**
 * (raised CPU limits), Node, or once §11 chunked snapshots land, a
 * larger ceiling is fine — hence this is a one-time `console.warn` at
 * handler init, NOT a hard rejection.
 *
 * @see packages/adapter-cloudflare/src/worker.ts
 * @see packages/server/src/maintenance.ts
 * @see docs/spec/scale-ceilings.md
 */
// Stryker disable next-line ArithmeticOperator: internal tuning value, not an off-process contract — asserting the literal would be a tautological change-detector. See docs/contributing/mutation-testing.md constants policy.
export const CF_FREE_MAX_SAFE_FOLD_BYTES: number = 1024 * 1024;

/**
 * SNAPSHOT-rebuild ceiling `E`, per-entry CPU axis: gates `snapshot_rows` (per-entry
 * parse/merge/serialize is ~half of fold CPU and scales with ROW COUNT not bytes, VLDB 2021
 * Sarkar — a tiny-doc snapshot can blow CPU under C).
 *
 * This is the **cf-free** value and the shared default. `pnpm bench:fold-ceiling`
 * measures 2048 rows at ~1.5 ms against the ~10 ms free-tier budget (a ~6.6×
 * margin), and the row axis does not reach 10 ms until ~16,384 rows. The value
 * stays at 2048 as a conservative configured budget: a fold that overruns a free
 * isolate's CPU may be terminated before the `current.json` CAS lands — see
 * {@link CF_FREE_MAX_SAFE_FOLD_BYTES}. The
 * larger hosts no longer inherit it; see {@link CF_PAID_MAINTENANCE_MAX_FOLD_ROWS}
 * and {@link NODE_MAINTENANCE_MAX_FOLD_ROWS}.
 *
 * @see docs/spec/scale-ceilings.md
 * @see packages/server/src/maintenance.ts
 */
export const MAINTENANCE_MAX_FOLD_ROWS: number = 2048;

/**
 * Snapshot-rebuild byte ceiling `C` for the **cf-paid** profile.
 *
 * A paid isolate's wall is ~128 MB of Worker memory, not CPU — at a 30 s CPU
 * budget the rebuild is never CPU-bound, but a fold holds the old snapshot, the
 * new snapshot, and the tail at once. `pnpm bench:fold-ceiling` measures peak
 * heap at ~2.4× the snapshot on the byte axis, stable across 704 MB–4.3 GB
 * heaps: 8 MiB peaks at ~19.5 MB, a 4× margin under 128 MB. The next grid cell
 * up (16 MiB ⇒ 37.3 MB peak) exceeds that margin, which is what fixes this
 * value.
 *
 * The margin is deliberately tight because overrun is NOT graceful here: an
 * isolate OOM mid-fold would leave the `current.json` CAS unpublished, so that
 * fold would not advance `log_seq_start`.
 *
 * @see docs/spec/scale-ceilings.md
 * @see bench/measurement/fold-ceiling-probe.ts
 */
// Stryker disable next-line ArithmeticOperator: internal tuning value, not an off-process contract — asserting the literal would be a tautological change-detector. See docs/contributing/mutation-testing.md constants policy.
export const CF_PAID_MAINTENANCE_MAX_FOLD_BYTES: number = 8 * 1024 * 1024;

/**
 * Snapshot-rebuild row ceiling `E` for the **cf-paid** profile. Same 128 MB
 * memory wall and same 4× margin as {@link CF_PAID_MAINTENANCE_MAX_FOLD_BYTES};
 * the row axis costs ~600 B of peak heap per row (measured), so 32,768 rows
 * peaks at ~19.7 MB. The next grid cell up (65,536 rows ⇒ 39.4 MB) exceeds the
 * margin.
 *
 * @see docs/spec/scale-ceilings.md
 */
export const CF_PAID_MAINTENANCE_MAX_FOLD_ROWS: number = 32_768;

/**
 * Snapshot-rebuild byte ceiling `C` for the **node** profile.
 *
 * Serverful Node has no per-request cap, and its fold is not abortable —
 * `nodeMaintenanceDispatch` passes no `signal` — so an over-large fold
 * COMPLETES. The failure mode is one slow write, not a stranded CAS. That
 * asymmetry is why Node's ceiling is set generously where cf-free's and
 * cf-paid's are set tightly: UNDER-setting `C` permanently defers the fold,
 * which is the worse failure on every host. Inline fold latency is budgeted by
 * {@link NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS} (the sliceable tail work), not
 * by this ceiling (the unsliceable snapshot rebuild).
 *
 * 32 MiB is the top of the measured grid, NOT the wall: `pnpm bench:fold-ceiling`
 * reports `grid-exhausted` for this profile at every margin and at every heap
 * from 704 MB up. At a 704 MB heap — the smallest realistic container — a
 * 32 MiB fold peaks at ~37 MB, a ~19× margin. The scaling rule past the grid is
 * `C ≈ heap / 10` (peak ≈ 2.4× snapshot, 4× margin). Finding the real wall
 * needs the byte axis extended past 32 MiB.
 *
 * A separate hard ceiling sits near 512 MB regardless of heap: `encodeJsonBytes`
 * / `decodeJsonBytes` materialize the whole snapshot as a JS string, so a
 * snapshot at V8's `MAX_STRING_LENGTH` throws mid-fold.
 *
 * @see docs/spec/scale-ceilings.md
 * @see bench/measurement/fold-ceiling-probe.ts
 */
// Stryker disable next-line ArithmeticOperator: internal tuning value, not an off-process contract — asserting the literal would be a tautological change-detector. See docs/contributing/mutation-testing.md constants policy.
export const NODE_MAINTENANCE_MAX_FOLD_BYTES: number = 32 * 1024 * 1024;

/**
 * Snapshot-rebuild row ceiling `E` for the **node** profile. 65,536 rows is the
 * largest row cell with a stable measured peak (~39.4 MB, reproduced within
 * 0.05 MB across four runs); the 131,072-row cell's peak is not yet reliably
 * measurable. Against even a 704 MB heap that is a ~17× margin, consistent with
 * {@link NODE_MAINTENANCE_MAX_FOLD_BYTES} being a measured floor rather than a
 * wall.
 *
 * @see docs/spec/scale-ceilings.md
 */
export const NODE_MAINTENANCE_MAX_FOLD_ROWS: number = 65_536;

/**
 * Byte slack the growth refusal keeps under `C` (main-10 G4). A growth write
 * is refused when its projected snapshot bytes would exceed
 * `C - CAPACITY_BYTES_MARGIN`. The projection sizes the snapshot exactly as
 * the compactor encodes it (rows, separators, header) for a known fold end,
 * which is how fold passes are judged against `C` itself. A growth check
 * does not know when its write will fold, so the header's `max_seq` may
 * gain digits by then (at most 16 for a safe integer). 64 bytes covers that
 * with room to spare; `capacity.test.ts` checks the projection against real
 * folds byte for byte.
 *
 * @see docs/spec/scale-ceilings.md
 */
export const CAPACITY_BYTES_MARGIN: number = 64;

/**
 * Fraction of a fold ceiling at which an admitted write starts carrying a
 * capacity warning (main-10 G7). The warning fires when the projected
 * snapshot, at its peak over the pending tail and the writes just
 * admitted, holds at least this share of `E` rows or of the `C - margin`
 * bytes the growth refusal compares against. It is a policy choice, not a
 * measurement: 90% leaves roughly 200 rows of runway on Workers Free's
 * 2,048-row `E`, enough for an app to react before the first
 * `CapacityExceeded`, and about 10% of `C` in bytes. The warning is a
 * pure function of `current.json` and the tail, so it clears the moment
 * that state drops back under the threshold.
 *
 * @see packages/server/src/capacity.ts
 */
export const CAPACITY_WARN_FRACTION: number = 0.9;

/**
 * Response header an admitted write carries when it leaves the collection
 * within {@link CAPACITY_WARN_FRACTION} of its host's growth-refusal point.
 * The value is the warning text: it names the state and the app-side
 * remedy only. The same text rides the canonical log line as
 * `capacity_warning`. Absent when the collection has room.
 */
export const CAPACITY_WARNING_HEADER: string = "Baerly-Capacity-Warning";

/**
 * `retryAfter` (seconds) on a `MaintenancePending` refusal (main-10 G6).
 * The refused write dispatches one bounded fold before it refuses, and
 * that fold finishes within the same invocation: inline before the
 * response, or in the Cloudflare `ctx.waitUntil` continuation right after
 * it. A retry needs only to land after that, so the value is the smallest
 * non-zero `Retry-After` (RFC 9110 §10.2.3 delay-seconds is a whole
 * number). Each retry runs its own fold pass, so a longer backlog drains
 * across retries rather than within one delay. The HTTP client's caps on
 * those retries are `MAINTENANCE_PENDING_CLIENT_MAX_ATTEMPTS` and
 * `MAINTENANCE_PENDING_CLIENT_MAX_WAIT_MILLIS` in
 * `packages/client/src/request-retry.ts`.
 */
export const MAINTENANCE_PENDING_RETRY_AFTER_SECONDS: number = 1;

// Declared here (not the nominal server `MaintenanceProfile`) to avoid a server→protocol cycle; keep field-identical to it.
type MaintenanceProfileShape = Readonly<{
  gcInterval: number;
  gcMaxMarks: number;
  gcMaxSweeps: number;
  maxFoldEntriesPerPass: number;
  maxFoldBytes: number;
  maxFoldRows: number;
}>;

/** CF-free profile; the absent-context default. */
export const MAINTENANCE_PROFILE_CF_FREE: MaintenanceProfileShape = {
  gcInterval: WRITE_TICK_GC_INTERVAL,
  gcMaxMarks: WRITE_TICK_GC_MAX_MARKS,
  gcMaxSweeps: WRITE_TICK_GC_MAX_SWEEPS,
  maxFoldEntriesPerPass: WRITE_TICK_FOLD_ENTRIES_PER_PASS,
  maxFoldBytes: MAINTENANCE_MAX_FOLD_BYTES_DEFAULT,
  maxFoldRows: MAINTENANCE_MAX_FOLD_ROWS,
};

/** Node profile; 10× CF-free per-pass caps, and its own measured snapshot ceilings. */
export const MAINTENANCE_PROFILE_NODE: MaintenanceProfileShape = {
  gcInterval: NODE_MAINTENANCE_GC_INTERVAL,
  gcMaxMarks: NODE_MAINTENANCE_GC_MAX_MARKS,
  gcMaxSweeps: NODE_MAINTENANCE_GC_MAX_SWEEPS,
  maxFoldEntriesPerPass: NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS,
  maxFoldBytes: NODE_MAINTENANCE_MAX_FOLD_BYTES,
  maxFoldRows: NODE_MAINTENANCE_MAX_FOLD_ROWS,
};

/**
 * CF-paid profile — opt-in via `BAERLY_MAINTENANCE_PROFILE=cf-paid`. A paid
 * isolate keeps the CF-free single-phase shape (one phase per request) but has a
 * 9,000-call request ledger limit ({@link CF_PAID_REQUEST_LIMIT}), so it reuses the
 * `NODE_MAINTENANCE_*` per-pass caps.
 *
 * A profile moves RATE and the DEFER THRESHOLD, never the stored data or the
 * query semantics — that is the equivalence invariant, and it is what
 * `tests/integration/maintenance-profile-equivalence.test.ts` proves: a read
 * folds snapshot + live tail, so HOW MUCH a profile has folded is invisible to
 * a reader. Snapshot ceilings therefore differ per host, sized to each host's
 * real wall (see {@link CF_PAID_MAINTENANCE_MAX_FOLD_BYTES}). Operators can
 * still raise `C` out-of-band with `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`.
 *
 * @see packages/adapter-cloudflare/src/worker.ts
 * @see docs/about/graduation.md
 */
export const MAINTENANCE_PROFILE_CF_PAID: MaintenanceProfileShape = {
  gcInterval: NODE_MAINTENANCE_GC_INTERVAL,
  gcMaxMarks: NODE_MAINTENANCE_GC_MAX_MARKS,
  gcMaxSweeps: NODE_MAINTENANCE_GC_MAX_SWEEPS,
  maxFoldEntriesPerPass: NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS,
  maxFoldBytes: CF_PAID_MAINTENANCE_MAX_FOLD_BYTES,
  maxFoldRows: CF_PAID_MAINTENANCE_MAX_FOLD_ROWS,
};

/**
 * Rate-limit the defer-warn off SHARED current.json.last_warned_seq (not per-isolate
 * memory — CF recycles isolates). ~once per this many writes.
 *
 * @see packages/protocol/src/coordination/current-json.ts
 * @see packages/server/src/maintenance.ts
 */
export const MAINTENANCE_WARN_INTERVAL_WRITES: number = 1000;

/**
 * Rate-limit for the maintenance tick's `tail_hint` advance on every
 * path where no fold published the hint (originally HR-2, the DEFER
 * path). When the fold defers (snapshot over the configured fold ceiling),
 * when `BAERLY_MAINTENANCE_DISABLE` suppresses both phases, or when a
 * tick runs only GC, the compactor never stamps `tail_hint` via its
 * Step-7 fold CAS — so the gap `(true_tail − tail_hint)` would grow
 * without bound and every read would re-walk the whole live tail via
 * `probeTailFrom`. The runner therefore advances `tail_hint` toward the
 * observed tail with a best-effort `current.json` CAS — but only once
 * per this many writes, so it is NOT a per-commit `current.json` write
 * (which is exactly what single-write commit removed).
 *
 * This interval is a floor on the rate, not a licence to publish more
 * than once per tick. A tick publishes `tail_hint` AT MOST ONCE, by
 * whichever party gets there first, because the interval is measured
 * against the tick's in-memory `current.json` — which no CAS writes back,
 * so a repeat call still reads as due and would rewrite identical bytes.
 * Exactly two parties can publish: the runner's own refresh, and a fold
 * that returned `written` (Step-7 stamped `max(stored, discoveredTail)`
 * with `discoveredTail >= observedTail`). GC is not one of them — a GC
 * tick takes the ordinary rate-limited refresh like any other, which is
 * what makes the bound below unconditional rather than cadence-dependent.
 *
 * Sized at 128: it bounds a deferring collection's worst-case
 * read-walk to ≤128 forward GETs (≈one extra read-page sweep — a
 * negligible per-read latency cost), keeps the gap two-to-three orders
 * of magnitude below {@link LOG_FORWARD_PROBE_CAP} (so the cap-throw is a
 * pure runaway guard, never reached in normal operation), and holds the
 * hint-advance CAS rate under ~1% of the commit rate (negligible
 * Class-A cost, amortized). Smaller would tighten the read-walk at a
 * higher CAS rate; larger would loosen it — 128 is the modest middle.
 *
 * @see packages/server/src/maintenance.ts
 */
export const MAINTENANCE_TAIL_HINT_REFRESH_WRITES: number = 128;

/**
 * Stable seed for `CurrentJson.snapshot === null` when building the
 * opaque `_meta.manifest_pointer` cursor emitted on read responses.
 * The literal no longer appears by itself on the wire; it is folded
 * into the server-side digest so the cursor never exposes physical
 * snapshot keys.
 *
 * @see packages/server/src/contract.ts (HttpOkMeta)
 */
export const MANIFEST_POINTER_EMPTY_SNAPSHOT: string = "none";

/**
 * Keys that must never propagate through {@link merge}: assigning to
 * them on a plain object pollutes the prototype chain. The literal
 * `{ __proto__: ... }` syntax is a prototype-setter (not an own key)
 * and bypasses `Object.keys`, but `JSON.parse('{"__proto__":...}')`
 * produces a real own property — which is exactly how a malicious
 * HTTP PATCH body would arrive on the wire.
 *
 * Lifted to a constant so every iteration path that touches a
 * caller-supplied object can re-use the same defence without
 * duplicating the keyword list.
 *
 * @see packages/protocol/src/json.ts (merge)
 * @see docs/spec/json-merge-patch.md
 */
export const FORBIDDEN_MERGE_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Pre-provisioned, first-attempt Class A commit floor, whatever indexes the
 * collection declares.
 *
 * The floor is the sole committing `log/<seq>` create
 * (`If-None-Match: "*"`). It is not a ceiling: provisioning,
 * contention/retries, and in-band maintenance can add Class A operations.
 *
 * @see tests/integration/http-cost-shape.test.ts
 * @see packages/server/src/writer.test.ts
 * @see tests/integration/write-amp.test.ts
 */
export const COMMIT_CLASS_A_FLOOR: number = 1;

/**
 * Canonical auth posture identifiers consumed by `BaerlyAppConfig.auth`,
 * the adapter resolution path (`packages/adapter-cloudflare/src/worker.ts`,
 * `packages/adapter-node/src/baerly-node.ts`), and `baerly doctor`.
 *
 * - `"none"` — no header check; pin every request to `config.tenant`.
 *   For local dev, intranet, CLI tools — contexts where the network
 *   seam itself is the trust boundary.
 * - `"shared-secret"` — bearer-token check; reads `SHARED_SECRET` from
 *   the runtime env and pins every request to `config.tenant`.
 *
 * Custom verifiers (`cloudflareAccess`, `bearerJwt`, SigV4, …) bypass
 * this enum — pass a `Verifier` to the adapter factory's `verifier:`
 * option instead.
 */
export const AUTH_CONFIG_VALUES = ["none", "shared-secret"] as const;

/**
 * Locked error wording for the "no auth configured" failure mode. The
 * adapter throws this when neither `config.auth` nor `verifier:`
 * resolves a real `Verifier`. Pinned via a regression test so future
 * refactors do not drift the operator-facing wording.
 *
 * Consumed by:
 * - `packages/adapter-cloudflare/src/worker.ts` (first-fetch throw)
 * - `packages/adapter-node/src/server.ts` (first-fetch throw)
 * - `packages/cli/src/doctor/cloudflare.ts` (FAIL finding mirrors it)
 */
export const NO_AUTH_CONFIGURED_MESSAGE: string =
  'baerly: no auth configured. Set `auth` in baerly.config.ts ("none", "shared-secret") or pass `verifier` on the adapter factory.';

/**
 * Locked error wording for `auth: "shared-secret"` + missing env var.
 * Same pinning rationale as {@link NO_AUTH_CONFIGURED_MESSAGE}.
 */
export const SHARED_SECRET_MISSING_MESSAGE: string =
  'baerly: auth="shared-secret" but SHARED_SECRET env is empty/unset. Cloudflare: `wrangler secret put SHARED_SECRET`, or add to .dev.vars for local dev. Node: set in process env.';

/**
 * Stands in for "this manifest has no `generation`". Both spellings of
 * that state — a `current.json` predating the field, and a bare-LSN
 * cursor minted before this build — decode to this value, so an
 * ordinary string comparison handles them without a fail-open branch.
 * See the truth table in `docs/spec/sync-protocol.md`.
 *
 * `"-"` is safe as the sentinel because a real generation is a minted
 * lowercase-hex nonce (`mintGeneration`), and hex contains no `-`. So
 * the sentinel can never collide with a value a manifest actually
 * carries, in either the `/v1/since` cursor codec or the GC candidate
 * fence.
 *
 * Sited HERE rather than next to the cursor codec that first needed
 * it: `constants.ts` is a zero-import leaf, and `runGc` imports this
 * sentinel. Re-exported from `cursor.ts` so existing importers are
 * unaffected. Importing it from `cursor.ts` instead would drag
 * `parseCursor` + `formatCursor` into the `index.js` and
 * `maintenance.js` closures — every consumer paying for a `/v1/since`
 * codec to get one `"-"`.
 */
export const NO_GENERATION = "-";
