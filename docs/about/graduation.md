---
title: Graduation thresholds
audience: operator
summary: The CPU and memory bounds that tell you when a collection has outgrown its deployment tier, and what to do about it.
last-reviewed: 2026-06-28
tags: [operations, cost, capacity, graduation]
related: [cost-model.md, workload-fit.md, thesis.md, "../adr/002-ephemeral-coordination.md"]
---

# Graduation thresholds

baerly-storage is sized for the prototype tier: internal tools, side
projects, and small product experiments. Graduation is what you do when
one collection outgrows that tier.

The threshold concept is **the fold**: compaction that rolls committed
log entries into a snapshot. The tail is the newer log entries not yet in
that snapshot. baerly-storage slices the tail, but it still rebuilds the
whole snapshot in one pass. Graduation starts when that rebuild no longer
fits the host's CPU, subrequest, or memory budget.

Watch `snapshot_bytes` and `snapshot_rows`. `baerly inspect` reports
them, and they also live on `current.json`. When write-tick maintenance
defers because either ceiling trips, it bumps
`db.compaction.deferred_total` and may emit a rate-limited
`console.warn` naming the dimension.

For the **cost** side of graduation, see
[cost-model.md](cost-model.md). The cost signals are separate:

- **Advisory:** sustained ~100 writes/min account-wide
  (provider-agnostic; ~13M Class A/mo / ~$54/mo object-storage ops on
  R2, ~17.3M / ~$86/mo on S3), surfaced by `baerly cost`.
