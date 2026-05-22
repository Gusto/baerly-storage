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
export const CURRENT_JSON_SCHEMA_VERSION = 1 as const;

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
