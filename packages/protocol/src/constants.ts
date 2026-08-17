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
 * Maximum attempts `S3HttpStorage.list` will make per page when the
 * server replies 429 (rate-limited). After this many in a row, it
 * gives up with `NetworkError`. Separate from the inner transient-
 * failure budget so a single hot page can't burn the whole retry
 * allowance.
 */
export const LIST_OBJECT_MAX_RETRIES: number = 10;

/**
 * Backoff (in milliseconds) inserted between LIST attempts when S3
 * returns 429 (rate-limited).
 */
export const RATE_LIMIT_BACKOFF_MILLIS: number = 1000;

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
 * Default retry budget for `S3HttpStorage.retry` (the wrapper around
 * each of the four `Storage` methods). Bounded so that permanent
 * failures (CORS misconfig, NXDOMAIN, persistent 5xx) surface to
 * callers as rejected promises instead of retrying forever and
 * leaving `Writer.commit()` permanently pending.
 *
 * 8 attempts at the existing 100ms→×1.5→10s schedule covers ~30s of
 * transient turbulence, which is enough to ride out a leader election
 * or a brief network blip without papering over a real outage.
 */
export const S3_REQUEST_MAX_RETRIES: number = 8;

/**
 * Maximum concurrent log-entry GETs issued by a single `walkLogRange`
 * call. Bounds Class-B fan-out per read and per CAS attempt — without
 * a bound, a reader on a collection whose compactor has fallen behind
 * fans out one GET per live-tail entry (typically 50-100 on the free-
 * tier profile), and a contended writer multiplies that by the CAS
 * retry budget ({@link S3_REQUEST_MAX_RETRIES}).
 *
 * 16 bounds CONCURRENCY, not the per-request total. `16 * 8 = 128` is
 * the whole-request worst case across the retry budget, which fits the
 * Cloudflare PAID subrequest cap (10,000/request since 2026-02-11) but
 * not the free cap (50/request) — see `docs/spec/scale-ceilings.md`
 * §Per-tier bounds. A free-tier reader relies on the compactor keeping
 * the live tail short enough that the walk never approaches it. Do not
 * cite this 128 as a per-request budget for anything else.
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
 * Descent budget on the writer's backwards pre-image walk
 * (`Writer#readPreImage`): max `log/<seq>` GETs below the committing
 * seq before the walk gives up and reports "pre-image unknown".
 *
 * The walk MUST be 404-tolerant — a folded-and-swept entry and a peer
 * mid-CAS are indistinguishable from a missing object — so it cannot
 * use a hole as a stop signal, and `seq` grows monotonically forever.
 * Without this budget the walk is O(seq): once GC sweeps a doc's last
 * I/U past the {@link GC_GRACE_PERIOD_MILLIS} grace, every later
 * `U` / `D` on that doc issues one SEQUENTIAL GET per seq down to 0,
 * then returns "unknown" and deletes nothing. That is unbounded
 * opportunistic work on the request path — the shape
 * `docs/contributing/conventions/change-discipline.md` rules out.
 *
 * Deliberately NOT floored at `log_seq_start`: sub-floor entries
 * survive the 7-day GC grace, so a post-fold `U` / `D` can still find
 * its pre-image below the floor. The budget is anchored at the
 * committing seq instead, which makes the cost unconditional.
 *
 * **Sized by the subrequest wall, not by coverage.** Cloudflare free
 * allows 50 subrequests per request total
 * (`docs/spec/scale-ceilings.md` §Per-tier bounds); R2 binding ops count
 * 1:1, and a `ctx.waitUntil` maintenance continuation draws on the
 * same per-invocation budget. One `op:"U"` commit on a single-index
 * collection already costs ~15 before this walk — 1 GET
 * `current.json`, ~10 sequential GETs for `findLogTail`'s gallop over
 * a one-fold-interval `tail_hint` lag, 1 index `newKey` PUT, the
 * `log/<seq>` create, 1 GET re-reading `current.json` after that create
 * resolves to reject a create that landed below the certified delete floor
 * (`Writer#assertCommitAboveDeleteFloor`), 1 stale-key DELETE — and the
 * write-tick fold branch it may dispatch costs ~26 more (1 runner GET
 * + `compact()`'s 3 + {@link WRITE_TICK_FOLD_ENTRIES_PER_PASS} log
 * GETs + 2 PUTs). `50 - 15 - 26 = 9`; `PREIMAGE_SCAN_MAX_GETS = 8`
 * leaves one spare subrequest. The post-create delete-floor re-read adds no
 * billable cost — `billableClassAOps = puts + lists` excludes GET — but it
 * does consume the subrequest headroom, so this budget cannot rise without
 * re-deriving the total. The walk is strictly SEQUENTIAL, so this is a hard
 * per-request cost, not a fan-out bound like {@link MAX_PARALLEL_LOG_READS}.
 *
 * **What that budget actually covers.** The pre-image sits roughly
 * one working-set of seqs back, so 8 reaches a doc rewritten within
 * the last few log entries — a form re-save, a retry, a two-phase
 * update — and nothing colder. On a collection with more than ~8
 * actively-written docs the walk normally gives up. That is accepted:
 * the residual is a benign extra index key (a false positive dropped
 * by `matchesWire`, never a missing candidate — see
 * `docs/spec/sync-protocol.md` invariant 7), and `rebuildIndex` /
 * `baerly admin fsck --indexes` is the authoritative reconciler. The
 * give-up is deliberately NOT counted: at this budget it is the
 * common path, not an anomaly, so a counter would be noise rather
 * than signal.
 *
 * A per-tier budget on `MaintenanceProfile` (free 8, Node / CF-paid
 * far higher — the same commit leaves ~9,780 of a 10,000 subrequest
 * budget there) would buy real coverage back on the larger tiers.
 * Not built: it widens the profile surface for a best-effort cleanup
 * path whose backstop already exists.
 *
 * @see packages/server/src/writer.ts (`Writer#readPreImage`)
 */
