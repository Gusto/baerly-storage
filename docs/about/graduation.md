---
title: Graduation thresholds
audience: operator
summary: The CPU and memory bounds that tell you when a collection has outgrown its deployment tier, and what to do about it.
last-reviewed: 2026-05-29
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

> **Status — the auto-maintenance machinery on this page is designed, not
> yet shipped.** The fold cost model and the per-tier CPU/memory envelope
> below are real today: compaction (`compact()`, `compactor.ts:152`) exists
> and has exactly these costs. What does **not** exist in the shipped build
> yet is the *automatic* machinery this page describes around it —
> write-triggered folding, the static fold ceiling `C`
> (`MAINTENANCE_MAX_FOLD_BYTES_DEFAULT`), the `MAINTENANCE_TARGET_RATIO`
> gate, the auto-maintained snapshot ceiling `S_max`, the
> `BAERLY_MAINTENANCE_*` operator env vars, and the defer/warn graduation
> signals. **Those constants and env vars are not defined in the code
> today.** The only maintenance trigger that exists now is the operator
> opt-in `runScheduledMaintenance`. Until the in-band design lands, read the
> thresholds below as the *target* envelope, not as behavior you can yet
> observe from `baerly inspect`.

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

A fold touches roughly **2× the snapshot size** in memory (old snapshot
+ a log tail of about one snapshot + the new snapshot) and does, per the
steps above, two JSON parses, one JSON stringify, and two SHA-256 passes.

The crucial quantity is what we call the **estimate**: the bytes a fold
actually has to process, which is **`snapshot_bytes + tail_bytes`**, not
the snapshot alone. The CPU you spend, the memory you hold resident, and
the gate that decides whether a fold runs are all driven by the
*estimate* — you parse the whole tail, then stringify the whole new
snapshot. A 256 KB snapshot with a 256 KB tail is a **512 KB fold**, not
a 256 KB one.

Using **order-of-magnitude** engine assumptions — JSON parse/stringify
at roughly 300 MB/s, SHA-256 at roughly 2 GB/s — this lands at:

> **≈ 11 ms of CPU per MB of estimate processed.**

Treat the throughput numbers as order-of-magnitude, not benchmarks. A
2–3× swing in the JSON assumption moves the free-tier ceiling between
roughly 0.4 MB and 1.5 MB of estimate — but the *shape* (linear in the
estimate, dominated by JSON, ~10 ms/MB) is robust.

### Estimate size → CPU per fold

