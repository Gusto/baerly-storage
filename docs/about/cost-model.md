---
title: Cost model
audience: product
summary: Per-line-item rates, write-amp meter, compression posture.
last-reviewed: 2026-06-23
tags: [cost, pricing, operations]
related: [pricing-log.md, thesis.md, workload-fit.md, graduation.md]
---

# Cost model

baerly-storage's pricing posture in one page. The unindexed first-try insert
**commit floor** is two Class A R2 ops (content body + the committing
`log/<seq>` create — that create-if-absent IS the commit; there is no
`current.json` write on the commit path) — in-band maintenance raises
the *effective* Class A write-amplification to ~3× on Cloudflare / ~4×
on serverful Node (see the Cost-ceiling section below); deletes are
cheaper, while indexes, retries, and first-collection provisioning add
bounded ops.
Reads emit Class B ops at a rate that depends on cache hits — including
the tail forward-probe, which is Class B GETs and never Class A. The
companion file
[pricing-log.md](pricing-log.md) is the one-line-per-change
history of every price or cap update.

All prices below were re-checked **2026-06-22** against the official
[Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
and
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
pages. Re-check before quoting any figure externally; bumps land in
[pricing-log.md](pricing-log.md) on the day they ship.

## Per-line-item rates (Cloudflare R2 + Workers)

R2 storage and ops dominate; Worker CPU and request counts are
secondary at the M-size operating point.

| Line item                                                            | Rate           | Free tier                                         |
| -------------------------------------------------------------------- | -------------- | ------------------------------------------------- |
| R2 storage                                                           | $0.015 / GB-mo | 10 GB-mo                                          |
| R2 Class A ops (`PutObject`, `CopyObject`, `ListObjects`, multipart) | $4.50 / 1M     | 1M / mo                                           |
| R2 Class B ops (`GetObject`, `HeadObject`)                           | $0.36 / 1M     | 10M / mo                                          |
| R2 `DeleteObject`                                                    | $0             | unlimited — delete cleanup is not the bill driver |
| R2 egress to internet                                                | $0             | unlimited                                         |
| Worker requests (Workers Paid)                                       | $0.30 / 1M     | 10M / mo (paid plan)                              |
| Worker CPU-ms (Workers Paid)                                         | $0.02 / 1M     | 30M / mo (paid plan)                              |
| Workers Paid plan floor                                              | $5 / mo        | —                                                 |

> **Note on AWS S3 free tier:** AWS S3's 12-month free tier no longer
> applies to new accounts (credit-based since 2025). The
> self-hosted-Node "idle is free on S3" claim holds only for existing
> or paid accounts, or for workloads inside a bucket you already own
> on a paid plan.

Class A is the meter that matters. Three reasons:

1. **Highest unit cost of the high-volume items** ($4.50 / 1M vs.
   Class B at $0.36 / 1M vs. Worker requests at $0.30 / 1M).
2. **Write-amplified by the protocol** — an unindexed first-try insert
   produces 2 Class A ops at the commit floor (effective ~3× on
   Cloudflare / ~4× on Node with in-band maintenance — see Cost
   ceiling), so Class A grows fastest with traffic.
3. **Compaction storms hit it** — a runaway compaction job still does
   PUT / LIST / CAS work; free `DeleteObject` calls are not the bill
   driver.

`baerly cost --bucket=<bucket-uri> --collection=<collection>`
projects the Class A ops/mo, free-tier-aware dollar projection, and
distance to the advisory line (~100 writes/min; ~$54/mo R2
object-storage ops) and the 50M/mo hard graduation trigger. The projection uses the **measured effective
write-amp** (≈3× on R2/Cloudflare, ≈4× on S3/Node), not the 2-op
commit floor — so the estimate includes the in-band maintenance ops
that are incurred on the write path. That covers the day-1
cost-verification moment without wiring an external sink. For longer
windows (7-day, 30-day) operators pipe the canonical log line to
CloudWatch / Workers Analytics / Datadog — see
[`docs/guide/observability.md`](../guide/observability.md).

## Cost ceiling

baerly-storage commits to a published, architecturally-enforced ceiling so
the cost line is bounded, not best-effort. Two bounds, both
verified in CI:

- **Small constant storage ops per logical write (commit floor: 2
  Class A ops).** The unindexed first-try insert baseline is PUT
  content + the committing `log/<seq>` create (two Class A ops —
  the **commit floor**; the create-if-absent IS the commit, so there
  is no `current.json` write on the commit path — down from three).
  Deletes can be cheaper; indexes,
  retries, and first-collection provisioning add bounded mutations.
  Snapshot writes amortize across many log entries and are paid by
  the compactor, not the writer. The
  `db.write.class_a_ops_per_logical_write` histogram is **emitted**
  on every commit (verified in CI by `writer.test.ts`); operators
  who pipe it to a metrics sink can alert when p99 exceeds ~5; that
  threshold is a recommendation, not a shipped or CI-gated check.
- **Effective Class A write-amplification is ~3× on Cloudflare, ~4×
  on serverful Node — not the 2-op commit floor above.** The commit
  path is two Class A ops (content PUT + `log/<seq>` create), but
  in-band maintenance (folds + GC) is triggered on the write path
  and adds ~1 Class A op/write on the cf-free profile and ~2 on Node
  (Node's `gcInterval=2` vs cf's `4` doubles the GC LISTs; each GC
  pass is 3 LIST + 1 PUT, each fold is 2 PUT). Measured empirically
  — see
  `docs/spec/attachments/amortized-write-cost-baseline.json`
  (`pnpm bench:amortized-write-cost`) and gated by
  `tests/integration/write-amp.test.ts`. `DeleteObject` (the GC
  sweep) is $0 on R2/S3 and is excluded from this count.
- **`< 1 Class A op / writer / hour` for idle readers.** Real
  expectation is exactly zero — readers walk `current.json` plus the
  snapshot plus the live-tail log via deterministic GETs, never
  LIST. The tail forward-probe (GET from
  `max(log_seq_start, tail_hint)` — normally `tail_hint` — to the first
  404) is Class B, so tail discovery never touches the Class A meter
  and the idle-reader bound is untouched. The one read-path
  Class A cost: an **indexed `.where()` issues one `ListObjects`
  (Class A) per equality value** (`$in` ⇒ N calls) to walk the index
  prefix and resolve matching `_id`s. The default fold path (full
  scan over snapshot + tail) is zero Class A.

### Maintenance is write-driven; reads are pure

The idle-reader bound holds because **maintenance ticks only on
the write path** — a read does zero maintenance work
([ADR-004](../adr/004-ephemeral-coordination.md),
[graduation.md](graduation.md)). The cost consequences:

- **A read-only bucket pays a bounded ≤ ~1× tail replay per read
  _while folds succeed_.** At the default `TARGET_RATIO = 1.0` the
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
- **Node worst case = a fold _plus_ a full GC pass on one write.**
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
target — `tests/integration/maintenance-e2e.test.ts` wraps
`Storage` with a counting proxy and gates on
`expect(classAOps).toBeLessThan(1)` after 1800 polls (one hour at
2 s cadence). The `CLOUDFLARE_FREE_TIER` profile in
`packages/server/src/maintenance.ts` carries the bounded-tick
budget arithmetic (engine defaults are unbounded, so a Node
caller just passes `{}`); `maintenance-budget.test.ts` proves a
single maintenance pass under the Cloudflare free-tier profile sits
under the 50-subrequest cap.

Per-collection commit scope (see
[`docs/spec/sync-protocol.md`](../spec/sync-protocol.md)) is what makes
the idle-poll bound tractable: one cheap log series and one compaction
bookmark per collection rather than contention on a global mutex.

## Cost curve: theoretical $/mo by write rate

### Ops-vs-cost tradeoff

Object storage buys you **zero ops / no on-call** — there is no DB
process to provision, patch, or page about. A managed relational DB
trades dollars for that operational burden: you get a richer query
model and a dedicated server, but you pay a per-project floor and you
own the on-call rotation. At low write rates baerly-storage is
essentially free; as write rates climb into the M-size range and
above, the per-request billing of object-storage Class A ops compounds
with the protocol's effective write-amplification, and the bill becomes
real money. That cost is the graduation signal — it tells you the
workload has grown to where a managed DB's operational tradeoff makes
sense and the `baerly export` path is waiting.

### Formulas (June-2026 rates)

These are the formulas the `baerly cost` CLI projection is built on.
`W` is monthly logical writes (write operations, not documents).
All figures use the measured effective write-amplification, not the
two-op commit floor.

**Cloudflare R2 path** (effective write-amp ≈ 3×):

```
Class A ops/mo         = W × 3
R2 object-storage $/mo = max(0, W×3 − 1,000,000) × $4.50 / 1,000,000
                       + max(0, storedGB − 10) × $0.015
                       + Class B reads (typically minor at M-size)
```

This is the **object-storage ops** projection `baerly cost` reports:
R2 ops are billed above 1M Class A/mo, storage above 10 GB/mo. The $5/mo
**Workers Paid** plan is a separate Cloudflare _platform_ floor — not an
R2 charge, and absent on self-hosted Node, R2-over-the-S3-API, or the
Workers free tier — so `baerly cost` does not fold it into the
projection; add ~$5/mo for the all-in figure when you deploy on Workers
Paid. At write rates that keep Class A under 1M/mo (roughly ≤ 7 writes/min
sustained) the object-storage ops cost is $0 and the only charge is the
Workers Paid floor, if it applies.

**AWS S3 / self-hosted Node path** (effective write-amp ≈ 4×, no free tier):

```
Class A ops/mo = W × 4
S3 $/mo = W×4 × $5.00 / 1,000,000
        + storedGB × $0.023
        + Class B reads (typically minor at M-size)
```

No free tier and no flat floor: every write costs linearly from zero.
At steady state S3 is roughly **50% costlier than R2** per write —
$20 vs $13.50 per million logical writes (4 × $5.00/1M vs
3 × $4.50/1M) — driven by the higher write-amp (4× vs 3×) and the
higher per-op rate. The gap is wider at low volume, where R2's
1M-op/mo free tier still applies and S3 has none. The 12-month
new-account free tier was retired in 2025; these figures apply to
paid accounts.

### Cost-vs-scale table

Representative write rates and their projected monthly costs.
Figures are **object-storage ops only** (storage and Class B reads are
minor until L-size read fan-out and are excluded from these rows), and
exclude the $5/mo Workers Paid platform floor — add it for the all-in
cost on Cloudflare Workers Paid. These figures are what `baerly cost`
projects. Storage: assume ~100 MB for S-size, scaling proportionally.

| Writes/min (sustained, account-wide) | Class A/mo (R2, ×3) | R2 $/mo (object-storage ops) | Class A/mo (S3, ×4) | S3 $/mo (object-storage ops) | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | 130k | $0 | 173k | ~$0.86 | Inside R2 free tier (1M/mo) |
| 10 | 1.3M | ~$1 | 1.7M | ~$9 | R2: small Class A overage (+ $5 Workers Paid floor) |
| **30 (M-size)** | **3.9M** | **~$13** | **5.2M** | **~$26** | **~$18/mo all-in on R2 incl. floor — see M-size breakdown below** |
| **100** | **13.0M** | **~$54** | **17.3M** | **~$86** | **Advisory crossing: `baerly cost` prints eyes-open advisory** |
| 390 | 50.5M | ~$223 | 67.4M | ~$337 | ≈ 50M Class A/mo R2 graduation trigger |
| 1000 | 129.6M | ~$579 | 172.8M | ~$864 | Well past graduation |

The 390 writes/min row is the 50M Class A/mo graduation trigger at the
measured R2 write-amp (3×) — where `baerly cost`'s trajectory line
crosses 100% of the 50M graduation trigger. At that rate R2 costs
**~$223/mo** and S3 **~$337/mo** (object-storage ops), confirming that
line is "real money" and a meaningful graduation signal. S3 reaches the
same 50M op envelope at ~290 writes/min (4× amp).

### M-size $/mo breakdown

The M-size operating point is a **sustained** ~30 writes/min. In this cost-curve table
that is an **account-wide aggregate** rate (Class A is billed per
account, not per collection); it numerically coincides with — but is a
different axis from — the **per-collection** CAS-contention ceiling
`M_SIZE_WRITES_PER_MIN_PER_COLLECTION` (the CLI grading constant). Full
arithmetic:

```
Writes/mo = 30 writes/min × 60 min/hr × 24 hr/day × 30 days = 1,296,000
```

**R2:**

```
Class A/mo = 1,296,000 × 3 = 3,888,000
Free tier:   1,000,000 Class A/mo (included)
Overage:     2,888,000 Class A ops
Object-storage ops:  2,888,000 / 1,000,000 × $4.50 = ~$13/mo
  + Workers Paid platform floor: $5.00 (only on CF Workers Paid)
All-in (object-storage ops + floor): ~$18/mo
```

**S3:**

```
Class A/mo = 1,296,000 × 4 = 5,184,000
Object-storage ops:  5,184,000 / 1,000,000 × $5.00 = ~$26/mo
  (no platform floor — serverful Node / S3)
```

The `baerly cost` CLI surfaces the **object-storage ops** figure
(~$13/mo on R2 here) as `projectedUsdPerMonth` in the inspect footer —
it uses the same rates and effective write-amp constants from
`packages/cli/src/cost/provider.ts`, and deliberately does NOT add the
$5 Workers Paid platform floor (which doesn't apply on self-hosted Node,
R2-over-the-S3-API, or Workers free tier). Add ~$5/mo for the all-in
cost on Workers Paid.

The ops-vs-cost comparison: $18/mo on R2 buys you zero-ops,
no-on-call, and bytes-in-your-bucket. That tradeoff is the design
center; the number is provided so you can make the comparison
honestly, not to anchor against any specific alternative's price point.

## Compression off by default in `@gusto/baerly-storage/client`

The `@gusto/baerly-storage/client` HTTP client defaults `compression: false`.

**Why.** The dominant baerly-storage deploy shape is a Cloudflare Worker
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
thesis targets. Comparing baerly-storage to managed DBs at a single
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
_est._), derived from that provider's documented per-app floor —
not a hard total we assert as fact. Per-project floors of $0 stay
$0 at any N. Re-check the per-app floors before quoting any total
externally.

