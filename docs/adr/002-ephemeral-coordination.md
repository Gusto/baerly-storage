---
title: Ephemeral coordination
audience: adr
doc_type: adr
summary: ADR 002 — coordination runs in request-bounded compute, never a resident process; maintenance is in-band on the write path and reads are pure. The runtime model lives in sync-protocol.md + the operator-burden test; this record keeps the no-daemon doctrine and the rejected coordinator/cron/lease paths.
last-reviewed: 2026-06-28
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
dispatched on the write path after a commit** — never on a schedule,
never from a long-lived process. **Reads are pure — they never tick.** The
unsliceable snapshot rebuild is bounded by a **static two-way ceiling**
(`snapshot_bytes ≤ C` **and** `snapshot_rows ≤ E`); over either, the fold
defers and drains across later write-ticks. The fold's pointer advance is
a full-fence CAS; a lost CAS abandons the fold and its orphan snapshot is
GC-swept. **No lease.**

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
