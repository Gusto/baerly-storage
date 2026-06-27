---
title: Ephemeral coordination
audience: adr
summary: ADR 004 — coordination runs in request-bounded compute, not in a persistent process.
last-reviewed: 2026-06-22
tags: [decision, adr, runtime-model]
related:
  [
    README.md,
    "../about/thesis.md",
    "../spec/sync-protocol.md",
    001-tenant-cas-isolation.md,
    002-api-surface-lock.md,
  ]
---

# 004 — Ephemeral coordination

## Status

Accepted (2026-05-26). Amended (2026-05-31): in-band write-tick
maintenance landed (see Decision §3 + the In-band maintenance
subsection). Amended by [ADR-008](008-single-write-commit.md): commits
are now linearized by the numbered `log/<seq>` create; `current.json`
is compaction state, and the embedded writer fence is dormant.

## Context

Most multi-writer databases ship a persistent coordinator. Apache
Iceberg requires a catalog service. Delta Lake on S3 requires a
DynamoDB lock table. Apache Hudi requires HMS or an equivalent
metastore. SlateDB ships a long-lived writer and a long-lived
compactor. turbopuffer runs a query+indexer fleet. Convex,
PlanetScale, Turso, and Neon each ship at minimum a Pageserver
or equivalent always-on process. The default assumption in the
multi-writer-on-object-storage design space is that coordination
needs a daemon.

baerly-storage does not. The kernel is sized to fit inside a single
Cloudflare Worker invocation (50-subrequest budget,
~30-second wall-clock) or a single Lambda invocation, with no
process kept alive between requests. The deploy posture follows:
the only persistent component is the bucket. Idle apps cost zero
runtime; cold starts read correctly the same as warm ones.

[ADR-001](001-tenant-cas-isolation.md) already records the
downstream consequence: "A true server-vended lease with peer
revocation would require a coordination service or sticky
routing; the portable `(Request) => Response` server contract
rules both out." This ADR makes the upstream principle
load-bearing: the portable handler contract isn't an
implementation accident; it's the property the rest of the
system is shaped around.

## Decision

Coordinate exclusively via the S3 ETag conditional-write contract
(`If-Match` / `If-None-Match`, 412 on conflict) that S3-compatible
object stores expose. Our implementation of that contract is proven
credential-free against MinIO and Cloudflare R2 — the CAS conformance
blocks are a hard, no-opt-out prerequisite
([`conformance.ts`](../../packages/protocol/src/storage/conformance.ts)) —
and against AWS S3 on demand (`pnpm test:conformance`). Not every store
that speaks the S3 wire protocol honours these headers on _writes_: GCS's
S3-interop endpoint documents `If-Match`/`If-None-Match` as read-only and
routes conditional writes through its native `x-goog-if-generation-match`,
so GCS is **not** supported via the S3-compat path until a native
generation-precondition adapter lands or a live run proves the interop
layer enforces them. Azure Blob exposes the same ETag CAS semantics but
speaks a non-S3 REST dialect (no S3 endpoint), so it needs a dedicated
adapter that does not exist. `baerly doctor --bucket` runs a live CAS
probe and rejects any backend that doesn't reject stale or colliding
conditional writes. Cloudflare deploy can run the same probe with
`--probe-bucket=<uri>`; Node/self-host deploys run it manually. The
current mechanisms are:

1. **Single-write log commit with exactly-one-winner creates.**
   The winning `If-None-Match: "*"` create on `log/<seq>` is the
   single linearization point. A writer that receives `412` reads the
   occupant back: if it is the writer's own session/seq, it adopts the
   lost-ack commit; if it is foreign, the writer discovers the next
   empty slot and tries there. The adoption decision is gated on a
   per-commit random session id that no adversary with bucket-write
   access can forge (see
   [`packages/server/src/log-conflict-adoption.ts`](../../packages/server/src/log-conflict-adoption.ts)
   and `tryAdoptOwnSessionLogEntry`).
2. **Compactor-owned `current.json` CAS.** The commit path no
   longer CAS-advances `current.json`. That object is compaction state:
   snapshot pointer, `log_seq_start`, counters, and a
   non-authoritative `tail_hint`. The compactor and explicit
   operator/import paths still use `If-Match` CAS on it, so snapshot
   state moves atomically without a persistent coordinator. The old
   two-phase `writer_fence` metadata is retained but dormant under
   ADR-008; no production commit path claims or verifies it.