| Service                       | Cost at N=30 idle apps                   | Notes                                                                                                                                                                                                                                        |
| ----------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **baerly-storage (Cloudflare)**       | **~$5/mo**                               | One Workers Paid floor amortized across all N apps (paid once, not ×30). Class A/B ops effectively zero at idle (`< 1 op/writer/hour`, [CI-gated](#cost-ceiling)).                                                                           |
| **baerly-storage (self-hosted Node)** | **$0/mo** (your hardware)                | No platform floor; idle is free against any S3-API bucket.                                                                                                                                                                                   |
| Cloudflare D1                 | ~$5/mo                                   | Same single Workers Paid floor amortized across all N apps; ties baerly-storage here, **but only if all N apps are Workers-native**. `wrangler d1 export` gives a SQL dump, but leaving is a dump-and-reload migration, not a zero-cooperation exit. |
| Supabase Free                 | $0                                       | Two free projects per org; not a fleet posture for N=30.                                                                                                                                                                                     |
| Supabase Pro                  | ≈ $25/app × 30 ≈ **~$750/mo** _(est.)_   | Paid plans bill per project (each carries its own always-on Postgres compute), so a 30-app fleet pays ~30 per-project floors. Derived from the documented ~$25/project Pro floor; usage on top varies.                                       |
| Neon Launch                   | ≈ $5/app × 30 ≈ **~$150/mo** _(est.)_    | Usage-based with no monthly minimum and scale-to-zero, but each intermittently-awake app still meters CU-hours; ~$5/app is a typical small-app monthly figure, so a 30-app fleet lands near ~$150/mo. Varies with how often each app wakes.  |
| Firebase Spark                | $0 while inside no-cost Firestore quotas | Official quota is 1 GiB stored, 20k writes/day, 50k reads/day, 20k deletes/day, **per project** — a 30-app fleet can stay $0 only while every app stays inside quota.                                                                        |

The idle × portfolio multiplier is where baerly-storage's "rounds to zero"
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
grades baerly-storage against the systems users should _graduate to_, not
the systems they should be running on long-term. D1 wins per-write
where it's available; managed Postgres wins above L.

## Alternative DBs at M size

The M-size **audience profile** is ~100 MAU, 10 000 docs, ~24 000
writes/day (~50/min over an 8-hour workday — a bursty profile that
averages well under the **sustained** ~30 writes/min basis the
[cost-vs-scale table](#cost-vs-scale-table) uses), ~480 000 reads/day,
100 MB stored. baerly-storage's modelled monthly cost at this profile is
~$19 all-in — dominated by the $5 Workers Paid floor plus R2 Class A/B
ops. This is a **different lens** from the sustained ~30 writes/min curve
(~$18/mo all-in), not the same arithmetic: the profile's 720 000
writes/mo (~2.16M R2 Class A) is _below_ the sustained curve's 1.296M
writes/mo (~3.89M Class A), so the two land close by coincidence of
drivers — not because either "sits at the free-tier floor" (both are
above the 1M Class A free tier). Both figures are all-in incl. the
Workers Paid floor; `baerly cost` reports the object-storage-ops portion
only. Rough 1-decimal comparisons at the same workload:

| Service                  | Plan         | $/mo                                                                  | Notes                                                                                                                                                                                 |
| ------------------------ | ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **baerly-storage (this design)** | Workers Paid | **~$19**                                                              | R2 Class A/B dominate.                                                                                                                                                                |
| Cloudflare D1            | Workers Paid | ~$5                                                                   | M is way under D1's 25B reads / 50M writes free tier; just the plan floor. SQL trade-off is on you.                                                                                   |
| Supabase Free            | Free         | $0                                                                    | Fits storage, but the free plan is not a production fleet posture.                                                                                                                    |
| Supabase Pro             | $25 base     | ~$25                                                                  | Always-on Postgres + Auth + Storage. Roughly parity with baerly-storage + opt-in realtime.                                                                                                    |
| Neon Launch              | usage-based  | ~$15 typical intermittent small app                                   | Scale-to-zero helps for bursty traffic; CU-hours add up if continuous.                                                                                                                |
| Firebase Blaze           | PAYG         | ~$5 _(approx.)_                                                       | 14.4M reads × $0.03/100k ≈ $4.30 + 720k writes × $0.09/100k ≈ $0.65 ≈ ~$5. Roughly baerly-storage ÷ 4 — cheaper per-op at M. Rates: Firestore Standard, us-central1; re-check before quoting. |
| Firebase Spark           | Free         | $0 if under 50k reads/day; M's 480k/day blows the no-cost read quota. |

Read this as positioning, not a cost claim:

- **XS / S workloads:** baerly-storage is decisively cheaper than any
  always-on managed DB, especially across a portfolio — see the
  [idle × portfolio table](#at-the-audience-operating-point-idle--n-portfolio).
  The differentiator is both _what_ you get (schemaless docs,
  multi-instance causal consistency, bytes-in-your-bucket) AND
  the price.
- **M workload:** baerly-storage (~$19) is ~4× more expensive than D1
  (~$5) **where D1 is available** — and D1 is Workers-runtime-only:
  `wrangler d1 export` gives a SQL dump, but there's no
  bucket-native data layer or live CDC handoff, so leaving is a
  dump-and-reload migration, not the bytes-already-in-your-bucket,
  zero-cooperation exit baerly-storage offers. Off-Workers (AWS,
  on-prem, self-hosted Node, any environment that doesn't tolerate
  Cloudflare lock-in), managed Postgres at $25+/mo behind a vendor's
  managed catalog is the relevant comparison. A user willing to accept
  Cloudflare lock-in and a SQL schema should **switch to D1** —
  it's strictly cheaper, and [that move is the success path,
  not a churn event](thesis.md#what-prototype-tier-storage-needs).
  Firebase Blaze is also cheaper than baerly-storage on raw per-op at M
  (~$5 vs. ~$19, recomputed above) — but the argument here was
  never "baerly-storage is cheapest per-op." It's idle × portfolio,
  portability, and availability; on a per-op basis at M, both D1
  and Firebase undercut baerly-storage, and that's expected — M is past
  the design center.
- **L workload:** baerly-storage's R2 Class B alone (~$1 500) costs more
  than a Postgres Pro plan — read-heavy traffic on a per-doc
  fan-out protocol is disproportionately expensive vs. a B-tree
  lookup in a real DB. Reaching that price line is the success
  signal to graduate.
- **Portability / switching cost:** This axis favors baerly-storage
  across all workload sizes. Object storage is the rare primitive
  with a common dialect — the S3 API. AWS S3 and Cloudflare R2 are the
  production-supported stores; MinIO is the local conformance target,
  and other S3-compatible endpoints require `baerly doctor --bucket`
  plus owner validation (see
  [storage-compatibility.md](../spec/storage-compatibility.md) and
  [ADR-004](../adr/004-ephemeral-coordination.md)). Azure Blob speaks a
  non-S3 dialect and GCS's S3-interop endpoint exposes conditional
  writes as read-only, so both need a dedicated adapter that doesn't
  exist yet. The portability point still
  holds where it counts: your bytes live in your bucket and
  leaving needs no vendor cooperation. D1, Supabase, Neon, and Firebase are
  excellent, but they are proprietary runtimes — choosing one is
  a switching-cost decision. Even at M-size where D1 wins on
  raw per-write price, the portability axis sits orthogonal to
  price and should be weighed alongside it.

Cost is decisive in the regimes baerly-storage is sized for; it's
designed to lose past them — that loss is the graduation signal,
mechanical via `baerly export --target=postgres --collection=<name>`
(per collection). We name three
axes explicitly: per-write price (where baerly-storage loses at M-size),
idle × portfolio cost (where it wins decisively), and
portability / switching cost (where it wins on every workload).
The workload class the thesis targets (idle × portfolio, XS/S
experimentation, large internal-tools fleet) isn't economically
viable under per-app managed-DB floors — and that's where the
real argument lives.

The graduation triggers follow directly. The first is an **advisory
cost line** — an eyes-open early signal, not a hard stop — keyed to a
sustained **~100 writes/min** (account-wide), provider-agnostic: ~13M
Class A/mo on R2 (~$54/mo object-storage ops), ~17.3M on S3 (~$86/mo).
At this rate the bill has crossed the point where managed Postgres or D1
are priced comparably. Object storage buys zero ops, no on-call, and no
migration for your bytes; a managed DB trades those dollars for a schema,
SQL, and an ops surface. `baerly cost` prints an advisory note at this
crossing. The **hard graduation cost line**, sustained over 7 days, is
R2 Class A ops > 50M/month (an account/bucket-wide count; ~$220/mo
object-storage ops on R2). At the measured effective write-amp the 50M
Class A/mo line corresponds to ≈ **390 writes/min** sustained on R2
(~3×); on serverful Node the same op envelope is reached at ≈ **290
writes/min** (~4×), though S3's linear per-request pricing makes the
relevant Node line a dollar budget rather than a free-tier-derived op
count. Both correct the previous ≈580 figure, which assumed the 2-op
commit floor. (Stored data is a graduation _cost signal_ at the ~10 GB
R2 free-tier line — see below — not a hard trigger; the tooling does not
enforce a storage hard stop.)

The historic third trigger — **effective write-amp > 6** — is
**retired**. It was calibrated against the old assumed 2-op floor (a 3×
headroom signalling "maintenance badly behind"). Now that the effective
write-amp is measured at ~3× / ~4× and _stress_-measured to peak at ~4×
even under pathological churn
(`docs/spec/attachments/amortized-write-cost-stress-baseline.json`,
`pnpm bench:write-amp-stress`), a sustained > 6 is unreachable through
the bounded in-band maintenance path — the only route past ~4× is a
CAS-retry storm, which is already governed by the per-collection
throughput ceiling below, not a billing signal. The signal that in-band
maintenance is _falling behind_ is `db.compaction.deferred_total` and the
defer `console.warn` (see [graduation.md](graduation.md)), not a
write-amp ratio.

These cost lines sit alongside two additional graduation signals in
[graduation.md](graduation.md): ~30 logical writes/min/collection
(per-collection throughput estimate, CAS-livelock model) and ~10 GB/tenant
(the R2 free-tier storage cost line — a billing signal where R2 storage
charges begin, not a hard stop) plus ~100 collections/tenant (a soft
fan-out guideline — bench-grounded linear cost; nothing in the protocol
enforces it). Today the `baerly cost` projection's `percentOfGraduation`
tracks only the **Class A** trigger (the 50M ops/month line); the
stored-data line is a documented cost signal not surfaced by the tooling.

### Hot-prefix cliff at high write fan-in

One more graduation cliff lives on the storage side, not the dollar
side. Under single-write commit every writer racing the same collection
contends to create the next `log/<seq>` key, so concurrent PUTs
concentrate on one object-store prefix. S3-class stores cap sustained
mutating throughput at roughly **3,500 PUT/s per prefix**; a collection
whose write fan-in approaches that is hitting a per-prefix ceiling, not
a pricing limit. This is inherent to a single linearized per-collection
log (the same property that gives per-collection ordering), so it is a
cliff at high write concurrency, not a regression — and it sits well
past the published ~30-writes/min/collection envelope. Spreading load
across more collections is the lever.
