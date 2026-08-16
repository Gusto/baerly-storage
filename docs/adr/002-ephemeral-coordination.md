---
title: Ephemeral coordination
audience: adr
doc_type: adr
summary: ADR 002 — coordination runs in request-bounded compute, never a resident process; maintenance is in-band on the write path and reads are pure. The runtime model lives in sync-protocol.md + the operator-burden test; this record keeps the no-daemon doctrine and the rejected coordinator/cron/lease/read-triggered-maintenance paths.
last-reviewed: 2026-08-04
tags: [decision, adr, runtime-model]
related:
  [
    README.md,
    "../about/thesis.md",
    "../spec/sync-protocol.md",
    "../spec/storage-compatibility.md",
    "../contributing/conventions/change-discipline.md",
    004-single-write-commit.md,
  ]
---

# 002 — Ephemeral coordination

## Status

Accepted (2026-05-26). Coordination is request-bounded; maintenance is
in-band on the write path (reads are pure); under
[ADR-004](004-single-write-commit.md) commits are linearized by the
numbered `log/<seq>` create.

## Decision

Coordinate **exclusively** via the S3 ETag conditional-write contract
(`If-Match` / `If-None-Match`, `412` on conflict). There is no resident
process between requests: the kernel fits inside one Worker/Lambda
invocation and the only persistent component is the bucket. Idle apps
cost zero runtime; cold starts read correctly the same as warm ones.

Maintenance (compaction + GC) runs as **bounded, single-attempt slices
dispatched on the write path after a commit** — never on a schedule
required for correctness or default operation, never from a long-lived
process. **Reads are pure — they never tick.** The
unsliceable snapshot rebuild is bounded by a **static two-way ceiling**
(`snapshot_bytes ≤ C` **and**
`snapshot_rows + maxFoldEntriesPerPass <= E`); see the spec for the exact
formula. Tail slices drain across later write-ticks. An over-ceiling
snapshot rebuild defers until the collection shrinks, the profile changes,
or the workload graduates. The fold's pointer advance is a full-fence CAS;
a lost CAS abandons the fold and its orphan snapshot is GC-swept. **No
lease.**

