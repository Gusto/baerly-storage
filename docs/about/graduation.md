---
title: Graduation thresholds
audience: operator
summary: The CPU and memory bounds that tell you when a collection has outgrown its deployment tier, and what to do about it.
last-reviewed: 2026-05-31
tags: [operations, cost, capacity, graduation]
related: [cost-model.md, thesis.md, "../adr/004-ephemeral-coordination.md"]
---

# Graduation thresholds

Graduation is the success path, not a failure mode. Baerly is sized
for the prototype tier — internal tools, side projects, a finance
team's Claude Artifact. When a collection grows past the tier it was
deployed on, the system tells you, and you move it. The
[thesis](thesis.md#what-prototype-tier-storage-needs) frames this as a
feature: *knowing exactly where graduation starts makes graduation a
feature rather than a surprise.*

This page names the precise CPU and memory bounds for each deployment
tier, so you can read your collection's snapshot size off
`baerly inspect` and know which tier you're in — and when to climb.

For the **cost** side of graduation (R2 Class A ops, write-amp, stored
bytes), see [cost-model.md](cost-model.md). This page is about the
**compute** side: when the single expensive operation, compaction,
stops fitting in your runtime's budget.

> **Status — the in-band auto-maintenance machinery is now shipped; the
> cost-model *thresholds* are still estimates.** Write-triggered folding,
> the static fold ceiling `C` (`MAINTENANCE_MAX_FOLD_BYTES_DEFAULT`), the
> two-way snapshot ceiling (`C` bytes AND `E` rows,
> `MAINTENANCE_MAX_FOLD_ROWS`), the `MAINTENANCE_TARGET_RATIO` read-amp
> knob, the auto-maintained snapshot ceiling `S_max`, the
> `BAERLY_MAINTENANCE_*` operator env vars, and the defer/warn graduation
> signals are all defined in the code and dispatched in-band on the write
> path (`runBoundedMaintenance` in
> [`packages/server/src/maintenance.ts`](../../packages/server/src/maintenance.ts)).
> What is still *estimate* rather than measured is the per-tier
> CPU/memory **envelope numbers** below — the ~10 ms-CPU-to-bytes
> conversion, the chosen `E = 2048` row ceiling, and the graduation-cliff
> snapshot sizes. Treat the constants as real (you can observe defers and
> warns from logs today) and the dollar/byte thresholds as the *target*
> envelope still being calibrated by bench. `E` in particular is marked
> **PROVISIONAL** in its constant JSDoc pending the Task 3 fold-cost bench.

## What costs CPU: compaction (folding the log)

Reads and writes are cheap and bounded — a fixed small number of
storage GETs/PUTs each, with negligible in-memory work. The one
operation that scales with collection size is **compaction** (a
"fold"): the maintenance step that rolls the live log tail into a
fresh snapshot.

A fold (`packages/server/src/compactor.ts`, the `compact` function,
`compactor.ts:152`) does, in order:

1. **Load the previous snapshot** and parse it into a map
   (`loadSnapshotAsMap`, called at `compactor.ts:209`) — a `JSON.parse`
   over the whole snapshot body, plus the SHA-256 verification of the
   snapshot bytes against its content-hashed filename.
2. **Fetch and parse the log tail** since that snapshot
   (`walkLogRange`, `compactor.ts:212`) — `JSON.parse` over roughly one
   snapshot's worth of entries.
3. **Apply the fold** in memory (`compactor.ts:220`–`240`) — overwrite
   on `I`/`U`, tombstone on `D`.
4. **Sort the docs by `_id`** for deterministic output
   (`compactor.ts:245`–`255`).
5. **Serialize the new snapshot** (`encodeSnapshotBody`,
   `compactor.ts:263`) — a `JSON.stringify` over the whole new body.
6. **SHA-256 the new snapshot bytes** (`snapshotHash`,
   `compactor.ts:264`) to derive the new filename.

Then it PUTs the new snapshot and CAS-advances `current.json`
(`compactor.ts:275`, `compactor.ts:290`).

The crucial split: **the storage GETs and PUTs are I/O. They do not
count against a Cloudflare Worker's CPU budget** — only the in-memory
parse / hash / stringify / sort steps do. So the question "will a fold
fit?" is a question about CPU time spent on JSON and SHA-256, not about
how many bytes cross the wire.

Compaction is also **all-or-nothing**: the snapshot filename embeds the
SHA-256 of its body, and the only atomic moment is the single
conditional PUT that swaps `current.json.snapshot`
(`compactor.ts:5`–`33`). A fold that is killed mid-pass leaves an
orphan snapshot file that no reader will ever consume (its hash won't
match its filename), and the pointer simply doesn't advance. **There is
no corruption** — the cost of an over-budget fold is that the bucket
stops shrinking, not that data is lost.

## The cost model

The shipped fold separates two costs that the prior estimate-based model
conflated:

- **The tail is SLICED.** A fold processes at most `maxEntriesPerRun`
  log entries per pass (`WRITE_TICK_FOLD_ENTRIES_PER_PASS ≈ 20` on CF
  free, larger on Node). A long tail is not folded in one shot — it
  **drains incrementally over many write-ticks**. So the tail no longer
  drives the per-pass ceiling; only the **snapshot rebuild** does.
- **The snapshot rebuild is UNSLICEABLE.** Each pass rewrites the whole
  snapshot — load the old snapshot, apply the slice, re-serialize, and
  SHA-256 the new bytes. This is the all-or-nothing step (the snapshot
  filename embeds its own hash), and it is the work the ceiling is sized
  against. It scales with snapshot **size** (`snapshot_bytes`, the
  parse/stringify/hash axis) **and** snapshot **row count**
  (`snapshot_rows`, the per-entry parse/merge/serialize axis — roughly
  half of fold CPU, and a tiny-doc snapshot can blow CPU under a byte
  ceiling alone; VLDB 2021 Sarkar).

So the gate is a **two-way ceiling on the snapshot axis**, not on a
`snapshot + tail` estimate. A fold defers when
`snapshot_bytes > C` **OR** `snapshot_rows > E`.

Using **order-of-magnitude** engine assumptions — JSON parse/stringify
at roughly 300 MB/s, SHA-256 at roughly 2 GB/s — the snapshot-rebuild
CPU lands at:

> **≈ 11 ms of CPU per MB of snapshot rebuilt.**

Treat the throughput numbers as order-of-magnitude, not benchmarks. A
2–3× swing in the JSON assumption moves the free-tier ceiling between
roughly 0.4 MB and 1.5 MB of snapshot — but the *shape* (linear in the
snapshot, dominated by JSON, ~10 ms/MB) is robust.

### Snapshot size → CPU per fold

The CPU cost of the unsliceable rebuild is a function of the
**snapshot** (not snapshot + tail — the tail is sliced), so that is the
axis below.

| Snapshot size | CPU per rebuild (order-of-magnitude) | Note |
|---|---|---|
| 64 KB | ~0.7 ms | trivial |
| 256 KB | ~2.8 ms | trivial — under the free-tier line by 3–4× |
| 512 KB | ~5.5 ms | the conservative **default snapshot ceiling** `C` |
| 1 MB | ~11 ms | ≈ Cloudflare **free-tier** CPU line (`CF_FREE_MAX_SAFE_FOLD_BYTES`) |
| 5 MB | ~55 ms | fine on paid |
| 40 MB | ~440 ms | CPU fine on paid, but ≈ the **memory** wall |

A ~512 KB snapshot is roughly **100–500 documents** at 1–5 KB/doc.
Below a ~256 KB snapshot a rebuild is 1–3 ms and effectively free
everywhere.

The **row axis** `E` catches the case bytes miss: a snapshot of many
tiny docs is cheap by bytes but expensive by per-entry parse/merge.
`E = MAINTENANCE_MAX_FOLD_ROWS = 2048` is the row ceiling. **This value
is PROVISIONAL** — it is a conservative placeholder pending the Task 3
fold-cost bench that will pin the measured per-entry CPU; its constant
JSDoc says as much. Treat 2048 rows as "the order of magnitude where
per-entry CPU starts to rival the byte budget on CF free," not a
bench-confirmed number yet.

### When a fold fires, and when it defers

A fold is dispatched in-band on the **write path** (reads are pure and
never trigger maintenance). Three things gate the rebuild:

- **Size-ratio trigger (read-amp knob).** The maintenance dispatch fires
  only once the live tail has grown to
  `tail_bytes >= TARGET_RATIO × snapshot_bytes`. The default
  **`TARGET_RATIO = 1.0`**: dispatch when the tail equals the snapshot.
  Below that, replaying the tail on reads is cheap, so folding would be
  wasted work. **`R` is now purely a read-amplification / fold-frequency
  knob** — it no longer enters the snapshot ceiling (the prior model's
  ratio-times-ceiling derivation is gone; see below).
- **Static snapshot ceiling `C` (bytes).** Once dispatched, the rebuild
  defers if `snapshot_bytes > C`. Default
  **`C = MAINTENANCE_MAX_FOLD_BYTES_DEFAULT = 512 KB`**, deliberately
  conservative (see below). Overridable out-of-band by
  `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` — see
  [Operations plane](#operations-plane-env-vars).
- **Static snapshot ceiling `E` (rows).** The rebuild also defers if
  `snapshot_rows > E` (`E = 2048`, provisional). This is the per-entry
  CPU dimension a byte ceiling misses.

The ceiling is conservative on purpose. Cloudflare free's ~10 ms CPU can
rebuild roughly a 1 MB snapshot (~11 ms is at the line) before the
isolate is killed; `C = 512 KB` (~5.5 ms) leaves margin, because there
is **no adaptive backoff** — a killed rebuild never reports its own
death — and the throughput model is only order-of-magnitude. Raising the
cap toward ~1 MB raises the snapshot envelope but moves the rebuild
closer to the kill cliff (and on CF free past `CF_FREE_MAX_SAFE_FOLD_BYTES
= 1 MiB` the adapter `console.warn`s — see the
[Cloudflare caveat](#operations-plane-env-vars)).

### The auto-maintained snapshot ceiling

Because the tail is sliced and only the snapshot rebuild is bounded, the
largest snapshot compaction will keep folding automatically is just the
ceiling itself:

> **`S_max = C`** (subject to `snapshot_rows <= E`).

At the defaults (`C = 512 KB`, `E = 2048`) this is **`S_max = 512 KB` of
snapshot** ≈ **100–500 documents** at 1–5 KB/doc on Cloudflare free — or
fewer if the docs are tiny enough to hit the 2048-row ceiling first. A
collection whose snapshot grows past `C` bytes (or `E` rows) will
**permanently defer** its rebuild — the tail keeps draining its slices
but the snapshot can no longer absorb them — until the operator raises
`BAERLY_MAINTENANCE_MAX_FOLD_BYTES` or graduates the tier.

> **What changed from the prior model.** The earlier estimate-based
> derivation divided the ceiling by `(1 + R)` (half the ceiling at the
> defaults), because it folded the whole snapshot-plus-tail estimate in
> one unsliceable pass and `R` therefore entered the ceiling. With the
> tail now **sliced**, the per-pass work is the snapshot rebuild alone,
> so `S_max = C` (512 KB) and `R` is purely the read-amp knob.

#### The read-amp / write-amp knob

`TARGET_RATIO = R` now trades two quantities (it no longer touches the
snapshot envelope — that is `S_max = C`):

| Quantity | As a function of ratio `R` | At the chosen `R = 1.0` |
|---|---|---|
| Compaction write-amplification | `≈ 1 + 1/R` | ~2× |
| Read-amplification between folds | `≤ 1 + R` | ≤ 2× |

A higher ratio lets the tail grow longer before a fold is dispatched —
cutting write-amp but raising read-amp. LSM engines (Go's, RocksDB)
commonly pick `R = 2`. Baerly picks a **lower** ratio (`R = 1.0`) to
halve read-amp, accepting a modestly higher write-amp (~2×) — still
comfortably under the cost-model's **write-amp > 6** graduation trigger
(see [cost-model.md](cost-model.md#alternative-dbs-at-m-size)).

## Per-tier bounds

The ceiling below is stated on the **snapshot axis** (`snapshot_bytes`
against `C`, `snapshot_rows` against `E`) — the tail is sliced and does
not enter the per-pass ceiling. The default static ceiling `C = 512 KB`
already sits *under* the free tier's hardware wall — so on every tier the
practical limit is `C` (raisable via the env var), not the raw hardware
budget. The hardware walls are what `C` is sized against, and what bounds
you to once `C` is raised.

**Two binding walls on CF free, not one.** A Cloudflare free isolate is
bounded by **both** the ~10 ms CPU budget (the snapshot ceiling `C`/`E`
defends this) **and** the 50-subrequests-per-request limit (the tail
slice `maxEntriesPerRun ≈ 20` =
`WRITE_TICK_FOLD_ENTRIES_PER_PASS` defends this — a fold pass is
≈ `slice + 3` subrequests, and GC adds `6 + marks + sweeps`, so one
phase per tick stays under 50). The prior "CF free binds on CPU" was
half the story: the subrequest wall is why a large tail **drains
incrementally over many ticks** rather than folding in one pass.

| Tier | Hardware walls | Binds on | What can actually fold |
|---|---|---|---|
| **Cloudflare free** | ~10 ms CPU/request **and** 50 subrequests/request | **CPU + subrequests** | default `C = 512 KB` ⟹ **~512 KB snapshot** (`S_max = C`), `E = 2048` rows; tail drains ≈ 20 entries/tick; raising `C` past ~1 MB (`CF_FREE_MAX_SAFE_FOLD_BYTES`) hits the CPU wall and `console.warn`s |
| **Cloudflare paid** | 30 s CPU default (up to 5 min); ~128 MB Worker memory | **memory** | raise `C` and fold to **~tens of MB snapshot** (~40 MB); CPU is *not* the wall — **memory** is |
| **Serverful Node** | none per-request; process RAM; a fold blocks the event loop | **host memory** | raise `C` and fold up to host memory — far above either Worker tier; per-pass caps are `NODE_MAINTENANCE_*` (moderate, latency-budgeted) |

Reading the rows:

- **Cloudflare free tier.** Two walls bind. The ~10 ms CPU-per-request
  budget can rebuild a ~1 MB snapshot before the isolate is killed; the
  conservative default `C = 512 KB` (~5.5 ms) caps the rebuild well
  short of that, giving an auto-maintained snapshot ceiling of **~512 KB**
  (`S_max = C`, subject to `E = 2048` rows). Independently, the
  50-subrequest wall caps each pass to a ~20-entry tail slice, so a long
  tail **drains over many write-ticks** rather than folding in one shot.
  Past `S_max` the rebuild defers (no corruption — the pointer just
  doesn't advance), so the log stops collapsing and the bucket stops
  shrinking. If you raise `C` past `CF_FREE_MAX_SAFE_FOLD_BYTES` (1 MiB),
  a dispatched rebuild is CPU-killed mid-pass and silently does not land
  — the adapter `console.warn`s at init to flag this (see the
  [Cloudflare caveat](#operations-plane-env-vars)).
- **Cloudflare paid tier.** The 30 s default CPU budget (configurable up
  to 5 min) is *not* the constraint — 30 s would comfortably fold a
  multi-GB snapshot. The real wall is **Worker memory (~128 MB)**:
  because a fold holds the old snapshot, the new snapshot, and the log
  tail resident at once (~2–3× the snapshot), it tops out at a few tens
  of MB of snapshot (~40 MB) well before the CPU limit.
- **Serverful Node (self-hosted).** No per-request CPU cap. The fold is
  bounded by process RAM and by the fact that it blocks the event loop
  while it runs. The effective ceiling is host memory — far higher than
  either Worker tier.

## Graduation triggers

A persistently-deferring fold means **different things on different
hosts** — and only one of those things is actually "graduate." Before
the per-tier triggers, the symptom and the disambiguation.

### The symptom: erosion, not a cliff

When a collection persistently defers its fold, **nothing crashes and no
data is lost.** What you see instead, in order:

- **Reads get gradually slower.** Each read replays an ever-growing log
  tail on top of the stale snapshot — N extra GETs, with N climbing by
  one for every write since the last successful fold.
- **The bucket grows.** Un-folded log entries accumulate as objects and
  bytes; the bucket stops shrinking because the fold that would collapse
  them never completes.
- **A `console.warn` appears** in `wrangler tail` / your Vercel or Node
  logs, naming the deferring collection and the dimension it tripped
  (bytes vs. rows). It is rate-limited off the shared
  `current.json.last_warned_seq` (~once per
  `MAINTENANCE_WARN_INTERVAL_WRITES = 1000` writes), and the defer path
  also bumps `db.compaction.deferred_total`.

It is erosion, not a cliff. You have time to act on the warning.

### The drain-rate safety invariant

The no-lease model (a lost fold is abandoned, its orphan snapshot swept
by `runGc`) stays bounded only while GC sweep throughput keeps up with
orphan production:

> **`WRITE_TICK_GC_MAX_SWEEPS / WRITE_TICK_GC_INTERVAL` (= 10/4) ≥
> orphan-production rate `p`.**

While that holds, orphans drain and total object count stays bounded.
Sustained above-envelope contention — many writers racing the same
`current.json`, losing folds faster than GC can sweep them — violates
the invariant: object count grows. **That growth is the graduation
signal, not silent breakage.** It means the collection's write
contention has outgrown the prototype tier, exactly the threshold the
workload-envelope trigger (below) names.

### Which graduation? (it depends on the host)

A deferred fold on Cloudflare free is a tier signal; the *same* deferred
fold on a Node host is just an env var to flip; and neither is a
Postgres signal. Disambiguate before you act:

> **Cron does *not* help.** Maintenance is now in-band: it ticks on the
> write path, never on a schedule. But even the opt-in
> `runScheduledMaintenance` SDK does not escape the wall on Cloudflare
> free — a cron-triggered (scheduled) Worker has the **same ~10 ms CPU
> limit** as a request handler. A fresh CPU budget per tick is not a
> *bigger* one, and the thing that is too small is the CPU ceiling
> itself. Only the paid plan raises that ceiling (or, on Node, raising
> the env cap). Scheduling is not the lever.

### 1. Off Cloudflare free → Cloudflare paid

**This is the graduation a persistently-deferring collection on CF free
points at.**

**Threshold:** the auto-maintained snapshot ceiling, **~512 KB snapshot
/ ~100–500 docs** (or `E = 2048` rows, whichever trips first) at the
`C = 512 KB` defaults — `snapshot_bytes > C` OR `snapshot_rows > E`.

**What you'll observe:** the erosion symptoms above — slower reads, a
growing bucket, a `console.warn` naming bytes-vs-rows — because free-tier
rebuilds defer rather than burn past the ~10 ms CPU budget.

**What to do:** upgrade to the Cloudflare **paid** Workers plan (a
~$5/mo plan upgrade; 30 s CPU vs. free's ~10 ms). On paid the CPU cliff
effectively disappears — 30 s would rebuild a multi-GB snapshot — and the
binding wall becomes Worker **memory** (~128 MB ⟹ ~tens of MB snapshot).
After upgrading, raise `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` past the
512 KB default so rebuilds are no longer gated by the conservative
ceiling; compaction resumes. See the
[Cloudflare caveat](#operations-plane-env-vars) on sizing the cap to
memory, not CPU.

### 2. On serverful Node: not a graduation — just raise the env var

**This is *not* a tier graduation at all.** There is no per-request CPU
cliff on a Node host; the only ceiling is host RAM (tens of MB, far
above a few hundred KB). A deferred fold here means only that the static
`C = 512 KB` default is holding back a fold your host could easily run.

**What to do:** raise `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` and the inline
fold completes on the next write. The one cost: the fold runs **inline
on a user write**, so that write absorbs the fold latency (the fold is
synchronous in-band work, not a background job). For a several-MB fold
on Node that is a multi-hundred-ms hiccup on one write, not a tier
problem.

### 3. Paid serverless → serverful Node (the memory wall)

**Threshold:** a snapshot approaches **~tens of MB**.

**What you'll observe:** on paid Cloudflare, folds start running into the
**~128 MB Worker memory** limit — the fold can't hold the old snapshot +
new snapshot + log tail resident at once. The CPU budget is still fine;
memory is what binds.

**What to do:** move the collection to a long-lived **Node host** (no
per-request memory or CPU cap — bounded only by host RAM; then raise the
env cap as in trigger 2), or await the chunked-snapshot follow-up. The
single-level snapshot today (one snapshot replaces the prior,
`compactor.ts:23`–`33`) has a key format that is forward-compatible with
a future multi-level (L0..L9) chunked scheme that folds incrementally
rather than rewriting the whole snapshot in one pass — which would lift
this memory wall without a wire change.

### A caveat: tail churn now DRAINS — it is not a graduation signal

A **small but heavily-updated** collection (say, 50 docs hammered by
updates) builds a large tail that mostly collapses to a handful of
`_id`s. Under the prior unsliceable-fold model that large tail could
trip the ceiling and warn. **That is no longer the case:** the tail is
now **sliced** (`maxEntriesPerRun`), so a large tail simply **drains
incrementally** over many write-ticks — each pass folds ~20 entries into
the (small) snapshot, and the snapshot stays tiny. Tail churn is no
longer a defer trigger at all; only the *snapshot* axis (`C` bytes / `E`
rows) defers. A heavily-churned small collection self-heals as it drains
and never warns. Do **not** read tail length as a graduation signal — it
is bounded by the drain rate, not by the ceiling.

### 4. Off baerly → Postgres: the workload envelope (a separate axis)

This trigger is **orthogonal** to everything above. The per-fold bounds
(triggers 1–3) are about a single collection's fold fitting a CPU or
memory budget on one pass. This one is about write **throughput** and
**total scale** across the deployment. **A deferred fold is *not* a
Postgres signal** — it's a fold-cost or tier signal. Cross the envelope
below, and the signal is to graduate the *workload* off baerly to
D1 / Postgres (`baerly export --target=postgres`), regardless of which
deployment tier you're on:

- **~30 logical writes / minute / collection** — this one *is* a code
  constant: `M_SIZE_WRITES_PER_MIN_PER_COLLECTION = 30` in
  `packages/cli/src/admin/usage.ts:66`, the threshold
  `baerly admin usage` grades against.
- **~10 GB / tenant** total.
- **~100 collections / tenant** fan-out.

> **Where these live:** the 30-writes/min figure is grounded in code
> (`packages/cli/src/admin/usage.ts:66`). The ~10 GB/tenant and
> ~100 collections/tenant figures are **not** in
> `packages/protocol/src/constants.ts` — they are documented in
> [pricing-log.md](pricing-log.md) (the 2026-05-11 envelope entry) and
> [thesis.md](thesis.md#workload-ceiling), and cited in code only as a
> JSDoc comment at `packages/cli/src/admin/usage.ts:7`.

The thesis [workload-ceiling](thesis.md#workload-ceiling) section
covers the rationale (the ~30 writes/min figure tracks the CAS-livelock
regime in the S3-as-database literature). The
[cost-model](cost-model.md#alternative-dbs-at-m-size) covers the cost
triggers that ride alongside these (Class A ops > 50M/mo, write-amp > 6,
stored > 5 GB).

## Operations plane (env vars)

Maintenance has **two configuration planes**, and they never mix:

- The **application-authoring plane** — `defineConfig`, `baerlyNode`,
  the `.d.ts` surface — has **zero** maintenance config by design. App
  authors never tune the fold; the static ceiling Just Works for the
  prototype tier.
- The **operations / control plane** — a small set of env vars, set
  out-of-band in the deploy environment by a human operator or platform.
  This plane is **empty by default**: you reach for it only when a
  collection has outgrown the conservative default and you've decided
  which graduation (above) applies. **Never** put these in
  `defineConfig` / `baerlyNode` / any `.d.ts` — they are not part of the
  application contract.

| Env var | Effect | When to set it |
|---|---|---|
| `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` | Overrides the static snapshot ceiling `C` (default `MAINTENANCE_MAX_FOLD_BYTES_DEFAULT = 512 KB`). Raises `S_max = C`, letting larger snapshot rebuilds past the gate. | On Cloudflare **paid** or a big **Node** host, after you've confirmed the host can rebuild that snapshot. |
| `BAERLY_MAINTENANCE_DISABLE` | Kill switch — turns in-band maintenance off entirely. | Diagnostics, or to stop fold attempts on a deferring collection while you plan a graduation. |

(The row ceiling `E = MAINTENANCE_MAX_FOLD_ROWS = 2048` is **not**
operator-tunable — it is a kernel constant, not adapter-threaded, so it
does not appear in this table.)

**Cloudflare caveat — sizing the cap.** Raising
`BAERLY_MAINTENANCE_MAX_FOLD_BYTES` above what a CF isolate can actually
rebuild re-opens a **killed-rebuild loop**: the gate passes, the rebuild
is dispatched in `ctx.waitUntil`, the isolate is then killed by the CPU
or memory wall, and there is **no in-band backoff** — the rebuild never
reports its own death (there is **no lease metric**; the lease is
deferred), so the next write tries again and the snapshot silently never
lands.

This is no longer *fully* silent, however: the CF adapter
`console.warn`s **once at handler init** when
`BAERLY_MAINTENANCE_MAX_FOLD_BYTES > CF_FREE_MAX_SAFE_FOLD_BYTES`
(1 MiB) — the largest snapshot a free isolate can one-shot-rebuild under
the ~10 ms budget. Treat that warn as "you have asked for a rebuild this
isolate may not survive." There is still no *runtime* metric for the
kill itself; watch **snapshot age** (`baerly inspect`) and **object
count** for a rebuild that keeps not landing.

Safe remedies, in order of preference:

- **Cloudflare paid** — raised CPU limits; the wall becomes ~128 MB
  *memory*, not the 30 s *CPU* operators tend to reason about, so size
  the cap to **memory**, not CPU.
- **Serverful Node** — no per-request CPU/subrequest cap; bounded only
  by host RAM. Raise the env cap freely.
- **Chunked snapshots** — a future follow-up (multi-level L0..L9 rebuild
  that never holds the whole snapshot resident) would lift the memory
  wall without a wire change. **Not yet shipped.**

On Cloudflare, prefer **upgrading the plan tier** over raising the cap
past what the isolate can rebuild.

## How to read your tier

`baerly inspect <collection>` reports the current snapshot size **and**
the log-tail size; `baerly admin usage` reports writes/min against the
M-size ceiling. The number that decides whether rebuilds keep running is
the **snapshot** (`snapshot_bytes` against `C`, `snapshot_rows` against
`E`) — **not** the tail. A large tail is no longer a problem: it drains
incrementally (see
[tail churn](#a-caveat-tail-churn-now-drains--it-is-not-a-graduation-signal)).
Compare the snapshot against the
[auto-maintained ceiling](#the-auto-maintained-snapshot-ceiling)
(`S_max = C`, ~512 KB at the defaults — or 2048 rows, whichever trips
first) and against the [per-tier table](#per-tier-bounds) to know which
tier you're in and how much headroom remains before the next
graduation.

## See also

- [cost-model.md](cost-model.md) — the cost (Class A ops, write-amp,
  stored bytes) side of the same graduation cliff.
- [thesis.md](thesis.md#workload-ceiling) — why the envelope is
  published precisely and why graduation is the success path.
- [adr/004-ephemeral-coordination.md](../adr/004-ephemeral-coordination.md)
  — why graduation is mechanical: there's no stateful coordinator to
  migrate away from, so the bucket plus the log shape are the entire
  handoff to Postgres.