The CPU cost is a function of the **estimate** (`snapshot + tail`), so
that is the axis below. To convert to a snapshot ceiling, see
[the auto-maintained snapshot ceiling](#the-auto-maintained-snapshot-ceiling)
— at the default ratio, a fold fires when the tail equals the snapshot,
so the estimate at fold time is **2× the snapshot**.

| Estimate (snapshot + tail) | CPU per fold (order-of-magnitude) | Note |
|---|---|---|
| 64 KB | ~0.7 ms | trivial |
| 256 KB | ~2.8 ms | trivial — under the free-tier line by 3–4× |
| 512 KB | ~5.5 ms | the conservative **default fold ceiling** `C` |
| 1 MB | ~11 ms | ≈ Cloudflare **free-tier** CPU line |
| 5 MB | ~55 ms | fine on paid |
| 40 MB | ~440 ms | CPU fine on paid, but ≈ the **memory** wall |

A 1 MB *estimate* corresponds to a **~512 KB snapshot** at the default
ratio (snapshot + an equal-sized tail), which is roughly **100–500
documents** at 1–5 KB/doc. Below a ~256 KB estimate a fold is 1–3 ms and
effectively free everywhere.

### When a fold fires, and when it defers

A fold is not run on every write. Two thresholds gate it, both checked
in-band on the write path (reads are pure and never trigger
maintenance):

- **Size-ratio trigger.** A fold fires only once the live tail has grown
  to `tail_bytes >= TARGET_RATIO × snapshot_bytes`. The default
  **`TARGET_RATIO = 1.0`**: the fold fires when the tail has grown to
  equal the snapshot. Below that, the tail is small enough that
  replaying it on reads is cheap, so folding would be wasted work.
- **Static fold-size ceiling `C`.** Even once the ratio trips, the fold
  defers if the estimated work exceeds `C`:
  `estimate = snapshot_bytes + tail_bytes > C` ⟹ skip. The default
  **`C = MAINTENANCE_MAX_FOLD_BYTES_DEFAULT = 512 KB`**, deliberately
  conservative (see below). It is overridable out-of-band by the
  `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` env var — see
  [Operations plane](#operations-plane-env-vars).

The ceiling is conservative on purpose. Cloudflare free's ~10 ms CPU can
*process* roughly a 1 MB estimate (~11 ms is already at the line) before
the isolate is killed; `C = 512 KB` (~5.5 ms) leaves margin, because
there is **no adaptive backoff** — a killed fold never reports its own
death — and the throughput model is only order-of-magnitude. Raising the
cap toward ~1 MB raises the snapshot envelope (next section) but moves
the fold closer to the kill cliff.

### The auto-maintained snapshot ceiling

Because a fold fires only once `tail = TARGET_RATIO × snapshot`, the
estimate at fold time is `snapshot × (1 + TARGET_RATIO)`. Inverting the
ceiling `estimate <= C` gives the largest snapshot that compaction will
ever keep folding automatically:

> **`S_max = C / (1 + TARGET_RATIO)`.**

At the defaults (`R = 1.0`, `C = 512 KB`) this is **`S_max = 256 KB` of
snapshot** ≈ **50–256 documents** at 1–5 KB/doc on Cloudflare free. A
collection whose snapshot grows past ~256 KB will trip the ratio,
produce an estimate over the 512 KB ceiling, and **permanently defer**
its fold — until the operator raises `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`
or graduates the tier. Note the asymmetry the estimate creates: a
**512 KB snapshot does not fold on the free-tier default** — at fold
time its estimate is ~1 MB, double the 512 KB ceiling.

#### The ratio/cost coupling

`TARGET_RATIO` is the one knob that trades three quantities against each
other:

| Quantity | As a function of ratio `R` | At the chosen `R = 1.0` |
|---|---|---|
| Auto-maintained snapshot ceiling | `S_max = C / (1 + R)` | `C / 2` (256 KB at C=512 KB) |
| Compaction write-amplification | `≈ 1 + 1/R` | ~2× |
| Read-amplification between folds | `≤ 1 + R` | ≤ 2× |

A higher ratio lets the tail grow longer before folding — cutting
write-amp but raising read-amp and *shrinking* the snapshot envelope
(`S_max` falls as `R` rises). LSM engines (Go's, RocksDB) commonly pick
`R = 2`, but they fold in place with no per-fold CPU cliff, so they can
afford the read-amp. Baerly trades the ratio directly against a hard
isolate-kill cliff, so it picks a **lower** ratio (`R = 1.0`) to widen
the snapshot envelope and halve read-amp, accepting a modestly higher
write-amp (~2×) — still comfortably under the cost-model's
**write-amp > 6** graduation trigger (see
[cost-model.md](cost-model.md#alternative-dbs-at-m-size)).

## Per-tier bounds

The fold ceiling below is stated as an **estimate** (snapshot + tail).
The default static ceiling `C = 512 KB` already sits *under* the free
tier's hardware wall — so on every tier the practical limit is `C`
(raisable via the env var), not the raw hardware budget. The hardware
walls are what `C` is sized against, and what bounds you to once `C` is
raised.

| Tier | Hardware wall | Binds on | What can actually fold |
|---|---|---|---|
| **Cloudflare free** | ~10 ms CPU / request (≈ 1 MB estimate) | **CPU** | default `C = 512 KB` estimate ⟹ **~256 KB snapshot** at R=1.0; the hardware cap (~1 MB estimate ⟹ ~512 KB snapshot) is where raising `C` hits the wall |
| **Cloudflare paid** | 30 s CPU default (up to 5 min); ~128 MB Worker memory | **memory** | raise `C` and fold to **~tens of MB snapshot** (~40 MB); CPU is *not* the wall — **memory** is |
| **Serverful Node** | none per-request; process RAM; a fold blocks the event loop | **host memory** | raise `C` and fold up to host memory — far above either Worker tier |

Reading the rows:

- **Cloudflare free tier.** The ~10 ms CPU-per-request budget can
  *process* a ~1 MB estimate before the isolate is killed, but the
  conservative default `C = 512 KB` caps folds well short of that. At
  `R = 1.0` that means an auto-maintained snapshot ceiling of **~256 KB**
  (`S_max = C / 2`). Past that, a fold's estimate exceeds `C` and the
  fold defers; if you raise `C` past what a ~10 ms isolate can fold, a
  dispatched fold is killed mid-pass (no corruption — the pointer just
  doesn't advance), so the log stops compacting and the bucket stops
  shrinking.
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
  logs, naming the deferred fold and its estimate vs. the ceiling.

It is erosion, not a cliff. You have time to act on the warning.

### Which graduation? (it depends on the host)

A deferred fold on Cloudflare free is a tier signal; the *same* deferred
fold on a Node host is just an env var to flip; and neither is a
Postgres signal. Disambiguate before you act:

> **Cron does *not* help.** Running `runScheduledMaintenance` on a
> schedule does not escape the wall on Cloudflare free: a
> cron-triggered (scheduled) Worker has the **same ~10 ms CPU limit** as
> a request handler. Cron gives you a fresh CPU budget per tick, not a
> *bigger* one — and the thing that is too small is the CPU ceiling
> itself. Only the paid plan raises that ceiling (or, on Node, raising
> the env cap). Cron is not the lever.

### 1. Off Cloudflare free → Cloudflare paid

**This is the graduation a persistently-deferring collection on CF free
points at.**

**Threshold:** the auto-maintained snapshot ceiling, **~256 KB snapshot
/ ~50–256 docs** at the `R = 1.0`, `C = 512 KB` defaults (the fold's
estimate crosses `C`).

**What you'll observe:** the erosion symptoms above — slower reads, a
growing bucket, a `console.warn` — because free-tier folds defer rather
than burn past the ~10 ms CPU budget.

**What to do:** upgrade to the Cloudflare **paid** Workers plan (a
~$5/mo plan upgrade; 30 s CPU vs. free's ~10 ms). On paid the CPU cliff
effectively disappears — 30 s would fold a multi-GB snapshot — and the
binding wall becomes Worker **memory** (~128 MB ⟹ ~tens of MB snapshot).
After upgrading, raise `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` past the
512 KB default so folds are no longer gated by the conservative ceiling;
compaction resumes. See the
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

### A caveat: tail churn is fold cost, not data growth

The fold estimate (`snapshot + tail`) is the right number for *cost* —
you parse the whole tail even when it is mostly `U`/`D` entries that
collapse to a handful of `_id`s. So a **small but heavily-updated**
collection (say, 50 docs hammered by updates) can build a large tail,
trip the ceiling, and warn — even though the fold's *output* snapshot
stays tiny. This is **tail churn (fold cost), not data growth.** Such a
collection folds fine the moment it gets a pass, and its snapshot stays
small afterward. Do **not** read the warning as "my data is too big" and
do not treat it as a trigger-3 Postgres signal; it is purely about the
CPU cost of one fold pass.

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
| `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` | Overrides the static fold ceiling `C` (default `MAINTENANCE_MAX_FOLD_BYTES_DEFAULT = 512 KB`). Raises `S_max = C / (1 + R)`, letting larger folds past the gate. | On Cloudflare **paid** or a big **Node** host, after you've confirmed the host can fold that estimate. |
| `BAERLY_MAINTENANCE_DISABLE` | Kill switch — turns in-band maintenance off entirely. | Diagnostics, or to stop fold attempts on a deferring collection while you plan a graduation. |

**Cloudflare caveat — sizing the cap.** Raising
`BAERLY_MAINTENANCE_MAX_FOLD_BYTES` above what a CF isolate can actually
fold re-opens a **killed-fold loop**: the gate passes, the fold is
dispatched in `ctx.waitUntil`, the isolate is then killed by the CPU or
memory wall, and there is **no in-band backoff** — the fold never
reports its own death, so the next write tries again. On Cloudflare,
prefer **upgrading the plan tier** over raising the cap past what the
isolate can fold. And note that on CF **paid** the wall is ~128 MB
*memory*, not the 30 s *CPU* operators tend to reason about — size the
cap to **memory**, not CPU.

## How to read your tier

`baerly inspect <collection>` reports the current snapshot size **and**
the log-tail size; `baerly admin usage` reports writes/min against the
M-size ceiling. The number that decides whether folds keep running is
the **estimate** (`snapshot + tail`), so check both: a small snapshot
with a large tail is still a large fold (see
[tail churn](#a-caveat-tail-churn-is-fold-cost-not-data-growth)).
Compare the snapshot against the
[auto-maintained ceiling](#the-auto-maintained-snapshot-ceiling)
(~256 KB at the defaults) and the estimate against `C` / the
[per-tier table](#per-tier-bounds) to know which tier you're in and how
much headroom remains before the next graduation.

## See also

- [cost-model.md](cost-model.md) — the cost (Class A ops, write-amp,
  stored bytes) side of the same graduation cliff.
- [thesis.md](thesis.md#workload-ceiling) — why the envelope is
  published precisely and why graduation is the success path.
- [adr/004-ephemeral-coordination.md](../adr/004-ephemeral-coordination.md)
  — why graduation is mechanical: there's no stateful coordinator to
  migrate away from, so the bucket plus the log shape are the entire
  handoff to Postgres.
