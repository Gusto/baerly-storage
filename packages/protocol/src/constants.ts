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
 * @see packages/protocol/src/storage/s3-http.ts (`parseRetryAfter`)
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
 * 16 keeps the worst-case under retry to `16 * 8 = 128` concurrent
 * GETs — comfortably under the Workers subrequest cap (50 concurrent
 * / 1000 total) and leaving headroom for the writer's content / index
 * / log / CAS PUTs sharing the same isolate.
 *
 * @see packages/server/src/log-walk.ts (`walkLogRange`)
 */
export const MAX_PARALLEL_LOG_READS: number = 16;

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
export const CURRENT_JSON_SCHEMA_VERSION = 2 as const;

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
 * Fold-trigger ratio: fold fires at tail ≥ R×snapshot. Pure READ-AMP / fold-frequency
 * knob — with the ceiling on the snapshot axis (Decision 3a, tail sliced) the
 * auto-maintained snapshot ceiling is S_max = C, NOT C/(1+R). R=1.0 caps steady-state
 * read-amp at ~2× and keeps compaction write-amp (≈1+1/R) moderate. See
 * docs/about/graduation.md for the derivation.
 *
 * @see docs/about/graduation.md
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
 * Per-tick GC budget — these are DEFAULTS (= the most-constrained tier, CF free, reusing
 * the TESTED `CLOUDFLARE_FREE_TIER` values in maintenance.ts / maintenance.budget.test.ts).
 * The adapter THREADS per-tier overrides into the context (§8.4); Node/CF-paid raise them.
 * NOT universal constants — a Node-sized value here would silently kill every CF-free fold
 * (round-4 Tier-1). gc pass ≈ 6 + maxMarks + maxSweeps subrequests (both GET/DELETE the
 * bucket — §3.1). Cadence is BOUNDARY-CROSSING (§3.1), not modulo.
 *
 * @see packages/server/src/maintenance.ts
 * @see packages/server/src/maintenance.budget.test.ts
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
 * Maximum GC marks per write-tick pass (M in 6+M+S; GETs the live tail to hash).
 *
 * @see packages/server/src/maintenance.ts
 */
export const WRITE_TICK_GC_MAX_MARKS: number = 20;

/**
 * Maximum GC sweeps per write-tick pass (S in 6+M+S; DELETE subrequests).
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
 * does it costs ~`maxFoldEntriesPerPass` + (6 + `gcMaxMarks` + `gcMaxSweeps`) storage
 * round-trips against a co-located S3/R2 — sub-second on the occasional boundary write at a
 * 10× multiple. These are deliberately BOUNDED (10× CF-free), NOT unbounded: the deleted
 * scheduled full-tail sweep folded the entire live tail in one shot, which a 100× multiple here
 * would reintroduce as multi-second commit stalls. Raise the snapshot ceiling separately via
 * `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`; these caps slice the per-pass work, not the ceiling.
 *
 * @see packages/adapter-node/src/server.ts
 * @see packages/server/src/maintenance.ts
 * @see docs/about/graduation.md
 */
export const NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS: number = 200;

/** Node-tier GC marks per pass (M in 6+M+S). 10× CF-free. @see {@link NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS} */
export const NODE_MAINTENANCE_GC_MAX_MARKS: number = 200;

/** Node-tier GC sweeps per pass (S in 6+M+S). 10× CF-free. @see {@link NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS} */
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
 * @see docs/about/graduation.md
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
 * @see docs/about/graduation.md
 */
// Stryker disable next-line ArithmeticOperator: internal tuning value, not an off-process contract — asserting the literal would be a tautological change-detector. See docs/contributing/mutation-testing.md constants policy.
export const CF_FREE_MAX_SAFE_FOLD_BYTES: number = 1024 * 1024;

/**
 * SNAPSHOT-rebuild ceiling `E`, per-entry CPU axis: gates `snapshot_rows` (per-entry
 * parse/merge/serialize is ~half of fold CPU and scales with ROW COUNT not bytes, VLDB 2021
 * Sarkar — a tiny-doc snapshot can blow CPU under C). PROVISIONAL — calibrate via the
 * Task 3 bench, pin in graduation.md.
 *
 * @see docs/about/graduation.md
 * @see packages/server/src/maintenance.ts
 */
export const MAINTENANCE_MAX_FOLD_ROWS: number = 2048;

/**
 * Rate-limit the defer-warn off SHARED current.json.last_warned_seq (not per-isolate
 * memory — CF recycles isolates). ~once per this many writes.
 *
 * @see packages/protocol/src/coordination/current-json.ts
 * @see packages/server/src/maintenance.ts
 */
export const MAINTENANCE_WARN_INTERVAL_WRITES: number = 1000;

/**
 * Placeholder for `CurrentJson.snapshot === null` in the
 * `_meta.manifest_pointer` cursor emitted on read responses. The
 * wire format is `"<snapshot>@<next_seq>"`, and `null` snapshots
 * serialise as this literal so the cursor is never empty and stays
 * byte-stable when destructured by operators.
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
 * Architecturally-enforced ceiling: storage ops per logical write.
 *
 * Three Class A ops: PUT content, PUT log entry, CAS-advance
 * `current.json`. The cost-model page derives the free-tier write
 * budget from this multiplier; the phase-5 end-to-end test asserts it
 * at CI time. Changing this constant is a cost-model-breaking change.
 *
 * @see docs/about/cost-model.md §"Cost ceiling"
 * @see tests/integration/phase5-end-to-end.test.ts
 */
export const STORAGE_OPS_PER_LOGICAL_WRITE: number = 3;

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