3. **In-band, write-triggered maintenance.** Compaction and GC
   run as bounded, single-attempt slices dispatched on the
   **write path** after a successful commit — never on a
   schedule, never from a long-lived process. The writer reads a
   per-request `MaintenanceDispatch` off the observability
   context (`getCurrentContext()?.maintenance`) at its post-commit
   point and calls `runBoundedMaintenance`
   ([`packages/server/src/maintenance.ts`](../../packages/server/src/maintenance.ts)).
   **Reads are pure** — they never tick. The slice is sized to
   the most-constrained tier (Cloudflare free) by default;
   larger backlogs drain across many write-ticks, not spilled
   into a daemon. See the **In-band maintenance** decision below
   for the full shape.

### In-band maintenance (write-tick, reads pure)

The third mechanism above is the one this revision lands. Its
shape:

- **Write-path-only, reads pure.** Maintenance dispatches from
  the writer's post-commit dispatch point. A read never triggers
  maintenance — the idle-reader cost bound (cost-model.md) holds
  because a read does zero maintenance work.
- **GC is the existing two-phase `runGc`.** `runGc`
  ([`packages/server/src/gc.ts`](../../packages/server/src/gc.ts))
  marks orphans into `gc/pending.json`, then sweeps them past a
  grace window — unchanged. It runs on its **own batch-safe
  boundary cadence** (`WRITE_TICK_GC_INTERVAL`,
  boundary-crossing not modulo, so a `tail_hint` advance can't
  step clean over it), **decoupled from folds**, capped per tier
  (`WRITE_TICK_GC_MAX_MARKS` / `..._SWEEPS`), and it runs on
  **deferring buckets too** (a bucket whose snapshot is over the
  ceiling still GCs). No new delta-index in v1.
- **Compaction = sliced tail + unsliceable rebuild.** The fold
  processes at most `maxFoldEntriesPerPass` (default
  `WRITE_TICK_FOLD_ENTRIES_PER_PASS`, per-tier; the runner threads it into
  `compact()` as its `maxEntriesPerRun` parameter) log entries per pass — a large tail **drains
  incrementally over write-ticks** and fits the subrequest
  budget. The one part that cannot be sliced is the snapshot
  rebuild, bounded by a **static two-way ceiling**:
  `snapshot_bytes <= C` (`MAINTENANCE_MAX_FOLD_BYTES_DEFAULT`,
  adapter/env-overridable) **AND**
  `snapshot_rows + maxFoldEntriesPerPass <= E`
  (`E = MAINTENANCE_MAX_FOLD_ROWS`, the per-entry-CPU axis a byte
  ceiling misses). Over either, the fold **defers**.
- **Full-fence CAS; a lost fold is abandoned.** The fold's
  pointer advance is a conditional write. A lost CAS (another
  writer raced) abandons the fold; its orphan snapshot is marked
  and swept by `runGc` past the grace window. **No lease.**
- **`TARGET_RATIO = 1.0` is the read-amp knob.** It sets fold
  frequency / read-amp only — it no longer enters the snapshot
  ceiling (`S_max = C`). Adaptive AIMD ratio control was
  **rejected**: it cannot converge on Cloudflare, where a
  `waitUntil`-killed isolate never runs the code that would
  release the next CAS — **deferred**.
- **No lease — folds are coordination-free-safe under the
  full-fence CAS.** This is the Iceberg / Delta Lake
  optimistic-compaction precedent: a compactor writes
  speculatively and the atomic pointer swap arbitrates; a loser
  discards its work. (Bailis-style OCC is a _supporting_ analogy,
  not load-bearing.) A lease was considered and **deferred**;
  duplicate-fold compute under contention is accepted and
  measured by `db.compaction.cas_lost_total`.
