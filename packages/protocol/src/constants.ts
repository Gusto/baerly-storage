/**
 * Half-window (in milliseconds) within which a manifest write's embedded
 * timestamp must agree with the server's `LastModified` header for the
 * write to be accepted by replaying clients. Writes outside this window
 * are rejected by `Syncer.isValid` and GC'd if `autoclean` is on; the
 * writer also adapts its `clockOffset` and retries.
 *
 * 5s is the protocol's tolerance for client/server clock skew. Tightening
 * this can cause spurious rejections on machines that haven't synced NTP;
 * loosening it widens the window during which causal ordering can be
 * disturbed by skew.
 *
 * @see docs/spec/sync-protocol.md
 */
export const LAG_WINDOW_MILLIS: number = 5000;

/**
 * How far into the future (relative to `Date.now() + clockOffset`) the
 * manifest list-objects-v2 `StartAfter` cursor is positioned. Generous
 * lookahead so a write whose suffix landed slightly ahead of local time
 * is still picked up by the next poll.
 *
 * Must be ≥ {@link LAG_WINDOW_MILLIS}; otherwise valid writes near the
 * skew boundary could be missed.
 *
 * @see syncer.ts (`Syncer.getLatest`)
 */
export const MANIFEST_LIST_LOOKAHEAD_MILLIS: number = 10000;

/**
 * Bit width of the base-32 timestamp suffix encoded into manifest keys
 * (`<manifestKey>@<base32-time>_<session>_<seq>`). 42 bits gives ~139
 * years of millisecond precision, which is enough for the protocol's
 * lifetime.
 *
 * Changing this is a protocol-breaking change.
 *
 * @see docs/spec/sync-protocol.md
 */
export const TIMESTAMP_BIT_WIDTH: number = 42;

/**
 * Length of the random-prefix `session_id` embedded in manifest keys.
 * 6 hex chars from `crypto.randomUUID()` give 16⁶ ≈ 1.7 × 10⁷ distinct
 * sessions; birthday-collision rate at N=100 is ~3 × 10⁻⁴, comfortably
 * below the 1 % bound asserted in `tests/regressions.test.ts`. Collisions
 * within a single manifest's writer set are also disambiguated by the
 * trailing `<seq>` counter.
 *
 * @see syncer.ts (`Syncer.session_id`)
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
 * Default retry budget for `S3HttpStorage.retry` (the wrapper around
 * each of the four `Storage` methods). Bounded so that permanent
 * failures (CORS misconfig, NXDOMAIN, persistent 5xx) surface to
 * callers as rejected promises instead of retrying forever and
 * leaving `ServerWriter.commit()` permanently pending.
 *
 * 8 attempts at the existing 100ms→×1.5→10s schedule covers ~30s of
 * transient turbulence, which is enough to ride out a leader election
 * or a brief network blip without papering over a real outage.
 */
export const S3_REQUEST_MAX_RETRIES: number = 8;

/**
 * Maximum number of times {@link Syncer.updateContent} will regenerate a
 * manifest key after the server's `LastModified` disagreed with the
 * embedded timestamp. After this many adjustments, `updateContent`
 * gives up with a `NetworkError` so callers see a real fault instead
 * of an infinite loop. Two adjustments suffices in practice — first to
 * learn the server clock, second to converge.
 *
 * @see syncer.ts updateContent retry loop
 */
export const SYNCER_CLOCK_SKEW_MAX_RETRIES: number = 4;

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
 * Bounded fan-out only changes behavior on a cold cache; warm reads
 * are absorbed by {@link MEM_CACHE_CAPACITY} regardless.
 *
 * @see packages/server/src/log-walk.ts (`walkLogRange`)
 */
export const MAX_PARALLEL_LOG_READS: number = 16;

/**
 * Maximum number of `getObject` responses retained in Baerly's in-memory
 * cache (keyed by `(Bucket, Key, VersionId, IfNoneMatch)`).
 *
 * The cache exists to coalesce repeat reads of the same content version
 * during a single tab session. With `useVersioning: true` every write
 * mints a new `VersionId`, so an unbounded cache pins every historical
 * version forever and grows linearly with write volume. 100 entries is
 * generous for the typical "current value plus a few in-flight reads"
 * working set while keeping memory bounded.
 */
export const MEM_CACHE_CAPACITY: number = 100;

/**
 * Grace window during which a content 404 (against a key the manifest
 * references) is treated as an in-flight write rather than an orphan
 * manifest entry. The manifest-first ordering in `ServerWriter.commit`
 * PUTs the manifest entry before the content, so a reader polling
 * between the two sees a manifest that points at content that does
 * not yet exist.
 *
 * Within this window, readers return `undefined` to callers — a
 * subsequent read likely sees the content once the writer finishes.
 * Outside the window, readers still return `undefined` but warn
 * because the manifest entry is most likely orphaned by a writer that
 * died mid-batch (the Phase-6 sweeper GCs these).
 *
 * Sized at 6× {@link LAG_WINDOW_MILLIS} (30s) to comfortably cover S3
 * write propagation plus a few poll cycles while still surfacing
 * genuinely orphaned entries reasonably quickly.
 *
 * @see docs/spec/sync-protocol.md
 */
export const ORPHAN_MANIFEST_GRACE_MILLIS: number = 6 * LAG_WINDOW_MILLIS;

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
 * should still find its idempotency anchor on the bucket). The Phase 5
 * `runGc()` function accepts an override for tests.
 *
 * Distinct from {@link ORPHAN_MANIFEST_GRACE_MILLIS} (30s) — that
 * constant is the in-process window during which the legacy
 * `Syncer.classifyMissingContent` treats a missing content blob as
 * "in-flight"; this constant is the on-bucket dwell time for a
 * candidate before the GC sweep deletes it.
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
