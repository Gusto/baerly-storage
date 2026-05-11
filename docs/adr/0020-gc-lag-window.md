# 0020 — GC lag window

## Status

Accepted (2026-05-11).

## Context

Phase-5 compaction folds old log entries into snapshots and retires the
original log files; the sweeper in
[`packages/server/src/gc.ts`](../../packages/server/src/gc.ts) deletes
anything no longer referenced by `current.json`. Three categories of
orphan are swept
([`packages/server/src/gc.ts:24-36`](../../packages/server/src/gc.ts)):

- `stale-log`: log entries below `log_seq_start`.
- `orphan-snapshot`: snapshot files not equal to `current.snapshot`.
- `orphan-content`: content blobs whose hash is not in the live
  post-image set.

The dominant hazard is a paused writer. A writer commits a log entry,
then pauses — mid-iteration suspend, slow Node GC, scheduler-induced
delay, geographic round-trip — and resumes hours later. The retry path
expects to find its content blob still on the bucket; the protocol's
idempotency anchor is the content hash. If GC has already deleted the
blob, the writer either dies or re-publishes content under the same
name. Both are wrong.

The defensive shape is a two-phase mark + sweep: mark the candidate in
a CAS-protected pending list, wait long enough for any in-flight
writer to find its anchor, then delete. The dwell time is the *grace
window*. See
[`packages/server/src/gc.ts:11-17`](../../packages/server/src/gc.ts)
and
[`packages/server/src/gc.ts:149-158`](../../packages/server/src/gc.ts).

Three options for the window's length:

- **1 day.** Cheap to verify in tests; aggressive cleanup. Risks:
  pauses in Workers' isolate scheduling, cross-region replication lag,
  retries from `s3-http.ts:RATE_LIMIT_BACKOFF_MILLIS` cascades could
  plausibly exceed an hour under pathological conditions, but not a
  day.
- **7 days.** Spans the worst plausible writer-retry window: a writer
  paused for a long-running batch job, a queue backlog, a maintenance
  pause, or a multi-day outage in a downstream service the writer is
  retrying through.
- **30 days.** Conservative; matches some cloud providers' soft-delete
  defaults. Doubles `gc/pending.json` size at steady state and slows
  visibility into "did the GC actually run?" by 4×.

## Decision

The default grace is `7 * 24 * 60 * 60 * 1000` milliseconds (= 7 days),
exposed as `GC_GRACE_PERIOD_MILLIS` at
[`packages/protocol/src/constants.ts:187`](../../packages/protocol/src/constants.ts).
Tests override via `RunGcOptions.graceMillis`; `0` is permitted to
exercise the sweep path in one pass without dwell — used by the
phase-5 end-to-end test and the crash-injection fuzzer. See
[`packages/server/src/gc.ts:72-76`](../../packages/server/src/gc.ts)
and
[`packages/server/src/gc.ts:154`](../../packages/server/src/gc.ts).

This grace is distinct from `LAG_WINDOW_MILLIS = 5000` at
[`packages/protocol/src/constants.ts:15`](../../packages/protocol/src/constants.ts),
which is the in-process clock-skew tolerance for embedded write
timestamps; that constant governs `Syncer.isValid` rejection, not
on-bucket dwell. The cross-instance synchronisation bound is captured
separately in [ADR-0021](./0021-sync-bounds-across-adapters.md), and
the in-process clock-skew tolerance composes with the auth verifier's
own clock assumptions ([ADR-0014](./0014-auth-verifier-interface.md)).

Seven days is the smallest window that spans every plausible
writer-retry latency observed in the deployment patterns this protocol
targets (long-running batch jobs, multi-region propagation delays,
queue backlogs, downstream outages the writer is retrying through).
One day is too aggressive for batch workloads; thirty days is
conservative beyond the worst plausible pause and bloats
`gc/pending.json` for no observable durability gain. The constant is
overridable in tests and tunable per-operator if a future workload
class shows the default is wrong; the protocol is unaffected by the
choice of value within the [hours, weeks] range.

## Consequences

- `gc/pending.json` carries every orphan candidate for ~7 days.
  Per-collection size is bounded by `GC_MAX_PENDING_CANDIDATES = 1000`
  at
  [`packages/protocol/src/constants.ts:198`](../../packages/protocol/src/constants.ts);
  subsequent passes pick up the rest.
- The default scheduled cadence (hourly on Cloudflare cron) sweeps far
  more often than the grace window, so the bound on
  time-to-disk-recovery for a permanent orphan is roughly seven days
  plus one sweep cadence.
- Operators who want faster reclamation can lower
  `RunGcOptions.graceMillis` at their own risk. Going below the
  longest plausible writer-retry latency for *their* workload risks
  deleting an anchor a writer is about to find on retry, surfacing as
  a `404` mid-replay — a livelock signal.
- Production code MUST NOT call `runGc` with
  `graceMillis < GC_GRACE_PERIOD_MILLIS` outside maintenance windows.
  Test code that sets `graceMillis: 0` is exercising the sweep path
  deliberately, not modelling a production deployment.
- CAS loss on `gc/pending.json` is non-fatal: the DELETEs already
  issued are durable, so the next pass picks up any work this pass
  lost
  ([`packages/server/src/gc.ts:37-40`](../../packages/server/src/gc.ts)).
- The seven-day default composes with the GC observability stack
  ([ADR-0022](./0022-observability-tag-naming.md)):
  `db.orphan.candidate_count` (gauge) and
  `db.gc.entries_swept_per_second` (gauge) are continuous over the
  window, so a sustained increase in candidate count predicts a
  downstream livelock several days before the sweep starts to lag.
- The grace window is the GC complement of the per-collection CAS
  scope ([ADR-0018](./0018-tenant-cas-isolation.md)): the sweeper
  consults `current.json` to identify live keys, so collection drops
  produce orphan `current.json` candidates that dwell for the same
  grace window before deletion.
- The property-test cascade does NOT set `graceMillis: 0` — it relies
  on the default so the sweep semantics under realistic dwell are
  exercised in CI.