- **Hard cost trigger:** 50M Class A/mo, sustained over 7 days
  (~390 writes/min, ~$220/mo object-storage ops on R2).

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
| `db.compaction.deferred_total` or defer `console.warn` on Cloudflare free | Warning names bytes vs. rows; `baerly inspect` reports `snapshot_bytes` / `snapshot_rows` | `snapshot_bytes > C` or `snapshot_rows + maxFoldEntriesPerPass > E` | If bytes tripped, upgrade to Workers Paid, then raise `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` only to a cap the isolate can rebuild. If rows tripped, split or graduate the collection; `E` is not operator-tunable. |
| Same defer on Node | Warning text plus `snapshot_bytes` / `snapshot_rows` from `baerly inspect` | Host has RAM for old snapshot + new snapshot + tail, and the row ceiling did not trip | If bytes tripped, raise `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`; expect one inline write-latency spike. If rows tripped, split or graduate the collection. |
| Object count grows while writes are steady | Logs + `admin fsck` | GC sweep throughput no longer keeps up with orphan production | Reduce contention, split the hot collection, or graduate the workload. |
| Sustained hot collection | `admin usage` | ~30 logical writes/min/collection | Graduate to D1/Postgres; this is the workload ceiling. |
| Tenant data keeps growing | `admin usage` / bucket inventory | >10 GB/tenant (R2 free-tier storage line; see [cost-model.md](cost-model.md)) or ~100 collections/tenant (soft fan-out guideline; see [workload-fit.md](workload-fit.md#scale-at-a-glance)) | Review graduation cost; neither line is enforced by the protocol. |
| `baerly cost` prints advisory note | `baerly cost` | ~100 writes/min account-wide (provider-agnostic; ~13M Class A/mo / ~$54/mo R2 object-storage ops, ~17.3M / ~$86/mo S3), advisory only; see [cost-model.md](cost-model.md#ops-vs-cost-tradeoff) | Compare object storage's low operator burden against a managed DB. Hard trigger: 50M/mo (~$220/mo R2). |

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

Some metric sinks preserve the byte-vs-row label on
`db.compaction.deferred_total`; the warning text always names it. A
large tail alone is not a graduation signal because it drains in slices.
Compare the snapshot against
[the auto-maintained ceiling](#the-auto-maintained-snapshot-ceiling)
and [the per-tier table](#per-tier-bounds).

### What is shipped vs. estimated

**Shipped:** write-triggered folding, `C`
(`MAINTENANCE_MAX_FOLD_BYTES_DEFAULT`), `E`
(`MAINTENANCE_MAX_FOLD_ROWS`), `MAINTENANCE_TARGET_RATIO`, `S_max`, the
`BAERLY_MAINTENANCE_*` env vars, and the defer/warn signals. These are
defined in code and dispatched on the write path by
[`runBoundedMaintenance`](../../packages/server/src/maintenance.ts).

**Estimated:** the per-tier CPU/memory envelope numbers, including the
~10 ms-CPU-to-bytes conversion, the chosen `E = 2048` row ceiling, and
the graduation snapshot sizes. The fold-cost bench has landed
(`docs/spec/attachments/fold-cost-baseline.json`), but recalibrating
`C`/`E` to where the paid envelope actually binds is deferred until
there is demonstrated need.

## What costs CPU: compaction

Ordinary reads and writes do a small, bounded number of storage calls
while a collection stays inside the maintained envelope. The operation
that grows with collection size is compaction: rebuilding the snapshot.

A fold (`compact` in
[`packages/server/src/compactor.ts`](../../packages/server/src/compactor.ts))
does this work:

1. Read `current.json`.
2. Load the previous snapshot with `loadSnapshotAsMap`
   (`compactor.ts:265`).
3. Fetch the bounded log slice with `walkLogRangeWithBytes`
   (`compactor.ts:271`).
4. Apply entries in memory: `I`/`U` overwrite, `D` tombstones
   (`compactor.ts:287`-`314`).
5. Sort docs by `_id` for deterministic output
   (`compactor.ts:316`-`329`).
6. Serialize the new snapshot with `encodeSnapshotBody`
   (`compactor.ts:337`).
7. SHA-256 the snapshot bytes with `snapshotHash` to derive the
   filename (`compactor.ts:364`).
8. PUT the snapshot (`compactor.ts:375`) and CAS-advance
   (conditional compare-and-swap) `current.json` (`compactor.ts:402`).

The GETs and PUTs are I/O. They do not count against a Cloudflare
Worker's CPU budget. CPU is spent on the in-memory JSON parse, merge,
sort, stringify, and SHA-256 work.

Compaction is all-or-nothing. Snapshot filenames embed the SHA-256 of
their body, and the atomic moment is the single conditional PUT that
swaps `current.json.snapshot` (`compactor.ts:5`-`20`). If a write is
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

> **≈ 11 ms CPU per MB of snapshot rebuilt.**

Treat that as an envelope model, not a benchmark. A 2-3x swing in the
JSON assumption moves the free-tier ceiling between roughly 0.4 MB and
1.5 MB of snapshot. The shape stays linear in the snapshot, dominated
by JSON, around 10 ms/MB.

### Snapshot size → CPU per fold

| Snapshot size | CPU per rebuild (order-of-magnitude) | Note |
| --- | --- | --- |
| 64 KB | ~0.7 ms | trivial |
| 256 KB | ~2.8 ms | trivial; under the free-tier line by 3-4x |
| 512 KB | ~5.5 ms | conservative default snapshot ceiling `C` |
| 1 MB | ~11 ms | ≈ Cloudflare free-tier CPU line (`CF_FREE_MAX_SAFE_FOLD_BYTES`) |
| 5 MB | ~55 ms | fine on paid |
| 40 MB | ~440 ms | CPU fine on paid, but near the memory wall |

A ~512 KB snapshot is roughly **100-500 documents** at 1-5 KB/doc. Below
~256 KB, a rebuild is 1-3 ms and effectively free everywhere.

The row ceiling catches tiny-doc snapshots that bytes can miss:
`E = MAINTENANCE_MAX_FOLD_ROWS = 2048`. This value is
**PROVISIONAL**. The fold-cost bench shows 2048 rows is well under the
CF-free CPU budget, but recalibrating `E` and `C` to where the paid
envelope binds is deferred pending need. Treat 2048 rows as the order of
magnitude where per-entry CPU starts to rival the byte budget on CF free,
not as a final measured limit.

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
  `snapshot_bytes > C`. Default
  `C = MAINTENANCE_MAX_FOLD_BYTES_DEFAULT = 512 KB`. Operators can raise
  it out-of-band with `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`; see
  [Operations plane](#operations-plane-env-vars).
- **Static row ceiling (`E`).** The rebuild also defers if
  `snapshot_rows + maxFoldEntriesPerPass > E`, with `E = 2048`
  provisional.

`C` is conservative because there is no adaptive backoff for a killed
rebuild. Cloudflare free's ~10 ms CPU budget can rebuild roughly a 1 MB
snapshot; `C = 512 KB` leaves margin. On CF free, setting
`BAERLY_MAINTENANCE_MAX_FOLD_BYTES` above
`CF_FREE_MAX_SAFE_FOLD_BYTES = 1 MiB` emits an init-time
`console.warn`.

### The auto-maintained snapshot ceiling

Because the tail is sliced and the snapshot rebuild is the unsliced work:

> **`S_max = C`** (subject to
> `snapshot_rows + maxFoldEntriesPerPass <= E`).

At the defaults, `S_max = 512 KB` of snapshot: about **100-500
documents** at 1-5 KB/doc on Cloudflare free, or fewer if tiny docs hit
the 2048-row ceiling first. Past `C` bytes or `E` rows, folds defer. A
byte defer can be cleared by raising
`BAERLY_MAINTENANCE_MAX_FOLD_BYTES` on a host that can rebuild the
snapshot. A row defer cannot; split or graduate the collection until
`E` is recalibrated. Until then, the live log stops collapsing into the
snapshot.

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
compaction write-amplification and increasing read-amplification. LSM
engines such as Go's and RocksDB commonly pick `R = 2`.
baerly-storage uses `R = 1.0` to halve read-amplification while
accepting ~2x compaction write-amplification.

This compaction write-amplification is not the cost model's **effective
Class-A write-amplification** (~3x on the Cloudflare profile / ~4x on
the Node profile). The historic `effective write-amp > 6` graduation
trigger has been retired because the measured ~3-4x baseline makes it
unreachable through bounded maintenance; see
[cost-model.md](cost-model.md#alternative-dbs-at-m-size).

## Per-tier bounds

Read this table on the snapshot axis: `snapshot_bytes` against `C`, and
`snapshot_rows` against `E`. The sliced tail does not enter the per-pass
ceiling. The default `C = 512 KB` sits below the CF-free hardware wall;
after you raise `C`, the host's hardware wall binds.

Cloudflare free has two binding walls:

- **CPU:** ~10 ms/request, defended by `C` and `E`.
- **Subrequests:** 50/request, defended by the
  `maxFoldEntriesPerPass ≈ 20` tail slice. A fold pass is about
  `slice + 3` subrequests, and GC is about `6 + marks + sweeps`; one
  phase per tick stays under 50.

| Tier | Hardware walls | Binds on | What can actually fold |
| --- | --- | --- | --- |
| **Cloudflare free** | ~10 ms CPU/request and 50 subrequests/request | CPU + subrequests | default `C = 512 KB` ⇒ ~512 KB snapshot (`S_max = C`), `E = 2048` rows; tail drains ≈ 20 entries/tick; raising `C` past ~1 MB (`CF_FREE_MAX_SAFE_FOLD_BYTES`) hits the CPU wall and `console.warn`s |
| **Cloudflare paid** | 30 s CPU default (up to 5 min); ~128 MB Worker memory; 10,000 subrequests/request default, raisable to 10M, changed 2026-02-11; free wall stays 50 | memory | raise `C` and fold to ~tens of MB snapshot (~40 MB); CPU is not the wall; opt in to higher per-pass throughput with `BAERLY_MAINTENANCE_PROFILE=cf-paid` |
| **Serverful Node** | no per-request cap; process RAM; a fold blocks the event loop | host memory | raise `C` and fold up to host memory; per-pass caps are `NODE_MAINTENANCE_*` (moderate, latency-budgeted) |
| **AWS Lambda** _(adapter pending — not yet shipped)_ | 3-10 GB RAM selectable; up to 15 min timeout; `AWS_LAMBDA_FUNCTION_MEMORY_SIZE` self-reported | host memory, same shape as Node | between the Workers tiers and serverful Node in practice; raise `C` once the adapter ships |

Implications: on Cloudflare free, a ~1 MB snapshot is near the ~10 ms
CPU wall, and the 50-subrequest wall makes a large tail drain over many
write ticks. On Cloudflare paid, CPU could rebuild a multi-GB snapshot,
but Worker memory (~128 MB) is the wall because a fold holds the old
snapshot, new snapshot, and log tail at once, roughly 2-3x the snapshot.
On Node, process RAM and event-loop blocking bind.

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
Above-envelope write contention can make writers lose `log/<seq>.json`
create races and maintenance lose `current.json` CAS often enough to
produce orphans faster than GC sweeps them. Object count growth is the
signal; the protocol does not silently lose data.

### Which graduation?

Map the signal before acting:

- **Cloudflare free byte defer:** upgrade tier, then size `C` to memory.
- **Node byte defer:** raise `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`.
- **Any row defer:** split or graduate; `E` is not operator-tunable.
- **Hot collection or tenant-scale signal:** graduate the workload to
  D1/Postgres.

A deferred fold alone does not mean "move to Postgres."

> **Cron does not help Cloudflare free.** Maintenance ticks on the write
> path. The opt-in `runScheduledMaintenance` SDK is useful for explicit
> maintenance windows, but a scheduled Worker has the same ~10 ms CPU
> limit as a request handler. A fresh budget per tick is not a larger
> budget. The levers are Workers Paid, a Node host, or a smaller cap.

### 1. Off Cloudflare free → Cloudflare paid

**Threshold:** the auto-maintained snapshot ceiling:
~512 KB snapshot / ~100-500 docs, or `E = 2048` rows, whichever trips
first at the `C = 512 KB` defaults:
`snapshot_bytes > C` or `snapshot_rows + maxFoldEntriesPerPass > E`.

**What you'll observe:** slower reads, a growing bucket, and a
`console.warn` naming bytes vs. rows.

**What to do:** upgrade to Cloudflare Workers Paid (about $5/mo; 30 s
CPU vs. free's ~10 ms). Then raise
`BAERLY_MAINTENANCE_MAX_FOLD_BYTES` above the 512 KB default so
compaction resumes. On paid, CPU stops being the practical wall; Worker
memory (~128 MB) becomes the limit, which is roughly tens of MB of
snapshot. Size the cap to memory, not CPU; see
[Operations plane](#operations-plane-env-vars).

### 2. On serverful Node: raise the env var

When the warning names bytes, this is not a tier graduation. A Node host
has no per-request CPU wall; the ceiling is host RAM, and the static
`C = 512 KB` default is holding back work the host can run. Raise
`BAERLY_MAINTENANCE_MAX_FOLD_BYTES`; the fold completes on the next
write, with one inline write-latency spike. If the warning names rows,
the env var will not help because `E` is not operator-tunable.

### 3. Paid serverless → serverful Node

**Threshold:** a snapshot approaches **tens of MB**.

**What you'll observe:** on paid Cloudflare, folds start running into
the ~128 MB Worker memory limit. The fold cannot hold the old snapshot,
new snapshot, and log tail resident at once. CPU is still fine.

**What to do:** move the collection to a long-lived Node host, then
raise the env cap as above, or wait for chunked snapshots. The current
snapshot format is single-level (one L9 snapshot replaces the prior;
`compactor.ts:22`-`32`) and is forward-compatible with a future
multi-level L0..L9 scheme that folds incrementally without a wire
change.

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
| Write throughput | ~30 logical writes/min/collection | Per-collection contention ceiling, not account-wide. Code constant: `M_SIZE_WRITES_PER_MIN_PER_COLLECTION = 30` in `packages/cli/src/admin/usage.ts:73`; `baerly admin usage` grades each collection against it. It is hard-coded but still a model/estimate from the CAS-livelock regime, pending real-infra measurement on R2. |
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
trigger at `> 50M/mo` (≈390 writes/min on R2 at ~3x, ≈290 on Node at
~4x). Stored data is a cost signal at the ~10 GB R2 free-tier line, not
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
| `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` | Overrides static snapshot ceiling `C` (default `MAINTENANCE_MAX_FOLD_BYTES_DEFAULT = 512 KB`). Raises `S_max = C`, letting larger snapshot rebuilds pass the gate. | On Cloudflare Paid or a large Node host, after confirming the host can rebuild that snapshot. |
| `BAERLY_MAINTENANCE_PROFILE` | Cloudflare-only. Accepts `cf-free` (default) or `cf-paid`. `cf-paid` raises fold-entry and GC cadence/mark/sweep caps to Node values, using the paid 10,000-subrequest budget. Ceilings `C` and `E` do not change. | On Cloudflare Paid, after upgrading the plan tier, to recover per-pass throughput. Do not set on Node; Node selects its own profile. |
| `BAERLY_MAINTENANCE_DISABLE` | Kill switch; disables in-band fold/GC phases while preserving bounded `tail_hint` refresh. | Diagnostics, or to stop fold attempts on a deferring collection while you plan graduation. |

`E = MAINTENANCE_MAX_FOLD_ROWS = 2048` is not operator-tunable. It is a
kernel constant, not adapter-threaded. The fold-cost bench has landed;
recalibrating `E` is deferred pending demonstrated need.

**Cloudflare caveat: size the cap to the isolate.** Raising
`BAERLY_MAINTENANCE_MAX_FOLD_BYTES` above what a CF isolate can rebuild
can create a killed-rebuild loop: the gate passes, the rebuild runs in
`ctx.waitUntil`, the isolate is killed by CPU or memory, no in-band
backoff fires, and the next write tries again.

The CF adapter `console.warn`s once at handler init when
`BAERLY_MAINTENANCE_MAX_FOLD_BYTES > CF_FREE_MAX_SAFE_FOLD_BYTES`
(1 MiB), the largest snapshot a free isolate can one-shot rebuild under
the ~10 ms budget. There is still no runtime metric for the kill itself.
Watch the snapshot key and object count from `baerly inspect`; a
snapshot key that never advances while `live_log_tail` grows is a
rebuild that keeps not landing.

Safe remedies, in order:

- **Cloudflare Paid:** raises CPU limits; then size the cap to the
  ~128 MB memory wall, not the 30 s CPU budget.
- **Serverful Node:** no per-request CPU/subrequest cap; bounded by host
  RAM. Raise the env cap.
- **Chunked snapshots:** future multi-level L0..L9 rebuilds would avoid
  holding the whole snapshot resident. Not shipped.

## How to raise a limit

| Limit | How to raise it | Notes |
| --- | --- | --- |
| Static fold-byte ceiling `C` (`MAINTENANCE_MAX_FOLD_BYTES_DEFAULT = 512 KB`) | `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` env var | Set out-of-band in the deploy environment; takes effect on the next write tick. Size to what the host can rebuild. |
| Cloudflare free CPU / subrequest wall (~10 ms CPU, 50 subrequests) | Cloudflare plan upgrade (free → paid), then raise `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` | Paid raises CPU to 30 s default (up to 5 min); subrequest limit lifts to 10,000/request by default, raisable to 10M, changed 2026-02-11. A finer-grained per-platform `cpuLimit` declaration was evaluated and measured unnecessary: the in-band write tick keeps up to ~4x the rate envelope on free, so it is not built. |
| Per-collection commit scope (one ordered log per collection; no cross-collection atomicity) | Cannot be increased; protocol invariant | The write hotspot is the next numbered `log/<seq>` create for one collection. Cross-collection atomicity is not offered. |
| Content-hash addressing (snapshot/content filenames embed SHA-256) | Cannot be increased; protocol invariant | The snapshot filename is derived from the SHA-256 of its body. Changing this would break the no-corruption guarantee that makes orphan snapshots safe to GC. |

The row ceiling `E` is not in this map because it is a kernel constant,
not an operator knob.

## See also

- [cost-model.md](cost-model.md) — Class A ops, write-amp, stored bytes,
  and the cost side of graduation.
- [thesis.md](thesis.md#workload-ceiling) — why the envelope is named
  and why graduation is the success path.
- [adr/002-ephemeral-coordination.md](../adr/002-ephemeral-coordination.md)
  — why graduation is mechanical: there is no stateful coordinator to
  migrate away from, so the bucket plus the log shape are the handoff to
  Postgres.
