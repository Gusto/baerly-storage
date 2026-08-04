---
"@gusto/baerly-storage": patch
---

Fence GC deletion candidates to the collection generation that marked
them, re-validate `stale-log` liveness at sweep time, and clear the GC
ledger on `baerly admin restore`.

**The bug.** A `GcCandidate` was a bare key with no identity. The sweep
already re-checked a due orphan-snapshot against a freshly-read
`current.snapshot`, and an orphan-content key against the live
content-hash set, but nothing tied a candidate to the collection it was
judged against and nothing re-checked a `stale-log` candidate at all. A
mark decision taken under one view of the bucket could therefore
execute up to seven days later against a different one.

The reachable consequence involved no crash. `runGc` sweeps `log/K` and
then loses the `gc/pending.json` CAS; it catches that `Conflict` and
reports success, so the swept candidate stays in the ledger. `baerly
admin restore --force` reseeds `log_seq_start` from the surviving log
objects — the deliberate floor exemption, which can land the floor
BELOW where it was — and re-creates `log/K`. The sticky candidate
deletes it, and the resulting hole inside `[log_seq_start, tail)` makes
every read and every fold throw `BaerlyError{code:"Internal"}` from
`walkLogRangeWithBytes`. The collection is unreadable and cannot heal
itself.

**The fix.** `GcCandidate` now carries an optional `generation`,
stamped from `current.json` at mark time. The sweep drops — never
deletes — a candidate whose generation no longer matches the live
manifest, and a `stale-log` candidate whose seq now sits at or above the
floor. Dropping resolves a candidate out of the ledger without deleting
anything, which also closes a latent starvation path: `mergeGcPending`
keeps the FIRST `GC_MAX_PENDING_CANDIDATES`, so a permanently-live
candidate at the head previously blocked the ledger forever. Liveness is
re-derived from the manifest and floor the pass already holds, so this
adds no storage operations.

Both reseed branches of `baerly admin restore` now also delete
`gc/pending.json` before the writer's first commit, so a reseed no
longer leaves behind a ledger describing the previous incarnation — one
whose candidates name keys from the truncated log and whose rotation
cursors and pending depth describe a keyspace that is gone. The delete
lands before the first commit rather than after, because those commits
tick maintenance in-band and so can run `runGc` inside the restore
itself.

Relatedly, `casUpdateGcPending` now reports a missing `gc/pending.json`
as `Conflict` rather than `InvalidResponse`. Nothing in the system
deleted that object before this change, so the branch was unreachable;
the restore clear above makes it routine. It is a CAS precondition
failure rather than a separate class of fault — the pre-read is an
optimisation, and the `If-Match` PUT it short-circuits would have
returned 412 against a deleted key and been translated to `Conflict`
anyway. Without the reclassification, a GC pass that read the ledger
before a concurrent restore and reached its CAS afterwards would throw
out of `runGc`: the write tick would count an alert-grade
`db.maintenance.unexpected_error_total`, and `runScheduledMaintenance`
(documented "Errors propagate") would surface a corrupt-data code to an
operator's cron during a routine restore. `InvalidResponse` stays
reserved for a ledger body that is present but unparseable or
shape-invalid — a failure that never self-heals and must keep escaping.

**What this closes, and what it does not.** The persistent hazard is
gone: a candidate that outlived the collection it was judged against is
dropped by the next pass, which reads the replacement manifest and sees
the generation mismatch. A pass already **in flight** when a restore
lands still holds the pre-restore manifest, and the gate can only be as
fresh as the manifest that pass holds — so a residual window remains,
bounded by the duration of one pass rather than by the seven-day grace.
Invariant 14 in `docs/spec/sync-protocol.md` states that freshness
bound. A restore whose outcome matters is still best run without a
maintenance pass racing it.

**New metric.** `db.gc.dropped_total`, labelled by cause
(`stale-generation` / `still-live`), counts candidates resolved out of
the ledger without a DELETE. Deliberately not folded into
`db.gc.swept_total`: a drop frees no bytes, and a pass that reclaimed
nothing must not read as productive. A sustained `still-live` rate means
the mark phase is misjudging liveness.

**On upgrade.** No migration and no configuration change. The
`generation` field is additive and optional, so
`GC_PENDING_SCHEMA_VERSION` stays at 1 and a ledger written by an older
build remains valid; absent compares equal to absent, so a bucket whose
manifest carries no generation keeps reclaiming normally. Expect one
`stale-generation` drop spike on the first pass after upgrading — every
pre-upgrade candidate is dropped for want of a generation and re-marked
next pass, which delays reclamation of anything already pending by one
grace period — and one more per `baerly admin restore`. Both are
self-healing. Operators who alert on
`db.maintenance.unexpected_error_total` may see one fewer spurious
source of it.