export const PREIMAGE_SCAN_MAX_GETS: number = 8;

/**
 * Sequence-distance safety window retained below `log_seq_start` before
 * `log/<seq>.json` objects become retirable.
 *
 * `Writer#readPreImage` is the only production reader deliberately allowed
 * below the manifest floor it observed. Its reach is capped by
 * {@link PREIMAGE_SCAN_MAX_GETS}; the 128x multiplier gives the current 8-GET
 * reach a 1024-sequence window while keeping that relationship explicit if the
 * pre-image budget changes.
 *
 * **This window is NOT a paused-writer fence, and no safety property may be
 * derived from it.** It is a pre-image cost margin and a rate limit on how fast
 * retirement approaches the live floor — nothing more. The withdrawn argument
 * was that a certified-deleted slot needs `log_seq_start` to advance by more
 * than this window "during one in-flight commit". The arithmetic is correct and
 * the quantifier is vacuous: one in-flight commit bounds no wall-clock and no
 * commit count, so this is a rate x duration assumption expressed in sequences,
 * the same class as `GC_GRACE_PERIOD_MILLIS` in seconds. Lowering the value on
 * cost grounds costs pre-image coverage and retirement smoothness; it does not
 * weaken a safety proof, because there was never one here.
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
export const LOG_RETENTION_SEQ_WINDOW: number = PREIMAGE_SCAN_MAX_GETS * 128;

/**
 * Maximum log-object DELETEs a retention pass may attempt on one write tick.
 * Twenty fits within the most constrained request budget and drains faster than
 * the fold floor advances in steady state.
 *
 * `retireLogRange` is the pass that spends this budget. Every maintenance
 * trigger runs it via the shared `retireLogs` helper in `maintenance.ts`:
 * `runScheduledMaintenance` after its GC phase, and `runBoundedMaintenance`
 * both on the hard-GC early-return path and as its final step. The combined
 * per-tick subrequest arithmetic, against the worst cases `maintenance.ts`'s
 * `CLOUDFLARE_FREE_TIER` JSDoc documents:
 *
 * - One retirement pass, worst case, is 23 subrequests: 1 advisory-gate GET
 *   + `casUpdateCurrentJson`'s own GET + 1 CAS PUT + up to 20 DELETEs.
 * - A maximally contended write-tick GC including the retirement gate read
 *   is 26 storage operations, pinned exactly by `maintenance-budget.test.ts`.
 *   When the gate finds work, the pass adds its CAS read + CAS write + up to
 *   20 DELETEs on top (48 of 50 worst case).
 * - A compaction pass is ≤49, so compact + retirement is 72. **Retirement
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
 *    {@link RATE_LIMIT_BACKOFF_MILLIS} retry cascades can plausibly
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
 * Bounded retry cap for the `gc/pending.json` CAS read-modify-write
 * loop in {@link casUpdateGcPending}. On `Conflict` (a concurrent GC
 * pass landed between this pass's read and its write) the loop
 * re-reads `latest` and re-applies the pure merge mutator, retrying up
 * to this many total attempts before surfacing `Conflict`. Safe to
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
 * NOT universal constants — a Node-sized value here would silently kill every CF-free fold
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
 * N=20 slice, the worst pass is 49 operations, leaving one operation
 * below the 50-subrequest invocation cap.
 *
 * @see packages/server/src/maintenance.ts
 * @see packages/server/src/maintenance-budget.test.ts
 */
