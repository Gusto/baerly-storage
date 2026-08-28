---
title: Scale ceilings
audience: spec
doc_type: verification
summary: Where every published scale limit comes from — the fold cost model, the measured per-host snapshot ceilings C and E, and the storage-side throughput walls.
last-reviewed: 2026-08-27
tags: [capacity, verification, fold, ceilings]
related: ["../about/graduation.md", "../about/workload-fit.md", "../about/cost-model.md"]
---

# Scale ceilings

Why each published limit is the number it is.

This page derives; it does not tell you what to do about a limit you are
hitting. Route by the question you arrived with:

| Question | Page |
| --- | --- |
| Should I build on this? | [workload-fit.md](../about/workload-fit.md) |
| What will it cost? | [cost-model.md](../about/cost-model.md) |
| Something's wrong — what do I do? | [graduation.md](../about/graduation.md) |
| Why is that number that number? | this page |

Those pages own the figures a reader acts on. This page owns the
provenance behind them, so a figure that is challenged has exactly one
place to be checked.

## What is shipped vs. estimated

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

cf-free is the exception, because its binding cost is CPU rather than
memory: 2048 rows measures ~1.5 ms and the row axis does not reach ~10 ms
until ~16,384 rows, but that margin was measured off workerd and so does
not transfer. The value stays deliberately far inside it;
[Is the free CPU limit a wall?](#is-the-free-cpu-limit-a-wall) records
what that conservatism rests on.

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

What an interrupted fold costs is liveness, not integrity. Because
`current.json` never advances, `log_seq_start` stays where it was: the
tail keeps growing and the next write tick retries the same rebuild. One
interruption is a retried tick. A rebuild the host can never finish is a
loop, and the cost of the loop is the unbounded tail — which is why the
ceiling has to be sized to what the host can actually rebuild
([Cloudflare caveat](../about/graduation.md#operations-plane-env-vars)).

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
free budget until ~16,384 rows, because that margin was measured off
workerd and the free CPU line is a cost budget rather than a guarded wall
([details](#is-the-free-cpu-limit-a-wall)); the larger hosts are sized to
memory, which on those hosts is a real limit.

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
  [Operations plane](../about/graduation.md#operations-plane-env-vars).
- **Static row ceiling (`E`).** The rebuild also defers if
  `snapshot_rows + maxFoldEntriesPerPass > E`. `E` is likewise per host
  profile: 2048 on cf-free, 32,768 on cf-paid, 65,536 on node.

`C` is conservative *on cf-free* because a fold that overruns cannot back
off in-band — there is no adaptive retry, and the fold runs on a user's
write. Cloudflare free's ~10 ms CPU budget can rebuild roughly a 1 MB
snapshot; `C = 512 KB` leaves margin. That budget is economic rather than
enforced at any measured duty cycle
([details](#is-the-free-cpu-limit-a-wall)). On CF free, setting
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
Class-A write-amplification** (~2x on the Cloudflare profile / ~2.5x on
the Node profile). The measured ranges are 1.741-1.843 and 2.404-2.529,
respectively. The historic `effective write-amp > 6` graduation trigger
has been retired because that measured baseline makes it unreachable
through bounded maintenance. Stress peaks at 2.532x under pathological
churn; CAS contention is still the route above that measured
maintenance profile.
See
[cost-model.md](../about/cost-model.md#alternative-dbs-at-m-size).

## Per-tier bounds

Read this table on the snapshot axis: `snapshot_bytes` against `C`, and
`snapshot_rows` against `E`. The sliced tail does not enter the per-pass
ceiling. Each profile ships its own `C`/`E`, sized to that host's
measured wall rather than inherited from cf-free, so the shipped ceiling
is already near the hardware wall on every tier; raising `C` further is
an override, not the normal path.

Cloudflare free has one hard per-invocation wall and one economic
ceiling. Isolate memory (~128 MB) is a third hard limit, but at
`C = 512 KB` it is nowhere near binding; it is what binds cf-paid and
Node.

- **Subrequests: 50/request — hard.** Defended by the
  `maxFoldEntriesPerPass ≈ 20` tail slice. A fold pass is about
  `slice + 3` subrequests. GC's mark cap bounds LIST classification and
  ledger growth, while its sweep cap bounds DELETEs; one phase per tick
  stays under 50. Exact GC accounting is maintained in the
  `CLOUDFLARE_FREE_TIER` JSDoc and
  `packages/server/src/maintenance-budget.test.ts`.
- **CPU: ~10 ms/request — economic.** `C` and `E` are sized against it as
  a cost and latency budget line, not as a guard against termination.

#### Is the free CPU limit a wall?

Not at any duty cycle that has been measured. On a deployed Worker with a
*configured* `limits.cpu_ms: 10`, 4 MiB folds consumed 41.7–67.8 ms of
platform-measured CPU and every invocation reported `outcome: success` —
the budget exceeded up to ~6.8x with enforcement never engaging, at ~3 s
and 70 s spacing alike. An earlier probe on a confirmed Workers Free
account, with no `limits` block at all, ran ten consecutive 4 MiB folds
at 23–66 ms with zero `exceededCpu`.

Cloudflare documents the limit as elastic: an isolate has "built-in
flexibility" for infrequent overruns, and a Worker that "starts hitting
the limit consistently" is terminated according to the configured limit.
A kill is therefore not excluded. What is unmeasured is the region where
it would appear: sustained rates *faster* than one fold every ~3 s, and
runs longer than the ten consecutive invocations tested. No numeric
threshold, window, or duty cycle is published.

Two consequences:

- **The cost model is unaffected.** The measured ~10–16 ms/MB at 4 MiB
  corroborates the [fold cost model](#fold-cost-model) above. What the
  measurement removes is the kill, not the number.
- **On cf-free, `C` and `E` are budget lines rather than guards.** They
  bound real costs — the free daily allowance, billed CPU-ms on the
  Standard usage model, and user-visible write latency, since the fold
  runs on the write path — but not a termination risk that has been
  observed. This applies to the free tier only: on cf-paid and Node, `C`
  guards the ~128 MB memory wall, which does terminate an isolate, and
  those values stay sized to it at a 4x margin.

| Tier | Hardware walls | Binds on | What can actually fold |
| --- | --- | --- | --- |
| **Cloudflare free** | ~10 ms CPU/request (economic) and 50 subrequests/request (hard) | CPU cost + subrequests | profile `C = 512 KB` ⇒ ~512 KB snapshot (`S_max = C`), `E = 2048` rows; tail drains ≈ 20 entries/tick; raising `C` past ~1 MB (`CF_FREE_MAX_SAFE_FOLD_BYTES`) takes the fold past the ~10 ms CPU budget and `console.warn`s |
| **Cloudflare paid** | 30 s CPU default (up to 5 min); ~128 MB Worker memory; 10,000 subrequests/request default, raisable to 10M, changed 2026-02-11; free wall stays 50 | memory | `C = 8 MiB` (`CF_PAID_MAINTENANCE_MAX_FOLD_BYTES`), `E = 32,768` rows (`CF_PAID_MAINTENANCE_MAX_FOLD_ROWS`), selected by `BAERLY_MAINTENANCE_PROFILE=cf-paid` — no `C` override needed to get there. CPU is not the wall; memory is: 8 MiB peaks at ~19.5 MB, which fits the 4x margin under ~128 MB; the next grid cell (16 MiB ⇒ 37.3 MB) does not. That margin is why the ceiling is not "tens of MB" |
| **Serverful Node** | no per-request cap; process RAM; a fold blocks the event loop | host memory | `C = 32 MiB` (`NODE_MAINTENANCE_MAX_FOLD_BYTES`), `E = 65,536` rows (`NODE_MAINTENANCE_MAX_FOLD_ROWS`), selected automatically by the Node adapter. 32 MiB is the top of the measured grid, **not** the measured wall — the probe reports `grid-exhausted` for this profile at every margin and every heap from 704 MB up. Past the grid, scale by `C ≈ heap / 10`. Per-pass caps are `NODE_MAINTENANCE_*` (moderate, latency-budgeted) |

Implications: on Cloudflare free, a ~1 MB snapshot is near the ~10 ms
CPU budget, and the 50-subrequest wall makes a large tail drain over many
write ticks. On Cloudflare paid, CPU could rebuild a multi-GB snapshot,
but Worker memory (~128 MB) is the wall because a fold holds the old
snapshot, new snapshot, and log tail at once — measured at ~2.4x the
snapshot in peak heap. On Node, process RAM and event-loop blocking
bind, and the shipped 32 MiB is a floor set by where the bench grid
stopped, not by where Node stops.

## Collection fan-out

The ~100 collections/tenant guideline is a bench-grounded soft linear-cost
line, not a protocol cap. `pnpm bench:collection-fanout`
([`bench/collection-fanout.ts`](../../bench/collection-fanout.ts)) measures
the `admin usage` sweep cost through a counting `Storage` proxy and writes
[`attachments/collection-fanout-baseline.json`](attachments/collection-fanout-baseline.json):
the sweep costs ≈ N × (1 LIST + up to 120 GETs per collection), strictly
linear in N. ~100 is where that sweep cost becomes noticeable, which is
erosion rather than a cliff.

Nothing enforces a cap, and the figure is not a code constant — it comes
from the fan-out bench, not `packages/protocol/src/constants.ts`. The cost
it names is operator tooling latency and bucket round-trips, not host CPU.

## Hot-prefix cliff at high write fan-in

One more scale cliff lives on the storage side, not the dollar side.
Under single-write commit, writers racing the same collection all try to
create the next `log/<seq>` key, so concurrent PUTs concentrate on one
object-store prefix. S3-class stores cap sustained mutating throughput at
roughly **3,500 PUT/s per prefix**; a collection near that line is hitting
a per-prefix ceiling, not a pricing limit. This is inherent to a single
linearized per-collection log, the same property that gives per-collection
ordering. It sits well past the published ~30-writes/min/collection
envelope. Spreading load across more collections is the lever.

GCS is tighter on the same axis and ramps from a cold start rather than
beginning at peak QPS; see
[cost-model.md § Google Cloud Storage (GCS)](../about/cost-model.md#google-cloud-storage-gcs)
for the provider-specific numbers and the hierarchical-namespace lever.

## See also

- [graduation.md](../about/graduation.md) — what to do when one of these
  ceilings trips.
- [workload-fit.md](../about/workload-fit.md) — the published envelope a
  builder evaluates against.
- [cost-model.md](../about/cost-model.md) — the dollar meters and the
  rates behind them.
- [sync-protocol.md](sync-protocol.md) — the commit and compaction
  mechanism these ceilings bound.
