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

A fold touches roughly **2–3× the snapshot size** in memory (old
snapshot + a log tail of about one snapshot + the new snapshot) and
does, per the steps above, two JSON parses, one JSON stringify, and two
SHA-256 passes — call it ~3× the snapshot through JSON and ~2× through
SHA-256.

Using **order-of-magnitude** engine assumptions — JSON parse/stringify
at roughly 300 MB/s, SHA-256 at roughly 2 GB/s — this lands at:

> **≈ 11 ms of CPU per MB of snapshot.**

Treat the throughput numbers as order-of-magnitude, not benchmarks. A
2–3× swing in the JSON assumption moves the free-tier ceiling between
roughly 0.4 MB and 1.5 MB of snapshot — but the *shape* (linear in
snapshot size, dominated by JSON, ~10 ms/MB) is robust.

### Snapshot size → CPU per fold

| Snapshot size | CPU per fold (order-of-magnitude) | Note |
|---|---|---|
| 64 KB | ~0.7 ms | trivial |
| 256 KB | ~2.8 ms | trivial — under the free-tier line by 3–4× |
| 1 MB | ~11 ms | ≈ Cloudflare **free-tier** CPU line |
| 5 MB | ~55 ms | fine on paid |
| 40 MB | ~440 ms | CPU fine on paid, but ≈ the **memory** wall |

A snapshot of ~1 MB is roughly **200–1000 documents**, depending on
per-doc size (1–5 KB/doc). Below ~256 KB a fold is 1–3 ms and
effectively free everywhere.

## Per-tier bounds

| Tier | Hard limit | Binds on | Fold ceiling |
|---|---|---|---|
| **Cloudflare free** | ~10 ms CPU / request | **CPU** | **~1 MB snapshot** (~hundreds of docs at 1–5 KB/doc) |
| **Cloudflare paid** | 30 s CPU default (up to 5 min); ~128 MB Worker memory | **memory** | **~tens of MB snapshot** (~40 MB) — CPU is *not* the wall |
| **Serverful Node** | none per-request; process RAM; a fold blocks the event loop | **host memory** | host memory — far above either Worker tier |

Reading the rows:

- **Cloudflare free tier.** The ~10 ms CPU-per-request budget puts the
  fold ceiling at ~1 MB of snapshot. Past ~1 MB, a fold is killed
  mid-pass (no corruption — the pointer just doesn't advance), so the
  log stops compacting and the bucket stops shrinking.
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

Three thresholds, in the order you'll hit them as a collection grows.
Each pairs *what you'll observe* with *what to do*.

### 1. Free → paid Cloudflare

**Threshold:** a collection's snapshot approaches **~1 MB / ~hundreds
of docs**.

**What you'll observe:** reads and writes still work, but free-tier
compaction starts failing to fit in the ~10 ms CPU budget. The log
stops getting folded into the snapshot, so the live log tail grows, and
read latency creeps up (readers replay an ever-longer tail on top of
the stale snapshot). Nothing is corrupted; the bucket just stops
shrinking.

**What to do:** move to the Cloudflare **paid** tier. The 30 s CPU
budget swallows folds far larger than 1 MB, and compaction resumes.

### 2. Paid serverless → serverful Node

**Threshold:** a snapshot approaches **~tens of MB**.

**What you'll observe:** on paid Cloudflare, folds start running into
the **~128 MB Worker memory** limit — the fold can't hold the old
snapshot + new snapshot + log tail resident at once. The CPU budget is
still fine; memory is what binds.

**What to do:** move the collection to a long-lived **Node host** (no
per-request memory or CPU cap — bounded only by host RAM), or await the
chunked-snapshot follow-up. The single-level snapshot today (one
snapshot replaces the prior, `compactor.ts:23`–`33`) has a key format
that is forward-compatible with a future multi-level (L0..L9) chunked
scheme that folds incrementally rather than rewriting the whole
snapshot in one pass — which would lift this memory wall without a wire
change.

### 3. The kernel's stated audience envelope

Independent of the per-fold compute bounds above, the kernel publishes
a workload envelope. Crossing any of these is the signal to graduate to
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

## How to read your tier

`baerly inspect <collection>` reports the current snapshot size and log
state; `baerly admin usage` reports writes/min against the M-size
ceiling. Cross-reference the snapshot size against the
[per-tier table](#per-tier-bounds) above to know which tier you're in
and how much headroom remains before the next graduation.

## See also

- [cost-model.md](cost-model.md) — the cost (Class A ops, write-amp,
  stored bytes) side of the same graduation cliff.
- [thesis.md](thesis.md#workload-ceiling) — why the envelope is
  published precisely and why graduation is the success path.
- [adr/004-ephemeral-coordination.md](../adr/004-ephemeral-coordination.md)
  — why graduation is mechanical: there's no stateful coordinator to
  migrate away from, so the bucket plus the log shape are the entire
  handoff to Postgres.
