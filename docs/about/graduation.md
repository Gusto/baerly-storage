---
title: Graduation thresholds
audience: operator
summary: The CPU and memory bounds that tell you when a collection has outgrown its deployment tier, and what to do about it.
last-reviewed: 2026-08-08
tags: [operations, cost, capacity, graduation]
related: [cost-model.md, workload-fit.md, thesis.md, "../adr/002-ephemeral-coordination.md"]
---

# Graduation thresholds

baerly-storage is built for production apps that live within a defined
workload envelope: internal tools, admin panels, dashboards, and
low-to-moderate-traffic line-of-business apps, up to roughly
~30 writes/min/collection, ~10 GB/tenant stored, and ~100
collections/tenant. Graduation is what you do when a collection or
workload crosses one of those documented bounds — a scale event, not a
maturity one.

The threshold concept is **the fold**: the moment maintenance turns many
small committed writes into one refreshed snapshot. That makes reads
cheap again, but the snapshot rebuild still has to fit in one host turn.
The tail is the newer log entries not yet in that snapshot.
baerly-storage slices the tail, but it still rebuilds the whole snapshot
in one pass. Graduation starts when that rebuild no longer fits the
host's CPU, subrequest, or memory budget.

Watch `snapshot_bytes` and `snapshot_rows`. `baerly inspect` reports
them, and they also live on `current.json`. When write-tick maintenance
defers because either ceiling trips, it bumps
`db.compaction.deferred_total` and may emit a rate-limited
`console.warn` naming the dimension.

For the **cost** side of graduation, see
[cost-model.md](cost-model.md). The cost signals are separate:

- **Advisory:** sustained ~100 writes/min account-wide
  (provider-agnostic; 8.64M Class A/mo / ~$34/mo object-storage ops on
  R2, 12.96M / ~$65/mo on S3), surfaced by `baerly cost`.
- **Hard cost trigger:** 50M Class A/mo, sustained over 7 days
  (~580 writes/min and ~$221/mo object-storage ops on R2; ~390
  writes/min on Node).