- **Dispatch by freeze-after-response capability.** Cloudflare
  relocates the fold past the response via `ctx.waitUntil`;
  everywhere else it runs **inline** (`dispatchInlineAwaited`).
  The kernel default is the CF-free-safe shape — **one phase per
  tick** on subrequest-capped hosts (`phasesPerTick: "single"`);
  the adapter threads the per-tier budget (Node runs
  `phasesPerTick: "both"` with the moderate, latency-budgeted
  `NODE_MAINTENANCE_*` caps).

**Named safety invariant (the load-bearing property of the
no-lease model):**

> **GC sweep throughput
> (`WRITE_TICK_GC_MAX_SWEEPS / WRITE_TICK_GC_INTERVAL`) ≥
> orphan-production rate `p`** — so orphans drain and total
> object count stays bounded.

While that holds, the no-lease model is stable: lost folds
produce orphans no faster than GC sweeps them. Sustained
above-envelope contention that violates the invariant (object
count grows) is a **graduation signal, not silent breakage** —
it means write contention has outgrown the prototype tier. The
**4.6 rotation cursor** is part of how the drain reaches the
whole keyspace: `runGc`'s orphan-content LIST persists a
`content_scan_cursor` in `gc/pending.json` and resumes
`startAfter` the prior pass's last examined key, so a
subrequest-bounded CF-free GC walks the entire hash-named
`content/` keyspace across passes instead of stranding orphan
content past the first window.

**Owning the novelty (honesty, not full precedent).** No
surveyed system achieves _automatic, bounded_ maintenance on
_untrusted, killable ephemeral compute_ with _zero privileged
scheduler_. Databricks Predictive Optimization hides a
privileged scheduler; PostgreSQL autovacuum and RocksDB
compaction are long-lived self-metering processes. The
inline-write-tick-on-a-killable-isolate combination is genuinely
novel and **unproven by precedent** — so the empirical gates do
the work precedent can't: the crash-injection fuzz (Task 4.5,
`maintenance-crash-fuzz.test.ts`) and `db.compaction.cas_lost_total`
are the validation strategy of record.

Deriving citations (supporting, not load-bearing): PostgreSQL
HOT pruning (bounded on-request maintenance under a CPU budget);
Iceberg / Delta optimistic compaction + grace-windowed cleanup;
SQLite incremental-vacuum page budget (a per-pass slice);
VLDB 2021 Sarkar (per-entry parse/merge cost scales with row
count, motivating the `E` row ceiling); `GOMEMLIMIT` /
PostgreSQL `maintenance_work_mem` operator overrides (the
`BAERLY_MAINTENANCE_*` precedent); Bailis OCC.

### §8.1 — Revisit the v1 hard-reject

The v1 design **hard-rejects** several mechanisms (adaptive AIMD
ratio control, a compaction lease, a delta-index for GC, chunked
snapshots). Revisit this list **before the first non-scratch
bucket** — the rejections are sized for prototype-tier scratch
workloads and a real workload may move the trade-off. They are
deferrals, not permanent bans.

### Backend-CAS prerequisite

The no-lease model leans on the backend honouring `ifMatch`
conditional writes — the full-fence CAS is what makes "abandon a
lost fold" safe. A `Storage` backend that silently ignores
`ifMatch` would break the property. This is now enforced rather than
assumed: the storage conformance suite asserts CAS semantics with **no
`supportsCAS` opt-out** on every conformance path, and `baerly doctor
--bucket <uri>` runs a live CAS round-trip (`probeCas`) that fails loud
against a non-conformant store. Cloudflare deploy can make that probe
an opt-in preflight with `--probe-bucket=<uri>`; self-hosted Node
deploys run it manually. CAS is a documented hard backend requirement (see
[sync-protocol.md](../spec/sync-protocol.md) §"Protocol invariants").

### Operator implications

This decision has concrete runbook consequences:

- Run `baerly doctor --bucket` before deploy; a bucket that does not
  enforce conditional writes is not a baerly-storage backend.
- Do not add cron to "fix" ordinary compaction. Maintenance is already
  write-triggered and bounded; cron does not raise Cloudflare free's CPU
  or subrequest ceiling.
- Watch `db.compaction.deferred_total`,
  `db.compaction.cas_lost_total`, and object-count growth. These are
  envelope signals, not silent corruption.
- Raise `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` only on paid Cloudflare or
  Node hosts that can fold the snapshot in memory. Otherwise follow the
  graduation path in [graduation.md](../about/graduation.md).

