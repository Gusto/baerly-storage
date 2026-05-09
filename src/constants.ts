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
 * @see docs/sync_protocol.md
 */
export const LAG_WINDOW_MILLIS: number = 5000;

/**
 * Default value for {@link MPS3Config.pollFrequency}. The manifest poller
 * fires at this cadence whenever there's at least one subscriber. Each
 * tick costs at most one S3 GET (cached via `If-None-Match` when
 * `minimizeListObjectsCalls` is on).
 *
 * Lowering this reduces visibility lag for remote writes; raising it
 * reduces request volume.
 */
export const MANIFEST_POLL_INTERVAL_MILLIS: number = 1000;

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
 * @see docs/sync_protocol.md
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
 * Maximum attempts `S3ClientLite.listObjectV2` will make to LIST a
 * manifest prefix. After this many 429s in a row, it gives up with
 * a `NetworkError`.
 */
export const LIST_OBJECT_MAX_RETRIES: number = 10;

/**
 * Backoff (in milliseconds) inserted between LIST attempts when S3
 * returns 429 (rate-limited).
 */
export const RATE_LIMIT_BACKOFF_MILLIS: number = 1000;

/**
 * Default retry budget for `S3ClientLite.retry` (the wrapper around
 * `getObject`/`putObject`/`listObjectV2`/`deleteObject`). Bounded so that
 * permanent failures (CORS misconfig, NXDOMAIN, persistent 5xx) surface
 * to callers as rejected promises instead of retrying forever and
 * leaving `mps3.put()` permanently pending.
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
 * Maximum number of `_getObject` responses retained in MPS3's in-memory
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