Those write rates are **account-wide aggregate** rates because Class A
is billed per account. They are distinct from the per-collection
~30 writes/min contention ceiling in
[the workload envelope](#4-off-baerly-storage--postgres-the-workload-envelope).

## Decision table

Start with these read-only checks:

```sh
baerly inspect \
  --bucket=s3://<bucket> \
  --app=<app> \
  --tenant=<tenant> \
  --collection=<collection>

baerly admin usage \
  --target=node \
  --bucket=s3://<bucket> \
  --app=<app> \
  --tenant=<tenant>
```

| Symptom | Check | Threshold | Action |
| --- | --- | --- | --- |
| `db.compaction.deferred_total` or defer `console.warn` on Cloudflare free | Warning names bytes vs. rows; `baerly inspect` reports `snapshot_bytes` / `snapshot_rows` | `snapshot_bytes > C` or `snapshot_rows + maxFoldEntriesPerPass > E` (cf-free: `C = 512 KB`, `E = 2048`) | If bytes tripped, upgrade to Workers Paid and set `BAERLY_MAINTENANCE_PROFILE=cf-paid`, which moves `C` to 8 MiB; raise `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` past that only to a cap the isolate can rebuild. If rows tripped, the same profile switch moves `E` to 32,768. `E` has no env override, but it is per host profile, so moving to a larger profile raises it. |
| Same defer on Node | Warning text plus `snapshot_bytes` / `snapshot_rows` from `baerly inspect` | Node ships `C = 32 MiB`, `E = 65,536`; check the host has RAM for old snapshot + new snapshot + tail | If bytes tripped, raise `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` above 32 MiB, sized by `C ≈ heap / 10`; expect one inline write-latency spike. If rows tripped, Node already has the largest shipped `E` and there is no env override — split or graduate the collection. |
| Object count grows while writes are steady | Logs + `admin fsck` | GC sweep throughput no longer keeps up with orphan production | Reduce contention, split the hot collection, or graduate the workload. |
| Sustained hot collection | `admin usage` | ~30 logical writes/min/collection | Graduate to D1/Postgres; this is the workload ceiling. |
| Tenant data keeps growing | `admin usage` / bucket inventory | >10 GB/tenant (R2 free-tier storage line; see [cost-model.md](cost-model.md)) or ~100 collections/tenant (soft fan-out guideline; see [workload-fit.md](workload-fit.md#scale-at-a-glance)) | Review graduation cost; neither line is enforced by the protocol. |
| `baerly cost` prints advisory note | `baerly cost` | ~100 writes/min account-wide (provider-agnostic; 8.64M Class A/mo / ~$34/mo R2 object-storage ops, 12.96M / ~$65/mo S3), advisory only; see [cost-model.md](cost-model.md#ops-vs-cost-tradeoff) | Compare object storage's low operator burden against a managed DB. Hard trigger: 50M/mo (~580 writes/min / ~$221/mo R2; ~390 writes/min on Node). |

### How to read the output

`baerly inspect` reports the current snapshot key, `live_log_tail`,
`materialised_rows`, `snapshot_bytes`, and `snapshot_rows`.
`baerly admin usage` reports writes/min against the M-size ceiling: the
~30 writes/min/collection workload line.

For compaction, compare the **snapshot**, not the tail:

- `snapshot_bytes` against `C`;
- `snapshot_rows + maxFoldEntriesPerPass` against `E`; and
- `db.compaction.deferred_total` plus the rate-limited `console.warn`
  for the portable operator signal.

`C` and `E` are not one shared pair of numbers: each host profile ships
its own, sized to that host's measured wall. Look up the values for the
host you are on in [the per-tier table](#per-tier-bounds) before
comparing.

Some metric sinks preserve the byte-vs-row label on
`db.compaction.deferred_total`; the warning text always names it. A
large tail alone is not a graduation signal because it drains in slices.
Compare the snapshot against
[the auto-maintained ceiling](#the-auto-maintained-snapshot-ceiling)
and [the per-tier table](#per-tier-bounds).

### What is shipped vs. estimated

**Shipped:** write-triggered folding, a per-profile `C`/`E` pair
(cf-free `MAINTENANCE_MAX_FOLD_BYTES_DEFAULT` / `MAINTENANCE_MAX_FOLD_ROWS`,
cf-paid `CF_PAID_MAINTENANCE_MAX_FOLD_BYTES` /
`CF_PAID_MAINTENANCE_MAX_FOLD_ROWS`, node
`NODE_MAINTENANCE_MAX_FOLD_BYTES` / `NODE_MAINTENANCE_MAX_FOLD_ROWS`),
`MAINTENANCE_TARGET_RATIO`, `S_max`, the `BAERLY_MAINTENANCE_*` env
vars, and the defer/warn signals. These are defined in code and
dispatched on the write path by
[`runBoundedMaintenance`](../../packages/server/src/maintenance.ts).

**Measured:** the per-host ceilings are no longer chosen. They come from
`pnpm bench:fold-ceiling`
([`bench/measurement/fold-ceiling-probe.ts`](../../bench/measurement/fold-ceiling-probe.ts)),
run unconstrained and at `--max-old-space-size` 512/1024/2048 (actual
`heap_size_limit` 704/1216/2240 MB). Two results hold across that whole
range and are what fix `C` and `E`:

- peak heap is **~2.4x the snapshot** on the byte axis, and
- peak heap costs **~600 B per row** on the row axis.

Both are invariant to heap size (verified 704 MB - 4.3 GB), so the
memory-bound verdicts behind cf-paid's 8 MiB / 32,768 and node's
32 MiB / 65,536 are portable.

Those two constants and one rule fix every memory-bound ceiling: **a
fold is sized to occupy at most a quarter of the memory budget**, so
`peak heap × 4 ≤ budget`. At ~2.4x that works out to `C ≈ budget / 10`,
which is where node's `C ≈ heap / 10` comes from, and why cf-paid stops
at 8 MiB — 8 MiB peaks at ~19.5 MB and 19.5 × 4 = 78 MB fits under the
~128 MB Worker limit, while the next grid cell (16 MiB ⇒ 37.3 MB ⇒
149 MB) does not. Where a per-tier cell below cites "the 4x margin",
this is the rule it means.

cf-free is the exception, because its wall is CPU rather than memory:
2048 rows measures ~1.5 ms and the row axis does not reach ~10 ms until
~16,384 rows, but that margin was measured off workerd and so does not
transfer. The value stays deliberately far inside it, because a
free-isolate overrun is CPU-killed mid-rebuild and strands the
`current.json` CAS.

**Still estimated:** the CPU column below and anything derived from it.
CPU was measured on Node v24 / darwin-arm64, which is not workerd, and
the bench host ran 1.05-1.30x slower than the host behind the frozen
June baseline — the probe itself reports CPU-bound verdicts as
non-portable. Also estimated: the `≈ 11 ms/MB` upper-bound model, the
graduation snapshot sizes in documents (they assume 1-5 KB/doc), and
node's 32 MiB, which is the top of the measured grid rather than a
measured wall.

## What costs CPU: compaction

Ordinary reads and writes do a small, bounded number of storage calls
while a collection stays inside the maintained envelope. The operation
that grows with collection size is compaction: rebuilding the snapshot.

A fold (`compact` in
[`packages/server/src/compactor.ts`](../../packages/server/src/compactor.ts))
does this work:

1. Read `current.json`.
2. Load the previous snapshot with `loadSnapshotAsMap`.
3. Fetch the bounded log slice with `walkLogRangeWithBytes`.
4. Apply entries in memory: `I`/`U` overwrite, `D` tombstones.
5. Sort docs by `_id` for deterministic output.
6. Serialize the new snapshot with `encodeSnapshotBody`.
7. SHA-256 the snapshot bytes with `snapshotHash` to derive the
   filename.
8. PUT the snapshot and CAS-advance (conditional compare-and-swap)
   `current.json`.

The GETs and PUTs are I/O. They do not count against a Cloudflare
Worker's CPU budget. CPU is spent on the in-memory JSON parse, merge,
sort, stringify, and SHA-256 work.

Compaction is all-or-nothing. Snapshot filenames embed the SHA-256 of
their body, and the atomic moment is the single conditional PUT that
swaps `current.json.snapshot`. If a write is
interrupted before the body is complete, readers reject the hash
mismatch. If the snapshot body lands but the `current.json` CAS does
not, the snapshot is a correct but unreferenced orphan for GC. The
pointer does not advance, but data is not corrupted.

## Fold cost model

The fold has two costs, and only one is sliced:

- **The tail is sliced.** A fold processes at most
  `maxFoldEntriesPerPass` log entries per pass. The CF-free default is
  `WRITE_TICK_FOLD_ENTRIES_PER_PASS = 20`; Node and CF-paid profiles use
  the larger `NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS = 200`. The runner
  threads this into `compact()` as `maxEntriesPerRun`. A long tail drains
  over many write ticks.
- **The snapshot rebuild is unsliceable.** Each pass loads the old
  snapshot, applies the slice, reserializes the whole snapshot, and
  hashes the new bytes. This scales with `snapshot_bytes` and
  `snapshot_rows`. Rows matter because many tiny documents can spend much
  of their fold CPU on per-entry parse / merge / serialize work (roughly
  half of fold CPU in the model; VLDB 2021 Sarkar).

So the ceiling is on the snapshot, not on `snapshot + tail`:

> A fold defers when `snapshot_bytes > C` **or**
> `snapshot_rows + maxFoldEntriesPerPass > E`.

Using order-of-magnitude engine assumptions, JSON parse/stringify at
roughly 300 MB/s and SHA-256 at roughly 2 GB/s, snapshot rebuild cost is:

> **≈ 11 ms CPU per MB of snapshot rebuilt** — a deliberate *upper
> bound*, not a prediction. `C` was derived from it, and that derivation
> still stands.

Measurement has since overtaken it, and the model is pessimistic where
that is safe. A 1 MB rebuild measures 2.6-3.2 ms, so the model overstates
small folds by roughly 3x; at 5 MB (53.6-55.4 ms measured against 55 ms
modelled) it is about right. Cost is not linear across that range, so
"around 10 ms/MB" is not the shape: it is roughly **3.3 ms/MB below
4 MB**, rising to **~7-10 ms/MB above 5 MB**. Because `C` is a safety
ceiling, an upper bound that is 3x pessimistic at the small end errs the
right way. A 2-3x swing in the JSON assumption still moves the modelled
free-tier CPU ceiling between roughly 0.4 MB and 1.5 MB of snapshot, and
that is the arm measurement has *not* closed, because the numbers below
were not taken on workerd.

### Snapshot size → CPU per fold

Measured by `pnpm bench:fold-ceiling`
([`bench/measurement/fold-ceiling-probe.ts`](../../bench/measurement/fold-ceiling-probe.ts))
on the byte axis at 2048 B/doc; median CPU and peak heap over the two
clean runs (unconstrained 4288 MB heap, and 2240 MB).

> **The CPU column is not portable.** It was taken on Node v24 /
> darwin-arm64, not workerd, and that host ran 1.05-1.30x slower than
> the one behind the frozen June baseline. The probe reports
> memory-bound verdicts as portable and CPU-bound ones as not. Use the
> peak-heap column to reason about a host's wall; use CPU only for shape.

| Snapshot size | CPU per rebuild (bench host) | Peak heap | Peak / snapshot |
| --- | --- | --- | --- |
| 512 KB | 1.6-1.7 ms | 2.37 MB | 4.67x |
| 1 MB | 2.6-3.2 ms | 3.02 MB | 2.97x |
| 2 MB | 5.1 ms | 5.11 MB | 2.52x |
| 3 MB | 7.2-9.4 ms | 7.38 MB | 2.42x |
| 4 MB | 15.6 ms | 9.60 MB | 2.37x |
| 5 MB | 53.6-55.4 ms | 12.0 MB | 2.36x |
| 8 MB | 63.3-83.1 ms | 18.6-19.5 MB | 2.29-2.41x |
| 16 MB | 112-117 ms | 37.3 MB | 2.30x |
| 32 MB | 268-281 ms | (unusable — all samples lost to the GC floor) | — |

The knee sits between 4 MB and 5 MB. Below it a fold is single-digit
milliseconds on this host; above it per-MB cost roughly triples and then
settles. The peak/snapshot ratio converges to ~2.4x once the snapshot is
large enough to dominate fixed overhead, which is the number the
memory-bound ceilings are sized against.

A ~512 KB snapshot is roughly **100-500 documents** at 1-5 KB/doc, and
it is the smallest cell measured — at ~1.6 ms, anything smaller is
effectively free everywhere.

On the row axis (64 B/doc), where per-entry work rather than bytes
dominates:

| Snapshot rows | CPU per rebuild (bench host) | Peak heap |
| --- | --- | --- |
| 2,048 | 1.45-1.51 ms | 1.66 MB |
| 8,192 | 5.0-5.3 ms | 6.0 MB |
| 16,384 | 10.4-10.9 ms | 9.9 MB |
| 32,768 | 22.2-22.6 ms | 19.7 MB |
| 65,536 | 54.4-57.6 ms | 39.4 MB |

Peak heap per row is ~600 B and stable, which is what lets the row
ceilings be sized against a memory wall rather than a CPU one on the
hosts where memory is the wall.

The row ceiling catches tiny-doc snapshots that bytes can miss, and like
`C` it is now per host: `E = 2048` on cf-free
(`MAINTENANCE_MAX_FOLD_ROWS`), `32,768` on cf-paid, `65,536` on node.
cf-free stays at 2048 even though the row axis does not reach the ~10 ms
free budget until ~16,384 rows, because a free-isolate overrun is
CPU-killed mid-rebuild and strands the `current.json` CAS; the larger
hosts fail by running slow, not by stranding, so they are sized to
memory.

### When a fold fires, and when it defers

Write-triggered maintenance runs in-band on the write path. Reads are
pure and never trigger maintenance. For folding, three gates matter:

- **Size-ratio trigger (`R`).** Fold work starts when the derived
  live-tail estimate reaches
  `MAINTENANCE_TARGET_RATIO × snapshot_bytes` and the entry-count floor
  is met. The estimate is
  `(observedTail - log_seq_start) × mean_entry_bytes`, with a non-zero
  fallback before the first compactor-stamped mean exists. Default
  `MAINTENANCE_TARGET_RATIO = 1.0`, so the ratio arm starts when the
  estimated tail equals the snapshot.
- **Static byte ceiling (`C`).** Once dispatched, the rebuild defers if
  `snapshot_bytes > C`. `C` is per host profile: 512 KB on cf-free
  (`MAINTENANCE_MAX_FOLD_BYTES_DEFAULT`), 8 MiB on cf-paid, 32 MiB on
  node. Operators can raise it out-of-band with
  `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`; see
  [Operations plane](#operations-plane-env-vars).
- **Static row ceiling (`E`).** The rebuild also defers if
  `snapshot_rows + maxFoldEntriesPerPass > E`. `E` is likewise per host
  profile: 2048 on cf-free, 32,768 on cf-paid, 65,536 on node.

`C` is conservative *on cf-free* because there is no adaptive backoff for
a killed rebuild. Cloudflare free's ~10 ms CPU budget can rebuild roughly
a 1 MB snapshot; `C = 512 KB` leaves margin. On CF free, setting
`BAERLY_MAINTENANCE_MAX_FOLD_BYTES` above
`CF_FREE_MAX_SAFE_FOLD_BYTES = 1 MiB` emits an init-time
`console.warn`.

### The auto-maintained snapshot ceiling

Because the tail is sliced and the snapshot rebuild is the unsliced work:

> **`S_max = C`** (subject to
> `snapshot_rows + maxFoldEntriesPerPass <= E`).

`S_max` is therefore whatever `C` is on the host you are running, and
that differs per profile:

| Profile | `C` (`S_max`) | `E` | Documents at 1-5 KB/doc |
| --- | --- | --- | --- |
| cf-free | 512 KB | 2,048 | ~100-500 |
| cf-paid | 8 MiB | 32,768 | ~1,600-8,200 |
| node | 32 MiB | 65,536 | ~6,500-32,800 |

For documents that size, bytes bind first on every host — the row
ceiling is the backstop for snapshots made of many tiny documents, where
`E` trips while `snapshot_bytes` is still small.

Past `C` bytes or `E` rows, folds defer and the live log stops
collapsing into the snapshot. A byte defer can be cleared by raising
`BAERLY_MAINTENANCE_MAX_FOLD_BYTES` on a host that can rebuild the
snapshot. A row defer cannot be cleared that way — there is no env
override for `E` — but `E` is not one fixed number any more, so moving
to a larger host profile raises it: 2,048 → 32,768 → 65,536. On a paid
Worker that means setting `BAERLY_MAINTENANCE_PROFILE=cf-paid`, which is
what selects the paid ceilings; the Node adapter selects its profile
automatically. Once you are on node's `E = 65,536`, splitting or
graduating the collection is the remaining move.

The old estimate-based model divided the ceiling by `(1 + R)` because it
treated snapshot plus estimated tail as one unsliceable pass. With a
sliced tail, per-pass work is the snapshot rebuild alone: `S_max = C`,
and `R` is only the read-amplification / fold-frequency knob.

#### The read-amp / write-amp knob

| Quantity | Function of ratio `R` | At `R = 1.0` |
| --- | --- | --- |
| Compaction write-amplification | `≈ 1 + 1/R` | ~2x |
| Read-amplification between folds | `≤ 1 + R` | ≤ 2x |

A higher `R` lets the tail grow longer before a fold, reducing
compaction write-amplification and increasing read-amplification. Many
log-structured storage engines commonly let the next level grow to ~2x
the previous one; baerly-storage uses `R = 1.0` to halve
read-amplification while accepting ~2x compaction
write-amplification.

This compaction write-amplification is not the cost model's **effective
Class-A write-amplification** (~2x on the Cloudflare profile / ~3x on
the Node profile). The historic `effective write-amp > 6` graduation
trigger has been retired because the measured ~2-3x baseline makes it
unreachable through bounded maintenance. Stress peaks at ~3x; CAS
contention is still the route above that measured maintenance profile.
See
[cost-model.md](cost-model.md#alternative-dbs-at-m-size).

## Per-tier bounds

Read this table on the snapshot axis: `snapshot_bytes` against `C`, and
`snapshot_rows` against `E`. The sliced tail does not enter the per-pass
ceiling. Each profile ships its own `C`/`E`, sized to that host's
measured wall rather than inherited from cf-free, so the shipped ceiling
is already near the hardware wall on every tier; raising `C` further is
an override, not the normal path.

Cloudflare free has two binding walls:

- **CPU:** ~10 ms/request, defended by `C` and `E`.
- **Subrequests:** 50/request, defended by the
  `maxFoldEntriesPerPass ≈ 20` tail slice. A fold pass is about
  `slice + 3` subrequests, and GC is about `6 + marks + sweeps`; one
  phase per tick stays under 50.

| Tier | Hardware walls | Binds on | What can actually fold |
| --- | --- | --- | --- |
| **Cloudflare free** | ~10 ms CPU/request and 50 subrequests/request | CPU + subrequests | profile `C = 512 KB` ⇒ ~512 KB snapshot (`S_max = C`), `E = 2048` rows; tail drains ≈ 20 entries/tick; raising `C` past ~1 MB (`CF_FREE_MAX_SAFE_FOLD_BYTES`) hits the CPU wall and `console.warn`s |
| **Cloudflare paid** | 30 s CPU default (up to 5 min); ~128 MB Worker memory; 10,000 subrequests/request default, raisable to 10M, changed 2026-02-11; free wall stays 50 | memory | `C = 8 MiB` (`CF_PAID_MAINTENANCE_MAX_FOLD_BYTES`), `E = 32,768` rows (`CF_PAID_MAINTENANCE_MAX_FOLD_ROWS`), selected by `BAERLY_MAINTENANCE_PROFILE=cf-paid` — no `C` override needed to get there. CPU is not the wall; memory is: 8 MiB peaks at ~19.5 MB, which fits the 4x margin under ~128 MB; the next grid cell (16 MiB ⇒ 37.3 MB) does not. That margin is why the ceiling is not "tens of MB" |
| **Serverful Node** | no per-request cap; process RAM; a fold blocks the event loop | host memory | `C = 32 MiB` (`NODE_MAINTENANCE_MAX_FOLD_BYTES`), `E = 65,536` rows (`NODE_MAINTENANCE_MAX_FOLD_ROWS`), selected automatically by the Node adapter. 32 MiB is the top of the measured grid, **not** the measured wall — the probe reports `grid-exhausted` for this profile at every margin and every heap from 704 MB up. Past the grid, scale by `C ≈ heap / 10`. Per-pass caps are `NODE_MAINTENANCE_*` (moderate, latency-budgeted) |

Implications: on Cloudflare free, a ~1 MB snapshot is near the ~10 ms
CPU wall, and the 50-subrequest wall makes a large tail drain over many
write ticks. On Cloudflare paid, CPU could rebuild a multi-GB snapshot,
but Worker memory (~128 MB) is the wall because a fold holds the old
snapshot, new snapshot, and log tail at once — measured at ~2.4x the
snapshot in peak heap. On Node, process RAM and event-loop blocking
bind, and the shipped 32 MiB is a floor set by where the bench grid
stopped, not by where Node stops.

## Graduation triggers

A persistently deferring fold means different things on different hosts.
Disambiguate before you act.

### The symptom: erosion, not a cliff

When a collection persistently defers its fold, data is not lost. The
symptoms are:

- **Reads get gradually slower.** Each read replays an ever-growing log
  tail on top of the stale snapshot: N extra GETs, with N climbing by
  one for every write since the last successful fold.
- **The bucket grows.** Unfolded log entries accumulate as objects and
  bytes because the fold that would collapse them never completes.
- **A warning appears.** `wrangler tail`, Vercel logs, or Node logs show
  a `console.warn` naming the collection and the byte-vs-row dimension.
  It is rate-limited by `current.json.last_warned_seq`, roughly once per
  `MAINTENANCE_WARN_INTERVAL_WRITES = 1000` writes. The defer path also
  bumps `db.compaction.deferred_total`.

### The drain-rate safety invariant

The no-lease model stays bounded only while GC sweep throughput keeps up
with orphan production:

> **`WRITE_TICK_GC_MAX_SWEEPS / WRITE_TICK_GC_INTERVAL` (= 10/4) ≥
> orphan-production rate `p`.**

While that holds, orphans drain and total object count stays bounded.

Two things upstream of the sweep can bind before sweep throughput does,
and neither is fixed by raising the sweep rate:

- **Mark coverage.** Every budgeted mark phase whose LIST window can
  stall on undeletable keys carries a persisted rotation cursor in
  `gc/pending.json` (`content_scan_cursor`, `log_scan_cursor`). The
  content cursor remains for legacy content side-objects; new writes
  inline their post-images in the log. Without a cursor, a compatibility
  phase can starve and the candidate never enters the ledger for the
  sweep budget to spend itself on.
- **Ledger depth.** `GC_MAX_PENDING_CANDIDATES` bounds how many
  candidates are in flight at once, across all three reasons together,
  and each cohort waits out `GC_GRACE_PERIOD_MILLIS` before it can be
  swept. On a large accumulated backlog that ceiling — not the sweep
  budget — is what paces reclamation.

Above-envelope write contention can make writers lose `log/<seq>.json`
create races and maintenance lose `current.json` CAS often enough to
produce orphans faster than GC sweeps them. Object count growth is the
signal; the protocol does not silently lose data.

### Which graduation?

Map the signal before acting:

- **Cloudflare free byte defer:** upgrade tier and set
  `BAERLY_MAINTENANCE_PROFILE=cf-paid`, which moves `C` to 8 MiB. Only
  override `C` beyond that if you have sized it to memory.
- **Node byte defer:** raise `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` above
  the 32 MiB node default, sized by `C ≈ heap / 10`.
- **Row defer:** `E` has no env override, but it is per host profile —
  move to a larger profile (2,048 → 32,768 → 65,536) to raise it. At
  node's 65,536, split or graduate.
- **Hot collection or tenant-scale signal:** graduate the workload to
  D1/Postgres.

A deferred fold alone does not mean "move to Postgres."

> **Cron does not help Cloudflare free.** Maintenance ticks on the write
> path. The opt-in `runScheduledMaintenance` SDK is useful for explicit
> maintenance windows, but a scheduled Worker has the same ~10 ms CPU
> limit as a request handler. A fresh budget per tick is not a larger
> budget. The levers are Workers Paid, a Node host, or a smaller cap.

### 1. Off Cloudflare free → Cloudflare paid

**Threshold:** the auto-maintained snapshot ceiling at the cf-free
values: ~512 KB snapshot / ~100-500 docs, or `E = 2048` rows, whichever
trips first —
`snapshot_bytes > C` or `snapshot_rows + maxFoldEntriesPerPass > E`.

**What you'll observe:** slower reads, a growing bucket, and a
`console.warn` naming bytes vs. rows.

**What to do:** upgrade to Cloudflare Workers Paid (about $5/mo; 30 s
CPU vs. free's ~10 ms), then set `BAERLY_MAINTENANCE_PROFILE=cf-paid`.
That alone moves `C` to 8 MiB and `E` to 32,768 and compaction resumes;
there is no env override to set for the common case. On paid, CPU stops
being the practical wall and Worker memory (~128 MB) becomes the limit,
which is what fixes 8 MiB rather than "tens of MB": peak heap runs
~2.4x the snapshot, so 8 MiB peaks at ~19.5 MB and the next step up
(16 MiB ⇒ 37.3 MB) overruns the 4x margin. If you override `C` past the
profile value, size it to memory, not CPU; see
[Operations plane](#operations-plane-env-vars).

### 2. On serverful Node: raise the env var

When the warning names bytes, this is not a tier graduation. A Node host
has no per-request CPU wall; the ceiling is host RAM, and the node
profile already ships `C = 32 MiB` — the top of the measured grid, not
a measured wall, so a host with headroom can go further. Raise
`BAERLY_MAINTENANCE_MAX_FOLD_BYTES`, scaling by `C ≈ heap / 10` (peak
heap ≈ 2.4x snapshot, keeping a 4x margin); the fold completes on the
next write, with one inline write-latency spike. If the warning names
rows, the env var will not help: `E` has no override, and node already
runs the largest shipped value (65,536).

### 3. Paid serverless → serverful Node

**Threshold:** a snapshot approaches the cf-paid ceiling — **8 MiB** of
snapshot, or 32,768 rows.

**What you'll observe:** on paid Cloudflare, folds start running into
the ~128 MB Worker memory limit. The fold cannot hold the old snapshot,
new snapshot, and log tail resident at once. CPU is still fine.

**What to do:** move the collection to a long-lived Node host, which
selects the node profile automatically (`C = 32 MiB`, `E = 65,536`),
then raise the env cap as above if the host has the heap for it, or wait
for chunked snapshots. The current
snapshot format is single-level (one L9 snapshot replaces the prior) and
is forward-compatible with a future multi-level L0..L9 scheme that folds
incrementally without a wire change.

### Tail churn is not a graduation signal

A small, heavily updated collection, such as 50 docs receiving constant
updates, can build a large tail that collapses to a handful of `_id`s.
Under the prior unsliceable-fold model, that large tail could trip the
ceiling. It no longer does.

The tail is sliced by `maxFoldEntriesPerPass`, so a large tail drains
over many write ticks. Each CF-free pass folds about 20 entries into the
small snapshot, and the snapshot stays small. Tail length alone does
not defer; only the snapshot axis (`C` bytes / `E` rows) defers.

### 4. Off baerly-storage → Postgres: the workload envelope

Triggers 1-3 ask whether one collection's fold fits one host. This asks
whether write throughput or total scale still belongs on baerly-storage.

Cross these lines and graduate the workload to D1/Postgres, regardless
of deployment tier. For Postgres, use `baerly export --target=postgres`.

| Axis | Threshold | Source and meaning |
| --- | --- | --- |
| Write throughput | ~30 logical writes/min/collection | Per-collection contention ceiling, not account-wide. Code constant: `M_SIZE_WRITES_PER_MIN_PER_COLLECTION = 30` in `packages/cli/src/admin/usage.ts`; `baerly admin usage` grades each collection against it. It is hard-coded but still a model/estimate from the CAS-livelock regime, pending real-infra measurement on R2. |
| Stored bytes | >10 GB/tenant stored | R2 free-tier storage line, not a protocol ceiling. A tenant is a key prefix; baerly-storage does not read, enforce, or compute per-tenant byte totals. Billing begins above 10 GB-mo on R2; see [cost-model.md](cost-model.md). |
| Collection fan-out | ~100 collections/tenant | Bench-grounded soft linear-cost guideline. `pnpm bench:collection-fanout` writes `docs/spec/attachments/collection-fanout-baseline.json`; `admin usage` costs ≈ N × (1 LIST + up to 120 GETs per collection). Nothing enforces a cap; cost and scan latency grow linearly with N. |

Provenance: the 30-writes/min figure is the code constant above; the
>10 GB/tenant line lives in [cost-model.md](cost-model.md) and
[pricing-log.md](pricing-log.md), not code; and the ~100
collections/tenant guideline comes from the fan-out bench, not
`packages/protocol/src/constants.ts`.

For rationale, see [workload-ceiling](thesis.md#workload-ceiling). The
[cost-model](cost-model.md#alternative-dbs-at-m-size) records adjacent
cost lines: advisory at ~100 writes/min account-wide, and hard Class A
trigger at `> 50M/mo` (≈580 writes/min on R2 at ~2x, ≈390 on Node at
~3x). Stored data is a cost signal at the ~10 GB R2 free-tier line, not
a hard trigger. The historic `effective write-amp > 6` trigger is
retired; maintenance falling behind is signalled by
`db.compaction.deferred_total` and the defer `console.warn`.

## Operations plane (env vars)

Maintenance has two configuration planes:

- **Application authoring:** `defineConfig`, `baerlyNode`, and the
  `.d.ts` surface expose no maintenance config. App authors do not tune
  folds.
- **Operations / control plane:** env vars set out-of-band by an
  operator or platform. This plane is empty by default; use it only
  after deciding which graduation path applies. Do not put these vars in
  `defineConfig`, `baerlyNode`, or any `.d.ts`; they are not part of the
  application contract.

| Env var | Effect | When to set it |
| --- | --- | --- |
| `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` | Overrides static snapshot ceiling `C`, whatever the active profile's value is (512 KB cf-free, 8 MiB cf-paid, 32 MiB node). Raises `S_max = C`, letting larger snapshot rebuilds pass the gate. | On a large Node host, after confirming the host can rebuild that snapshot (`C ≈ heap / 10`). On Cloudflare, prefer the profile switch first. |
| `BAERLY_MAINTENANCE_PROFILE` | Cloudflare-only. Accepts `cf-free` (default) or `cf-paid`. `cf-paid` raises fold-entry and GC cadence/mark/sweep caps to Node values, using the paid 10,000-subrequest budget, **and** selects the paid ceilings `C = 8 MiB` / `E = 32,768`. This is the only way to raise `E` on Cloudflare. | On Cloudflare Paid, after upgrading the plan tier, to recover per-pass throughput and the paid ceilings. Do not set on Node; Node selects its own profile, and its ceilings, automatically. |
| `BAERLY_MAINTENANCE_DISABLE` | Kill switch; disables in-band fold/GC phases while preserving bounded `tail_hint` refresh. | Diagnostics, or to stop fold attempts on a deferring collection while you plan graduation. |

There is no env var for `E`. It is a kernel constant, not
adapter-threaded — but there are three of them, one per profile (2,048 /
32,768 / 65,536), so the profile in effect is what sets it. Selecting a
larger profile is the supported way to raise `E`.

**Cloudflare caveat: size the cap to the isolate.** Raising
`BAERLY_MAINTENANCE_MAX_FOLD_BYTES` above what a CF isolate can rebuild
can create a killed-rebuild loop: the gate passes, the rebuild runs in
`ctx.waitUntil`, the isolate is killed by CPU or memory, no in-band
backoff fires, and the next write tries again.

On the free profile, the CF adapter `console.warn`s once at handler init
when `BAERLY_MAINTENANCE_MAX_FOLD_BYTES > CF_FREE_MAX_SAFE_FOLD_BYTES`
(1 MiB), the largest snapshot a free isolate can one-shot rebuild under
the ~10 ms budget. It stays silent on `cf-paid`, whose own ceiling is
already 8x that bound and whose wall is memory rather than CPU. There is
still no runtime metric for the kill itself.
Watch the snapshot key and object count from `baerly inspect`; a
snapshot key that never advances while `live_log_tail` grows is a
rebuild that keeps not landing.

Safe remedies, in order:

- **Cloudflare Paid:** raises CPU limits; `BAERLY_MAINTENANCE_PROFILE=cf-paid`
  then applies ceilings already sized to the ~128 MB memory wall rather
  than the 30 s CPU budget. Any further override is sized to memory too.
- **Serverful Node:** no per-request CPU/subrequest cap; bounded by host
  RAM, and the node profile is selected automatically. Raise the env cap
  above 32 MiB only with heap to spare.
- **Chunked snapshots:** future multi-level L0..L9 rebuilds would avoid
  holding the whole snapshot resident. Not shipped.

## How to raise a limit

| Limit | How to raise it | Notes |
| --- | --- | --- |
| Static fold-byte ceiling `C` (512 KB cf-free / 8 MiB cf-paid / 32 MiB node) | `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` env var | Set out-of-band in the deploy environment; takes effect on the next write tick. Size to what the host can rebuild — `C ≈ heap / 10`. |
| Static fold-row ceiling `E` (2,048 cf-free / 32,768 cf-paid / 65,536 node) | Move to a larger host profile: `BAERLY_MAINTENANCE_PROFILE=cf-paid` on Cloudflare, or a Node host (automatic) | No env var sets `E` directly. Node's 65,536 is the largest shipped value; past it, split or graduate the collection. |
| Cloudflare free CPU / subrequest wall (~10 ms CPU, 50 subrequests) | Cloudflare plan upgrade (free → paid), then `BAERLY_MAINTENANCE_PROFILE=cf-paid` | Paid raises CPU to 30 s default (up to 5 min); subrequest limit lifts to 10,000/request by default, raisable to 10M, changed 2026-02-11. The profile switch also moves `C`/`E` to the paid ceilings, so `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` is only needed to go past 8 MiB. A finer-grained per-platform `cpuLimit` declaration was evaluated and measured unnecessary: the in-band write tick keeps up to ~3x the rate envelope under stress on free, so it is not built. |
| Per-collection commit scope (one ordered log per collection; no cross-collection atomicity) | Cannot be increased; protocol invariant | The write hotspot is the next numbered `log/<seq>` create for one collection. Cross-collection atomicity is not offered. |
| Snapshot and legacy-content hash addressing | Cannot be increased; protocol invariant | Snapshot filenames embed full SHA-256, and current readers recompute the body hash before accepting a snapshot. Legacy content filenames use 128-bit truncated SHA-256 and collisions were not runtime-verified; their GC safety comes from conservative liveness, grace, and sweep-time revalidation, not the snapshot no-corruption guarantee. |

`E` is in this map, but with a different lever: it is a kernel constant
per profile rather than an env-var knob, so the profile is what raises
it.

## See also

- [cost-model.md](cost-model.md) — Class A ops, write-amp, stored bytes,
  and the cost side of graduation.
- [thesis.md](thesis.md#workload-ceiling) — why the envelope is named
  and why graduation is the success path.
- [adr/002-ephemeral-coordination.md](../adr/002-ephemeral-coordination.md)
  — why graduation is mechanical: there is no stateful coordinator to
  migrate away from, so the bucket plus the log shape are the handoff to
  Postgres.