**The runtime model lives in
[sync-protocol.md §Maintenance runtime model](../spec/sync-protocol.md#maintenance-runtime-model);
the doctrine and its admission test live in
[change-discipline.md §Operator-burden test](../contributing/conventions/change-discipline.md#operator-burden-test-for-new-mechanisms).**

### Backend prerequisites (firm)

CAS is a **hard, no-opt-out** requirement: the storage conformance suite
asserts it on every path and `baerly doctor --bucket` runs a live probe; a
backend that silently ignores `ifMatch` breaks the no-lease model. The
property needs **single-region** read-after-write strong consistency on
the control object — it holds on single-region S3 and on R2, but **not**
across an S3 Multi-Region Access Point or active-active cross-region
replication, where a replica's stale read lets two writers both believe
they won the CAS. Which backends qualify lives in
[storage-compatibility.md §Support tiers](../spec/storage-compatibility.md#support-tiers).

### Named safety invariant (the load-bearing property of the no-lease model)

> **GC sweep throughput ≥ orphan-production rate `p`** — so orphans drain
> and total object count stays bounded.

While it holds, lost folds produce orphans no faster than GC sweeps them.
Sustained above-envelope contention that violates it (object count grows)
is a **graduation signal, not silent breakage**.

## Closed paths

- **A resident coordinator / daemon.** Iceberg needs a catalog service,
  Delta-on-S3 a DynamoDB lock table, Hudi a metastore, SlateDB a
  long-lived writer + compactor. baerly-storage requires none — the
  portable `(Request) => Response` handler is the property the system is
  shaped around, not an accident.
- **Operator-installed cron** to "fix" ordinary compaction. Maintenance is
  already write-triggered and bounded; cron does not raise Cloudflare
  free's CPU or subrequest ceiling. (The opt-in `runScheduledMaintenance`
  SDK is a bonus, never a requirement.)
- **Adaptive AIMD fold-ratio control.** Cannot converge on Cloudflare,
  where a `waitUntil`-killed isolate never runs the code that would
  release the next CAS. Shipped a static ceiling instead.
- **A compaction lease.** Considered and deferred; duplicate-fold compute
  under contention is accepted and measured, not coordinated away.
- **Read-triggered snapshot publication ("banking").** A full-scan read
  already holds a complete materialized fold at a known `current.json`
  ETag, so reusing it to publish a snapshot and CAS the pointer looks
  nearly free. It is not. Pure reads are a ratified invariant
  ([sync-protocol.md §Protocol invariants](../spec/sync-protocol.md#protocol-invariants),
  #8), so this path must supersede that contract rather than build
  against it — and the invariant above is what makes it structurally
  wrong rather than merely unproved: orphan production would track
  **read** rate while reclamation stays write-ticked, so a read-heavy
  write-idle bucket pins sweep throughput at 0 while `p > 0`. That is
  the seed-then-idle orphan residual
  ([cost-model.md](../about/cost-model.md#maintenance-is-write-driven-reads-are-pure))
  without its bound, because reads recur and an import does not.
  Cleanup would also depend on a later write, so it is not resumable
  from bucket state; and the payoff inverts against the Cloudflare
  envelope, since banking is worth most exactly when the live tail is
  long — which is when the read alone sits closest to the 50-subrequest
  ceiling. Anti-precedent: Cassandra's `read_repair_chance`, removed in
  4.0 ([CASSANDRA-13910](https://issues.apache.org/jira/browse/CASSANDRA-13910)).
- **The log-retention sequence window as a paused-writer fence.** Withdrawn.
  `LOG_RETENTION_SEQ_WINDOW` was recorded as the reason a stale writer cannot
  commit into a certified-deleted slot: the floor would have to advance by more
  than the window "during one in-flight commit". The arithmetic holds and the
  quantifier does not — one in-flight commit bounds no wall-clock and no commit
  count, so a delayed create PUT, an isolate suspension, or the writer's own
  transient-retry loop can each straddle an unbounded number of peer commits and
  folds. It is a rate x duration assumption in sequences, the same class as
  `GC_GRACE_PERIOD_MILLIS` in seconds. The window survives as a pre-image cost
  margin and a retirement rate limit, with no safety property attached.
- **Post-create manifest revalidation with discard-and-re-probe.** Insufficient,
  and for a stronger reason than the per-commit GET cost. Re-reading
  `current.json` after the create detects that the commit landed below the floor,
  but discarding and re-probing cannot distinguish "my create landed and was
  folded" from "a foreign create landed and was folded": the fold keeps no writer
  identity (`SnapshotBody.docs` is `{_id, body}`), tombstones are purged,
  `current.json` holds no per-writer completion state, and `writer_fence` is not
  a replay filter (invariant 11). The two histories leave byte-identical durable
  state and demand opposite outcomes, so re-probing silently re-applies a folded
  mutation — clobbering a concurrent newer value, minting a second `lsn` for one
  logical mutation, and emitting it twice on `/v1/since`. What ships
  instead is an explicit failure keyed on the certified delete floor: a winning
  create at `seq < min(log_delete_floor, log_seq_start)` throws
  `BaerlyError{code:"AmbiguousCommit"}`. That makes the write contract
  at-least-once under this fault, which is a stated contract rather than a silent
  wrong answer. A pre-create re-read closes neither schedule — a GET cannot
  constrain a later PUT to a different key, and the lost-ack arm must not re-read
  at all without breaking own-session adoption.

## What would break the property

Any feature that requires (a) holding a connection open beyond one bounded
invocation, (b) persisting writer state across commits in process memory,
or (c) relying on between-request memoization for correctness. A "watch
this collection" socket breaks (a); a write-batching coordinator breaks
(b); a read-cache that returns stale rows without re-validating an ETag
breaks (c). The test is whether *removing the in-memory state* breaks
correctness — if it does, the feature violates this ADR and must be
redesigned to stay inside the request boundary. Platform HTTP caches and
ETag-revalidating in-isolate caches compose fine.
