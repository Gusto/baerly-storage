---
title: Cost model
audience: product
summary: Per-line-item rates, write-amp meter, compression posture.
last-reviewed: 2026-06-15
tags: [cost, pricing, operations]
related: [pricing-log.md, thesis.md, graduation.md]
---

# Cost model

Baerly's pricing posture in one page. The unindexed first-try insert
baseline is three Class A R2 ops (content body + log entry +
`current.json` CAS-advance); deletes are cheaper, while indexes,
retries, and first-collection provisioning add bounded ops. Reads emit
Class B ops at a rate that depends on cache hits. The companion file
[pricing-log.md](pricing-log.md) is the one-line-per-change
history of every price or cap update.

All prices below were re-checked **2026-06-15** against the official
[Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
and
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
pages. Re-check before quoting any figure externally; bumps land in
[pricing-log.md](pricing-log.md) on the day they ship.

## Per-line-item rates (Cloudflare R2 + Workers)

R2 storage and ops dominate; Worker CPU and request counts are
secondary at the M-size operating point.

| Line item | Rate | Free tier |
|---|---|---|
| R2 storage | $0.015 / GB-mo | 10 GB-mo |
| R2 Class A ops (`PutObject`, `CopyObject`, `ListObjects`, multipart) | $4.50 / 1M | 1M / mo |
| R2 Class B ops (`GetObject`, `HeadObject`) | $0.36 / 1M | 10M / mo |
| R2 `DeleteObject` | $0 | unlimited — delete cleanup is not the bill driver |
| R2 egress to internet | $0 | unlimited |
| Worker requests (Workers Paid) | $0.30 / 1M | 10M / mo (paid plan) |
| Worker CPU-ms (Workers Paid) | $0.02 / 1M | 30M / mo (paid plan) |
| Workers Paid plan floor | $5 / mo | — |

Class A is the meter that matters. Three reasons:

1. **Highest unit cost of the high-volume items** ($4.50 / 1M vs.
   Class B at $0.36 / 1M vs. Worker requests at $0.30 / 1M).
2. **Write-amplified by the protocol** — an unindexed first-try insert
   produces 3 Class A ops, so Class A grows fastest with traffic.
3. **Compaction storms hit it** — a runaway compaction job still does
   PUT / LIST / CAS work; free `DeleteObject` calls are not the bill
   driver.

`baerly cost --bucket=<bucket-uri> --collection=<collection>`
projects the Class A ops/mo, free-tier-aware dollar projection, and
distance to the M-size ceiling + 50M/mo graduation trigger. That
covers the day-1 cost-verification moment without wiring an external
sink. For longer windows (7-day, 30-day) operators pipe the canonical
log line to CloudWatch / Workers Analytics / Datadog — see
[`docs/guide/observability.md`](../guide/observability.md).

## Cost ceiling

Baerly commits to a published, architecturally-enforced ceiling so
the cost line is bounded, not best-effort. Two bounds, both
verified in CI:

- **Small constant storage ops per logical write.** The unindexed
  first-try insert baseline is PUT content, PUT log entry, and
  CAS-advance `current.json`. Deletes can be cheaper; indexes,
  retries, and first-collection provisioning add bounded mutations.
  Snapshot writes amortize across many log entries and are paid by
  the compactor, not the writer. The
  `db.write.class_a_ops_per_logical_write` histogram is **emitted**
  on every commit (verified in CI by `writer.test.ts`); operators
  who pipe it to a metrics sink can alert when p99 exceeds ~5; that
  threshold is a recommendation, not a shipped or CI-gated check.
- **`< 1 Class A op / writer / hour` for idle readers.** Real
  expectation is exactly zero — readers walk `current.json` plus the
  snapshot plus the live-tail log via deterministic GETs, never
  LIST.

### Maintenance is write-driven; reads are pure

The idle-reader bound holds because **maintenance ticks only on
the write path** — a read does zero maintenance work
([ADR-004](../adr/004-ephemeral-coordination.md),
[graduation.md](graduation.md)). The cost consequences:

- **A read-only bucket pays a bounded ≤ ~1× tail replay per read
  *while folds succeed*.** At the default `TARGET_RATIO = 1.0` the
  live tail stays within ~1× the snapshot, so a reader replays at
  most about one snapshot's worth of log entries on top of the
  snapshot. Above `S_max` (the snapshot ceiling `C` / `E`) the
  fold defers and the **tail grows unbounded** — read cost climbs
  with every write since the last fold. That is the graduation
  cliff, not steady state.
- **An over-ceiling bucket defers ~free.** The defer decision is a
  zero-storage-op projection over `current.json` already in scope,
  so a deferring collection adds no Class A ops beyond its normal
  writes (plus the rate-limited graduation `console.warn`).
- **Inline-Node fold latency is I/O-dominated, not CPU-dominated.**
  A fold's wall-clock is roughly
  `⌈tail / MAX_PARALLEL_LOG_READS⌉` storage round-trips (the
  log-tail GETs are already issued concurrently, capped at
  `MAX_PARALLEL_LOG_READS = 16`); the snapshot ceiling bounds
  CPU/memory, **not** the round-trip count. A future serverful
  post-response dispatch would move this off the write's critical
  path entirely.
- **Node worst case = a fold *plus* a full GC pass on one write.**
  Node runs `phasesPerTick: "both"`, so a single boundary-crossing
  write can pay both a fold slice and a GC pass. The combined cost
  is a bounded p99 latency spike that scales with the moderate,
  latency-budgeted `NODE_MAINTENANCE_*` caps (fold 200 / marks 200
  / sweeps 100). Budget for the **combined** number, not the fold
  alone; a future post-response dispatch removes the spike.
- **Seed-then-idle orphan residual (a named envelope boundary).**
  A bucket bulk-seeded (e.g. `admin restore`) and then left idle
  within the 7-day GC grace window carries a **bounded,
  never-reclaimed orphan pile**: reads are pure, so with no further
  writes nothing ticks and `runGc` never re-runs to sweep the
  marked orphans. This is **irreducible under reads-pure**, bounded
  by the import size, and reclaimed on demand by the opt-in
  `runScheduledMaintenance` SDK. It is a known boundary of the
  in-band model, not a leak.

Why a published ceiling? Two failure modes shape it:

1. **The idle case.** A deployed app with one daily writer and a
   handful of pollers should be free on R2 and effectively free on
   S3. One Class A op per poll destroys that economics inside a day.
2. **The small-workload case.** A ~100-MAU helpdesk app should cost
   single-digit dollars per month. The per-write op count must be a
   bounded small constant — not something that grows with table
   size, snapshot depth, or history.

Without architectural enforcement the protocol drifts: a new feature
adds a poll here, a LIST there, and the cost line creeps upward with
no single regression to point at. The ceiling is a gate, not a
target — `tests/integration/phase5-end-to-end.test.ts` wraps
`Storage` with a counting proxy and gates on
`expect(classAOps).toBeLessThan(1)` after 1800 polls (one hour at
2 s cadence). The `CLOUDFLARE_FREE_TIER` profile in
`packages/server/src/maintenance.ts` carries the bounded-tick
budget arithmetic (engine defaults are unbounded, so a Node
caller just passes `{}`); `maintenance.budget.test.ts` proves a
single maintenance pass under the Cloudflare free-tier profile sits
under the 50-subrequest cap.

Per-collection CAS scope (see
[`docs/spec/sync-protocol.md`](../spec/sync-protocol.md)) is what makes
the idle-poll bound tractable: one cheap key per collection rather
than contention on a global mutex.

## Compression off by default in `@gusto/baerly-storage/client`

The `@gusto/baerly-storage/client` HTTP client defaults `compression: false`.

**Why.** The dominant Baerly deploy shape is a Cloudflare Worker
talking to R2 in the same data center. That path is CPU-constrained
(Worker CPU-ms is the metered resource on Workers Paid) and the
intra-DC R2 link has zero egress cost. On-the-wire gzip in that
shape spends Worker CPU-ms to save zero billable bytes — strictly
worse on the metered axis. The same argument applies to the
self-hosted Node deploy when the Node process and the bucket sit in
the same network (the typical hosted Minio / on-prem Ceph case).

**When to flip it on.** The trade-off inverts for the
BYO-Node-to-remote-bucket shape — a Node process running outside
the bucket's network where every read or write crosses a paid
egress link. In that shape, compression on the wire shrinks
billable bytes at the cost of local CPU (cheap on a long-running
Node process compared to a per-request Worker isolate). Users
running that shape should set `compression: true` on the client.

**Default.** `false`. Single-line override on the client config.

This decision is logged at [pricing-log.md](pricing-log.md)
when it ships in `@gusto/baerly-storage/client`.

## Two operating points, two stories

The cost story breaks cleanly along the workload-shape axis the
thesis targets. Comparing Baerly to managed DBs at a single
operating point is misleading — the same protocol that wins at
idle and across portfolios is what loses on per-write unit cost
at the graduation cliff. We grade at both.

### At the audience operating point: idle × N portfolio

The thesis's [audience-in-practice](thesis.md#audience-in-practice)
section names a population, not a single app: forty internal
tools, a Saturday side project that might be abandoned, a finance
team's Claude Artifact, a $20/mo ChatGPT subscriber's dream. For
this population, **the per-app floor is the cost line, not the
per-write rate.** Costs at N=30 mostly-idle apps (a realistic
internal-tools fleet at a 10,000-person company):

Every cell below is on the **same N=30 basis** so the columns are
comparable. Where a provider has a non-zero per-app floor that is
usage-based or per-project rather than a single flat fee, the N=30
figure is shown as a **per-app basis × 30 estimate** (marked
*est.*), derived from that provider's documented per-app floor —
not a hard total we assert as fact. Per-project floors of $0 stay
$0 at any N. Re-check the per-app floors before quoting any total
externally.

| Service | Cost at N=30 idle apps | Notes |
|---|---|---|
| **Baerly (Cloudflare)** | **~$5/mo** | One Workers Paid floor amortized across all N apps (paid once, not ×30). Class A/B ops effectively zero at idle (`< 1 op/writer/hour`, [CI-gated](#cost-ceiling)). |
| **Baerly (self-hosted Node)** | **$0/mo** (your hardware) | No platform floor; idle is free against any S3-API bucket. |
| Cloudflare D1 | ~$5/mo | Same single Workers Paid floor amortized across all N apps; ties Baerly here, **but only if all N apps are Workers-native**. `wrangler d1 export` gives a SQL dump, but leaving is a dump-and-reload migration, not a zero-cooperation exit. |
| Supabase Free | $0 | Two free projects per org; not a fleet posture for N=30. |
| Supabase Pro | ≈ $25/app × 30 ≈ **~$750/mo** *(est.)* | Paid plans bill per project (each carries its own always-on Postgres compute), so a 30-app fleet pays ~30 per-project floors. Derived from the documented ~$25/project Pro floor; usage on top varies. |
| Neon Launch | ≈ $5/app × 30 ≈ **~$150/mo** *(est.)* | Usage-based with no monthly minimum and scale-to-zero, but each intermittently-awake app still meters CU-hours; ~$5/app is a typical small-app monthly figure, so a 30-app fleet lands near ~$150/mo. Varies with how often each app wakes. |
| Firebase Spark | $0 while inside no-cost Firestore quotas | Official quota is 1 GiB stored, 20k writes/day, 50k reads/day, 20k deletes/day, **per project** — a 30-app fleet can stay $0 only while every app stays inside quota. |

The idle × portfolio multiplier is where Baerly's "rounds to zero"
property does its real work. A team with 30 internal tools doesn't
pay 30 platform floors — they pay one (or zero, on self-hosted
Node). That's not a moat against D1 specifically; it's what makes
the workload class economically viable at all. The alternative
for most of these apps isn't "another database" — it's **the
experiment doesn't happen** and the data stays in a Google Sheet.

### At the graduation cliff: M-size and above

Past the workload ceiling, you have crossed the design center on
purpose — the per-write economics flip, and that flip is the
signal to graduate. The "Alternative DBs at M size" table below
grades Baerly against the systems users should *graduate to*, not
the systems they should be running on long-term. D1 wins per-write
where it's available; managed Postgres wins above L.

## Alternative DBs at M size

The M-size operating point is ~100 MAU, 10 000 docs, ~24 000
writes/day (~50/min over an 8-hour workday), ~480 000 reads/day,
100 MB stored. Baerly's modelled monthly cost there is ~$19 — the
$5 Workers Paid floor plus R2 Class A/B ops dominate. Rough
1-decimal comparisons at the same workload:

| Service | Plan | $/mo | Notes |
|---|---|---|---|
| **Baerly (this design)** | Workers Paid | **~$19** | R2 Class A/B dominate. |
| Cloudflare D1 | Workers Paid | ~$5 | M is way under D1's 25B reads / 50M writes free tier; just the plan floor. SQL trade-off is on you. |
| Supabase Free | Free | $0 | Fits storage, but the free plan is not a production fleet posture. |
| Supabase Pro | $25 base | ~$25 | Always-on Postgres + Auth + Storage. Roughly parity with Baerly + opt-in realtime. |
| Neon Launch | usage-based | ~$15 typical intermittent small app | Scale-to-zero helps for bursty traffic; CU-hours add up if continuous. |
| Firebase Blaze | PAYG | ~$5 *(approx.)* | 14.4M reads × $0.03/100k ≈ $4.30 + 720k writes × $0.09/100k ≈ $0.65 ≈ ~$5. Roughly Baerly ÷ 4 — cheaper per-op at M. Rates: Firestore Standard, us-central1; re-check before quoting. |
| Firebase Spark | Free | $0 if under 50k reads/day; M's 480k/day blows the no-cost read quota. |

Read this as positioning, not a cost claim:

- **XS / S workloads:** Baerly is decisively cheaper than any
  always-on managed DB, especially across a portfolio — see the
  [idle × portfolio table](#at-the-audience-operating-point-idle--n-portfolio).
  The differentiator is both *what* you get (schemaless docs,
  multi-instance causal consistency, bytes-in-your-bucket) AND
  the price.
- **M workload:** Baerly (~$19) is ~4× more expensive than D1
  (~$5) **where D1 is available** — and D1 is Workers-runtime-only:
  `wrangler d1 export` gives a SQL dump, but there's no
  bucket-native data layer or live CDC handoff, so leaving is a
  dump-and-reload migration, not the bytes-already-in-your-bucket,
  zero-cooperation exit Baerly offers. Off-Workers (AWS, on-prem, self-hosted Node,
  any environment that doesn't tolerate Cloudflare lock-in),
  managed Postgres at $25+/mo behind a vendor's managed catalog
  is the relevant comparison. A user willing to accept
  Cloudflare lock-in and a SQL schema should **switch to D1** —
  it's strictly cheaper, and [that move is the success path,
  not a churn event](thesis.md#what-prototype-tier-storage-needs).
  Firebase Blaze is also cheaper than Baerly on raw per-op at M
  (~$5 vs. ~$19, recomputed above) — but the argument here was
  never "Baerly is cheapest per-op." It's idle × portfolio,
  portability, and availability; on a per-op basis at M, both D1
  and Firebase undercut Baerly, and that's expected — M is past
  the design center.
- **L workload:** Baerly's R2 Class B alone (~$1 500) costs more
  than a Postgres Pro plan — read-heavy traffic on a per-doc
  fan-out protocol is disproportionately expensive vs. a B-tree
  lookup in a real DB. Reaching that price line is the success
  signal to graduate.
- **Portability / switching cost:** This axis favors Baerly
  across all workload sizes. Object storage is the rare primitive
  with a common dialect — the S3 API — that S3, R2, and MinIO all
  speak with the conditional-write (CAS) semantics Baerly's
  coordination requires; those are the stores the CAS contract is
  proven against and that `baerly doctor --bucket` gates on (see
  [ADR-004](../adr/004-ephemeral-coordination.md)). Azure Blob
  speaks a non-S3 dialect and GCS's S3-interop endpoint exposes
  conditional writes as read-only, so both need a dedicated
  adapter that doesn't exist yet. The portability point still
  holds where it counts: your bytes live in your bucket and
  leaving needs no vendor cooperation. D1, Supabase, Neon, and Firebase are
  excellent, but they are proprietary runtimes — choosing one is
  a switching-cost decision. Even at M-size where D1 wins on
  raw per-write price, the portability axis sits orthogonal to
  price and should be weighed alongside it.

Cost is decisive in the regimes Baerly is sized for; it's
designed to lose past them — that loss is the graduation signal,
mechanical via `baerly export --target=postgres --collection=<name>`
(per collection). We name three
axes explicitly: per-write price (where Baerly loses at M-size),
idle × portfolio cost (where it wins decisively), and
portability / switching cost (where it wins on every workload).
The workload class the thesis targets (idle × portfolio, XS/S
experimentation, large internal-tools fleet) isn't economically
viable under per-app managed-DB floors — and that's where the
real argument lives.

The graduation triggers follow directly: any one of (sustained over 7
days) R2 Class A ops > 50M/month, effective write-amp > 6, or stored
data > 5 GB is the system telling the user they have outgrown the
ceiling. Today the `baerly cost` projection's `percentOfGraduation`
tracks only the **Class A** trigger (the 50M ops/month line); the
write-amp and stored-data triggers are documented targets but are not
yet surfaced by the tooling.