export const CF_FREE_COMPACT_TAIL_PROBE_GETS: number = 25;

/**
 * compact()'s minEntriesToCompact, set EXPLICITLY by the runner so it agrees with Gate 1
 * rather than inheriting compact()'s silent default 100 (which would contradict the 64 KB
 * first-fold story — round-4 Tier-3). Adapter-overridable; CF-free value.
 *
 * @see packages/server/src/maintenance.ts
 */
export const WRITE_TICK_MIN_ENTRIES_TO_COMPACT: number = 50;

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
 * SNAPSHOT-rebuild ceiling `C` (the unsliceable axis — Decision 3a), memory. Default sized
 * ~5.5 ms under CF-free ~10 ms. Raise via BAERLY_MAINTENANCE_MAX_FOLD_BYTES on capable
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
 * risks a snapshot rebuild that exceeds the ~10 ms CPU limit and gets
 * CPU-killed MID-REBUILD — the CAS never lands, so the fold silently
 * never advances `log_seq_start` and the tail grows unbounded.
 *
 * Sized at 2× {@link MAINTENANCE_MAX_FOLD_BYTES_DEFAULT}. The default
 * (512 KiB) rebuilds in ~5.5 ms under the CF-free ~10 ms budget
 * (constants.ts default JSDoc); linear-extrapolating, ~1 MiB is the
 * point where one-shot rebuild fills the budget with little margin, so
 * anything strictly larger is no longer free-tier-safe. On CF **paid**
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
 * stays at 2048 because overrun on a free isolate is CPU-killed MID-REBUILD and
 * strands the `current.json` CAS — see {@link CF_FREE_MAX_SAFE_FOLD_BYTES}. The
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
 * isolate OOM mid-fold strands the `current.json` CAS exactly like a CF-free
 * CPU kill, so the fold silently never advances `log_seq_start`.
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
 * isolate keeps the CPU-killable single-phase shape but has the 10,000-
 * subrequest budget (vs free's 50), so it reuses the `NODE_MAINTENANCE_*`
 * per-pass caps.
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
 * path). When the fold defers (snapshot over the CF-CPU-kill ceiling),
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
 * Pre-provisioned, unindexed, first-attempt Class A commit floor.
 *
 * The floor is the sole committing `log/<seq>` create
 * (`If-None-Match: "*"`). It is not a ceiling: provisioning, additive
 * and stale index-marker mutations, contention/retries, and in-band
 * maintenance can add Class A operations.
 *
 * @see tests/integration/http-cost-shape.test.ts
 * @see packages/server/src/writer.test.ts
 * @see tests/integration/write-amp.test.ts
 */
export const UNINDEXED_COMMIT_CLASS_A_FLOOR: number = 1;

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