## Consequences

**Positive.** No on-call surface — there is no process for an
operator to babysit. The in-band design **satisfies the
zero-operator-infrastructure doctrine**: maintenance needs no
cron, no `setInterval`, no scheduler, no app-config knob — it
rides the write path the app already issues. Idle apps cost zero runtime; only the
bucket's storage line item accrues. The kernel is portable
across any FaaS runtime that ships a fetch-shaped handler
(Workers, Lambda, Bun, Deno, Fly) — maintenance rides the write
request, so a cron trigger is **not** required (the opt-in
`runScheduledMaintenance` SDK can still use one). Cold starts read
correctly the same as warm ones, so isolate recycling and
scale-to-zero are free. The thesis's "Idle → zero" criterion
falls out of this property; the small public API
([ADR-002](002-api-surface-lock.md)) is possible because there
is no coordinator state to expose. Graduation is mechanical: with no
stateful coordinator to migrate away from, the bucket plus the log shape
are the entire handoff to Postgres (`baerly export --target=postgres`).

**Negative.**

1. **Host-dependent envelope.** The maintenance ceiling is
   `S_max = C` on the snapshot axis, two-way (bytes **and**
   rows). On Cloudflare free there are **two binding walls** —
   ~10 ms CPU (defended by `C`/`E`) and 50 subrequests/request
   (defended by the tail slice) — so the same collection folds
   differently on different tiers.
2. **Incremental-drain write-amplification + catch-up.** Slicing
   the tail means a long backlog drains over many write-ticks,
   adding write-amp while it drains, and a bucket resuming after
   a quiet period pays a one-time catch-up as the tail folds down.
3. **Over-ceiling reads grow unbounded until graduation.** A
   bucket whose snapshot exceeds `C`/`E` defers its rebuild
   forever; its tail keeps growing and read amplification climbs
   until the operator graduates. Surfaced by
   `db.compaction.deferred_total` and the rate-limited
   graduation `console.warn`.
4. **Occasional duplicate-fold compute under contention.** With
   no lease, two writers can both fold the same tail; the CAS
   loser's work is discarded. Accepted; measured by
   `db.compaction.cas_lost_total`.
5. **No fairness.** Lock-free CAS gives no queueing or fairness
   guarantee: under sustained contention a slow writer can lose
   every race and exhaust its retry budget, surfacing as a
   `Conflict` at the app edge. This is bounded liveness loss,
   never data loss — the app retries or backs off. A fair queue
   would require exactly the external coordinator this ADR exists
   to avoid.

Independent of maintenance: readers may see a stale
`current.json` until the in-isolate cache invalidates; the
`consistency: "strong"` opt-in trades a round-trip for freshness
when needed. WebSocket connections cannot be held beyond a single
bounded invocation, so realtime is delivered via the
`/v1/since?collection=<name>&cursor=<opaque>` long-poll route inside
the platform's request-time budget rather than a held fanout socket.

## What would break the property

Any future feature that requires (a) holding a connection open
beyond a single bounded invocation, (b) persisting writer state
across commits in process memory, or (c) relying on
between-request memoization for correctness. Each of these is
grounds to reject the feature or to redesign it so the kernel
stays inside the request boundary. A "watch this collection"
API that holds a socket across requests breaks (a). A
write-batching coordinator that buffers across commits breaks
(b). A read-cache that returns stale rows past the
`current.json` ETag without re-validating breaks (c).

Features that compose with the property are still admissible:
platform-provided HTTP cache (CF Cache API), in-isolate caches
that re-validate against an ETag, and write-tick-paced
maintenance all preserve the property. The test is whether
_removing the in-memory state_ breaks correctness. If it does,
the feature violates this ADR.

**Backing-store consistency.** The CAS property requires
read-after-write strong consistency on the control object. It
holds on single-region S3 and on R2 (globally strongly
consistent). It does **not** hold across an S3 Multi-Region
Access Point or active-active cross-region replication, where a
replica's stale read can let two writers both believe they won
the CAS. Run baerly against a single-region bucket (or R2); do
not point it at an MRAP / cross-region-replication endpoint.
