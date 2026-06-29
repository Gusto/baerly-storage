---
title: Cost model
audience: product
summary: Per-line-item rates, write-amp meter, compression posture.
last-reviewed: 2026-06-28
tags: [cost, pricing, operations]
related: [pricing-log.md, thesis.md, workload-fit.md, graduation.md]
---

# Cost model

The cost meter to watch is **billable Class A object-storage
operations**: PUTs and LISTs. Class B GETs are much cheaper. Unindexed
reads mostly stay on the Class B meter; indexed `.where()` reads can
issue Class A LISTs.

The smallest successful write is an unindexed insert on the first try:
one PUT for the content body and one create-if-absent PUT for
`log/<seq>`. That two-op **commit floor** matters because the log create
is the commit. There is no `current.json` write on the commit path.

The billable steady-state number is higher than the floor because
successful writes may also run bounded maintenance. Measured effective
Class A write-amplification is ~3× on Cloudflare and ~4× on serverful
Node. Deletes are cheaper; indexes, retries, and first-collection
provisioning add bounded ops. The unindexed read tail forward-probe is
Class B GET work, so it does not touch the Class A meter.

All prices below were re-checked **2026-06-22** against the official
[Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/),
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
and
[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
pages. Re-check before quoting any figure externally; price and cap
changes land in [pricing-log.md](pricing-log.md), the
one-line-per-change history, on the day they ship.

## Per-line-item rates (Cloudflare R2 + Workers)

R2 storage and ops dominate at M-size. Worker CPU and request counts are
secondary.

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

Class A is the main meter:

1. It has the highest unit cost among high-volume items: $4.50 / 1M vs.
   Class B at $0.36 / 1M and Worker requests at $0.30 / 1M.
2. Writes amplify it: the commit floor is 2 Class A ops, and
   maintenance raises the effective rate to ~3× on Cloudflare / ~4× on
   Node.
3. Compaction and GC use PUT / LIST / conditional-PUT work. Free
   `DeleteObject` calls are not the bill driver.

`baerly cost --bucket=<bucket-uri> --collection=<collection>` reports
the current write trajectory:

- Class A ops/mo;
- free-tier-aware dollars;
- distance to the advisory line (~100 writes/min; ~$54/mo R2
  object-storage ops); and
- distance to the 50M Class A/mo hard graduation trigger.

The projection uses measured effective write-amp, not the two-op commit
floor, so it includes write-path maintenance. Write amp belongs to the
host maintenance profile, not the storage provider: the Cloudflare free
profile measures ≈3×, and the Node profile measures ≈4×. Today
`baerly cost` maps that onto provider defaults (`r2` ⇒ ≈3×, `aws-s3` /
self-hosted ⇒ ≈4×). That matches Worker+R2 and Node+S3 defaults, but is
only a projection assumption for cross-provider deployments such as Node
against R2.

For longer windows (7-day, 30-day), pipe the canonical log line to
CloudWatch / Workers Analytics / Datadog; see
[`docs/guide/observability.md`](../guide/observability.md).

## Cost ceiling

baerly-storage publishes and tests a ceiling so cost drift is caught.
Three bounds matter:

- **Small constant storage ops per logical write.** The unindexed
  first-try insert baseline is PUT content + the committing
  `log/<seq>` create: 2 Class A ops. The create-if-absent is the
  commit, so there is no `current.json` write on the commit path.
  Deletes can be cheaper; indexes, retries, and first-collection
  provisioning add bounded mutations. Snapshot writes amortize across
  many log entries and are issued by the compactor, not the commit step.
  The `db.write.class_a_ops_per_logical_write` histogram is emitted on
  every commit (verified in CI by `writer.test.ts`). If you pipe it to a
  metrics sink, alerting when p99 exceeds ~5 is a recommendation, not a
  shipped or CI-gated check.
- **Effective Class A write-amplification is ~3× on Cloudflare and ~4×
  on serverful Node.** The commit path is still two Class A ops, but
  in-band folds and GC run from the write path. They add ~1 Class A
  op/write on the cf-free profile and ~2 on Node. Node's
  `gcInterval=2` vs. cf's `4` doubles the GC LISTs; each GC pass is a
  handful of LISTs plus per-candidate mark `GET`s and a `pending.json`
  CAS `PUT`, and each fold is 2 PUT. Measured empirically; see
  `docs/spec/attachments/amortized-write-cost-baseline.json`
  (`pnpm bench:amortized-write-cost`) and gated by
  `tests/integration/write-amp.test.ts`. `DeleteObject` (the GC
  sweep) is $0 on R2/S3 and is excluded from this count.
- **`< 1 Class A op / writer / hour` for idle readers.** For unindexed
  idle reads, the expected value is exactly zero. They walk
  `current.json`, the snapshot, and the live-tail log by deterministic
  GETs. The tail forward-probe GETs from
  `max(log_seq_start, tail_hint)` (normally `tail_hint`) to the first
  404; those are Class B calls. The read-path exception is an indexed
  `.where()`: it issues one `ListObjects` Class A call per equality value
  (`$in` ⇒ N calls) to walk the index prefix and resolve matching `_id`s.
  The default fold path (full scan over snapshot + tail) is zero Class A.

### Maintenance is write-driven; reads are pure

The idle-reader bound holds because only writes tick maintenance. A read
does zero maintenance work
([ADR-002](../adr/002-ephemeral-coordination.md),
[graduation.md](graduation.md)). The cost consequences:

- **A bucket with no later writes pays a bounded ≤ ~1× tail replay per
  read while folds succeed.** At the default
  `MAINTENANCE_TARGET_RATIO = 1.0`, the live tail stays within ~1× the
  snapshot, so an unindexed reader replays at most about one snapshot's
  worth of log entries on top of the snapshot. Above `S_max` (the
  snapshot ceiling `C` / `E`), the fold defers and the tail grows
  unbounded. Read cost then climbs with every write since the last fold.
  That is the graduation cliff, not steady state.
- **An over-ceiling bucket defers cheaply, not magically.** The defer
  decision is a zero-storage-op projection over `current.json` already
  in scope, so it avoids a fold attempt. A deferring collection can still
  do normal writes plus rate-limited `tail_hint` / warning stamps.
- **Inline-Node fold latency is I/O-dominated, not CPU-dominated.**
  A fold's wall-clock is roughly
  `⌈tail / MAX_PARALLEL_LOG_READS⌉` storage round-trips. Log-tail GETs
  are concurrent, capped at `MAX_PARALLEL_LOG_READS = 16`; the snapshot
  ceiling bounds CPU/memory, not round-trip count. A future serverful
  post-response dispatch would move this off the write's critical path.
- **Node worst case = a fold _plus_ a full GC pass on one write.**
  Node runs `phasesPerTick: "both"`, so a single boundary-crossing
  write can pay both a fold slice and a GC pass. The combined cost
  is a bounded p99 latency spike that scales with the moderate,
  latency-budgeted `NODE_MAINTENANCE_*` caps (fold 200 / marks 200
  / sweeps 100). Budget for the **combined** number, not the fold
  alone; a future post-response dispatch removes the spike.
- **Seed-then-idle orphan residual.** A bucket bulk-seeded with
  `admin restore` and then left idle within the 7-day GC grace window
  can carry a bounded, never-reclaimed orphan pile. Reads are pure, so
  without later writes nothing ticks and `runGc` never re-runs to sweep
  marked orphans. This is irreducible under reads-pure, bounded by the
  import size, and reclaimable on demand through the opt-in
  `runScheduledMaintenance` SDK. It is a known boundary of the in-band
  model, not a leak.

The ceiling protects two concrete workloads:

1. An app with one daily writer and a handful of pollers should be free
   on R2 and effectively free on S3. One Class A op per poll breaks that.
2. A ~100-MAU helpdesk app should cost single-digit dollars per month.
   Per-write ops must stay a small constant, not grow with table size,
   snapshot depth, or history.

The ceiling is a gate, not a target.
`tests/integration/maintenance-e2e.test.ts` wraps `Storage` with a
counting proxy and gates on `expect(classAOps).toBeLessThan(1)` after
1800 polls (one hour at 2 s cadence).
`packages/server/src/maintenance.ts` carries the `CLOUDFLARE_FREE_TIER`
bounded-tick arithmetic. Engine defaults are unbounded, so a Node caller
just passes `{}`. `maintenance-budget.test.ts` proves each Cloudflare
free-tier compact or GC phase sits under the 50-subrequest cap; the
scheduled handler alternates phases rather than running both in one
free-tier tick.

Per-collection commit scope (see
[`docs/spec/sync-protocol.md`](../spec/sync-protocol.md)) is what makes
the idle-poll bound tractable: one cheap log series and one compaction
bookmark per collection rather than contention on a global mutex.

## Cost curve: theoretical $/mo by write rate

### Ops-vs-cost tradeoff

Object storage buys low operator burden: no DB process to provision,
patch, or page about. A managed relational DB buys a richer query model
and a dedicated server, but it brings a per-project floor and an on-call
surface. At low write rates baerly-storage is nearly free. At M-size and
above, Class A billing compounds with effective write-amp; that bill is
the graduation signal.

### Formulas (June-2026 rates)

These are the formulas the `baerly cost` CLI projection is built on.
`W` is monthly logical writes (write operations, not documents), and
`A` is the measured effective Class A write-amplification for the host
maintenance profile. Use `A ≈ 3` for the Cloudflare free profile and
`A ≈ 4` for the Node profile. All figures use measured effective
write-amplification, not the two-op commit floor.

**Cloudflare R2 pricing** (default Worker+R2 path uses `A ≈ 3`):

```
Class A ops/mo         = W × A
R2 object-storage $/mo = max(0, W×A − 1,000,000) × $4.50 / 1,000,000
                       + max(0, storedGB − 10) × $0.015
                       + Class B reads (typically minor at M-size)
```

This is the **object-storage ops** projection `baerly cost` reports. R2
ops are billed above 1M Class A/mo; storage is billed above 10 GB/mo.
The $5/mo **Workers Paid** plan is a separate Cloudflare _platform_
floor, not an R2 charge. It is absent on self-hosted Node,
R2-over-the-S3-API, and the Workers free tier, so `baerly cost` does not
include it. Add ~$5/mo for the all-in Workers Paid figure. Under 1M
Class A/mo (roughly ≤ 7 writes/min sustained) and under 10 GB, R2
object-storage cost is $0.

**AWS S3 pricing** (default self-hosted Node+S3 path uses `A ≈ 4`, no free tier):

```
Class A ops/mo = W × A
S3 $/mo = W×A × $5.00 / 1,000,000
        + storedGB × $0.023
        + Class B reads (typically minor at M-size)
```

S3 has no flat floor and no free tier in this model: every write costs
linearly from zero. In the default deployment paths, Node+S3 is roughly
**50% costlier than Worker+R2** per write: $20 vs $13.50 per million
logical writes (4 × $5.00/1M vs. 3 × $4.50/1M). The gap comes from both
the higher Node maintenance write-amp and the higher S3 per-op rate. If
you run Node against R2, use R2's rates with Node's `A ≈ 4`; for a
non-default profile, treat the table as a projection and validate
against `db.write.class_a_ops_per_logical_write`. The 12-month
new-account free tier was retired in 2025; these figures apply to paid
accounts.

### Cost-vs-scale table

Representative write rates and their projected monthly costs.
Figures are **object-storage ops only** (storage and Class B reads are
minor until L-size read fan-out and are excluded from these rows), and
exclude the $5/mo Workers Paid platform floor — add it for the all-in
cost on Cloudflare Workers Paid. These figures are what `baerly cost`
projects. Storage: assume ~100 MB for S-size, scaling proportionally.

| Writes/min (sustained, account-wide) | Class A/mo (Worker+R2, A≈3) | R2 $/mo (object-storage ops) | Class A/mo (Node+S3, A≈4) | S3 $/mo (object-storage ops) | Notes |
| --- | --- | --- | --- | --- | --- |
| 1 | 130k | $0 | 173k | ~$0.86 | Inside R2 free tier (1M/mo) |
| 10 | 1.3M | ~$1 | 1.7M | ~$9 | R2: small Class A overage (+ $5 Workers Paid floor) |
| **30 (M-size)** | **3.9M** | **~$13** | **5.2M** | **~$26** | **~$18/mo all-in on R2 incl. floor — see M-size breakdown below** |
| **100** | **13.0M** | **~$54** | **17.3M** | **~$86** | **Advisory crossing: `baerly cost` prints eyes-open advisory** |
| 390 | 50.5M | ~$223 | 67.4M | ~$337 | ≈ 50M Class A/mo R2 graduation trigger |
| 1000 | 129.6M | ~$579 | 172.8M | ~$864 | Well past graduation |

The 390 writes/min row is the 50M Class A/mo graduation trigger at the
default Worker+R2 write amp (`A≈3`): R2 costs **~$223/mo** and the
Node+S3 default path costs **~$337/mo** in object-storage ops. The
Node-profile path reaches the same 50M op envelope at ~290 writes/min
(`A≈4`).

### M-size $/mo breakdown

The M-size operating point is a **sustained** ~30 writes/min. In this
cost-curve table that is an **account-wide aggregate** rate because
Class A is billed per account, not per collection. It numerically
coincides with, but is different from, the per-collection CAS-contention
ceiling `M_SIZE_WRITES_PER_MIN_PER_COLLECTION` (the CLI grading
constant). Full arithmetic:

```
Writes/mo = 30 writes/min × 60 min/hr × 24 hr/day × 30 days = 1,296,000
```

**Worker+R2 default (`A≈3`):**

```
Class A/mo = 1,296,000 × 3 = 3,888,000
Free tier:   1,000,000 Class A/mo (included)
Overage:     2,888,000 Class A ops
Object-storage ops:  2,888,000 / 1,000,000 × $4.50 = ~$13/mo
  + Workers Paid platform floor: $5.00 (only on CF Workers Paid)
All-in (object-storage ops + floor): ~$18/mo
```

**Node+S3 default (`A≈4`):**

```
Class A/mo = 1,296,000 × 4 = 5,184,000
Object-storage ops:  5,184,000 / 1,000,000 × $5.00 = ~$26/mo
  (no platform floor — serverful Node / S3)
```

`baerly cost` surfaces the **object-storage ops** figure (~$13/mo on R2
here) as `projectedUsdPerMonth` in the inspect footer. It uses the
provider rates and default effective write-amp constants from
`packages/cli/src/cost/provider.ts`, and deliberately excludes the $5
Workers Paid platform floor. Add ~$5/mo for the all-in Workers Paid
cost. For cross-provider deployments, use the host profile's measured
write amp when doing manual projections.

$18/mo on R2 buys low operator burden and bytes-in-your-bucket. The
number is here for comparison, not as an anchor against any one
alternative's price.

## Compression default decision for `@gusto/baerly-storage/client`

Decision: when HTTP-client wire compression ships, default to
`compression: false`.

**Why.** The dominant deploy shape is a Cloudflare Worker talking to R2
in the same data center. Worker CPU-ms is metered on Workers Paid, and
the intra-DC R2 link has zero egress cost. Gzip spends CPU to save zero
billable bytes. The same applies when self-hosted Node and the bucket
sit in the same network, such as hosted Minio or on-prem Ceph.

**When to flip it on.** The trade-off inverts for
BYO-Node-to-remote-bucket: a Node process outside the bucket's network,
where every read or write crosses a paid egress link. Compression then
shrinks billable bytes at the cost of local CPU, which is cheap on a
long-running Node process compared to a per-request Worker isolate. Set
`compression: true` for that shape once the option exists.

**Default.** `false`, with a single-line client-config override once the
option ships.

This decision is logged at [pricing-log.md](pricing-log.md)
when it ships in `@gusto/baerly-storage/client`.

## Two operating points, two stories

baerly-storage wins on idle × portfolio cost and loses on per-write unit
cost past the graduation cliff. Both are intentional.

### At the audience operating point: idle × N portfolio

For the [audience-in-practice](thesis.md#audience-in-practice), the
per-app floor is the cost line, not the per-write rate. Costs at N=30
mostly-idle apps:

Every cell uses the same N=30 basis. Non-zero usage-based or per-project
floors are shown as **per-app basis × 30 estimates** and marked
_est._. Per-project floors of $0 stay $0 at any N. Re-check provider
floors before quoting totals externally.

| Service                       | Cost at N=30 idle apps                   | Notes                                                                                                                                                                                                                                        |
| ----------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **baerly-storage (Cloudflare)**       | **~$5/mo**                               | One Workers Paid floor amortized across all N apps (paid once, not ×30). Class A/B ops effectively zero at idle (`< 1 op/writer/hour`, [CI-gated](#cost-ceiling)).                                                                           |
| **baerly-storage (self-hosted Node)** | **$0/mo** (your hardware)                | No platform floor; idle storage-op cost is $0 against an S3-API bucket. See the AWS free-tier caveat above.                                                                                                                                  |
| Cloudflare D1                 | ~$5/mo                                   | Same single Workers Paid floor amortized across all N apps; ties baerly-storage here, **but only if all N apps are Workers-native**. `wrangler d1 export` gives a SQL dump, but leaving is a dump-and-reload migration, not a zero-cooperation exit. |
| Supabase Free                 | $0                                       | Two free projects per org; not a fleet posture for N=30.                                                                                                                                                                                     |
| Supabase Pro                  | ≈ $25/app × 30 ≈ **~$750/mo** _(est.)_   | Paid plans bill per project (each carries its own always-on Postgres compute), so a 30-app fleet pays ~30 per-project floors. Derived from the documented ~$25/project Pro floor; usage on top varies.                                       |
| Neon Launch                   | ≈ $5/app × 30 ≈ **~$150/mo** _(est.)_    | Usage-based with no monthly minimum and scale-to-zero, but each intermittently-awake app still meters CU-hours; ~$5/app is a typical small-app monthly figure, so a 30-app fleet lands near ~$150/mo. Varies with how often each app wakes.  |
| Firebase Spark                | $0 while inside no-cost Firestore quotas | Official quota is 1 GiB stored, 20k writes/day, 50k reads/day, 20k deletes/day, **per project** — a 30-app fleet can stay $0 only while every app stays inside quota.                                                                        |

A team with 30 internal tools pays one platform floor, or zero on
self-hosted Node. For this workload class, the alternative is often not
another database; it is the experiment staying in a Google Sheet.

### At the graduation cliff: M-size and above

Past the workload ceiling, per-write economics flip. D1 wins per-write
where it is available; managed Postgres wins above L.

## Alternative DBs at M size

M-size, in this comparison, means:

- ~100 MAU;
- 10 000 docs;
- ~24 000 writes/day (~50/min over an 8-hour workday);
- ~480 000 reads/day; and
- 100 MB stored.

This is a bursty audience profile, not the same lens as the sustained
~30 writes/min [cost-vs-scale table](#cost-vs-scale-table). The profile
has 720 000 writes/mo (~2.16M R2 Class A), below the sustained curve's
1.296M writes/mo (~3.89M Class A). Both are above the 1M Class A free
tier. baerly-storage's modelled cost here is ~$19 all-in, dominated by
the $5 Workers Paid floor plus R2 Class A/B ops; `baerly cost` reports
only the object-storage-ops portion.

| Service                  | Plan         | $/mo                                                                  | Notes                                                                                                                                                                                 |
| ------------------------ | ------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **baerly-storage (this design)** | Workers Paid | **~$19**                                                              | R2 Class A/B dominate.                                                                                                                                                                |
| Cloudflare D1            | Workers Paid | ~$5                                                                   | M is way under D1's 25B reads / 50M writes free tier; just the plan floor. SQL trade-off is on you.                                                                                   |
| Supabase Free            | Free         | $0                                                                    | Fits storage, but the free plan is not a production fleet posture.                                                                                                                    |
| Supabase Pro             | $25 base     | ~$25                                                                  | Always-on Postgres + Auth + Storage. Roughly parity with baerly-storage + opt-in realtime.                                                                                                    |
| Neon Launch              | usage-based  | ~$15 typical intermittent small app                                   | Scale-to-zero helps for bursty traffic; CU-hours add up if continuous.                                                                                                                |
| Firebase Blaze           | PAYG         | ~$5 _(approx.)_                                                       | 14.4M reads × $0.03/100k ≈ $4.30 + 720k writes × $0.09/100k ≈ $0.65 ≈ ~$5. Roughly baerly-storage ÷ 4 — cheaper per-op at M. Rates: Firestore Standard, us-central1; re-check before quoting. |
| Firebase Spark           | Free         | $0 if under 50k reads/day; M's 480k/day blows the no-cost read quota. |

Read this as positioning, not a provider quote:

- **XS / S:** baerly-storage is cheaper than always-on managed DBs,
  especially across a portfolio; see the
  [idle × portfolio table](#at-the-audience-operating-point-idle--n-portfolio).
  The differentiators are schemaless docs, multi-instance causal
  consistency, bytes-in-your-bucket, and price.
- **M:** baerly-storage (~$19) is ~4× more expensive than D1 (~$5)
  where D1 is available. D1 is Workers-runtime-only; `wrangler d1
  export` gives a SQL dump, but leaving is dump-and-reload rather than
  a bucket-native data layer or live CDC handoff. Off Workers, managed
  Postgres at $25+/mo behind a vendor catalog is the relevant
  comparison. If Cloudflare lock-in and SQL are acceptable, switch to
  D1; [that move is the success path, not churn](thesis.md#what-apps-within-the-envelope-need).
  Firebase Blaze also undercuts baerly-storage on raw per-op at M
  (~$5 vs. ~$19). That is expected: M is past the design center.
- **L:** baerly-storage's R2 Class B alone (~$1 500) costs more than a
  Postgres Pro plan. Read-heavy traffic on a per-doc fan-out protocol is
  disproportionately expensive compared with a B-tree lookup.
- **Portability / switching cost:** baerly-storage keeps this advantage
  across workload sizes. AWS S3 and Cloudflare R2 are the
  production-supported stores; MinIO is the local conformance target;
  other S3-compatible endpoints require `baerly doctor --bucket` plus
  owner validation (see
  [storage-compatibility.md](../spec/storage-compatibility.md) and
  [ADR-002](../adr/002-ephemeral-coordination.md)). Azure Blob is not an
  S3 dialect, and GCS's S3-interop endpoint exposes conditional writes
  as read-only, so both need dedicated adapters that do not exist yet.
  D1, Supabase, Neon, and Firebase are proprietary runtimes; choosing
  one is a switching-cost decision.

The axes are per-write price, idle × portfolio cost, and portability /
switching cost. baerly-storage loses per-write price at M-size and
above; `baerly export --target=postgres --collection=<name>` is the
per-collection graduation path.

### Cost-side graduation signals

- **Advisory:** sustained ~100 writes/min account-wide. This is
  provider-agnostic: ~13M Class A/mo on R2 (~$54/mo object-storage ops)
  and ~17.3M on S3 (~$86/mo). It is an eyes-open signal, not a hard
  stop; `baerly cost` prints an advisory note at this crossing.
- **Hard cost line:** R2 Class A ops > 50M/month, sustained over 7 days
  (account/bucket-wide; ~$220/mo object-storage ops on R2). At measured
  effective write-amp, that is ≈ **390 writes/min** on R2 (~3×). The
  same op envelope on serverful Node is ≈ **290 writes/min** (~4×), but
  S3's linear pricing makes the Node line a dollar budget rather than a
  free-tier-derived op count. Both correct the previous ≈580 figure,
  which assumed the 2-op commit floor.
- **Stored data:** a graduation cost signal at the ~10 GB R2 free-tier
  line, not a hard trigger. The tooling does not enforce a storage hard
  stop.
- **Retired:** `effective write-amp > 6`. It was calibrated against the
  old assumed 2-op floor. Effective write-amp is now measured at
  ~3× / ~4× and stress-measured to peak at ~4× under pathological churn
  (`docs/spec/attachments/amortized-write-cost-stress-baseline.json`,
  `pnpm bench:write-amp-stress`). The route past ~4× is a CAS-retry
  storm, governed by the per-collection throughput ceiling. Maintenance
  falling behind is signalled by `db.compaction.deferred_total` and the
  defer `console.warn` (see [graduation.md](graduation.md)).

These sit alongside the other graduation signals in
[graduation.md](graduation.md): ~30 logical writes/min/collection
(throughput estimate), ~10 GB/tenant (R2 storage cost signal, not a hard
stop), and ~100 collections/tenant (soft fan-out guideline). Today
`baerly cost` `percentOfGraduation` tracks only the Class A trigger.

### Hot-prefix cliff at high write fan-in

One more graduation cliff lives on the storage side, not the dollar
side. Under single-write commit, writers racing the same collection all
try to create the next `log/<seq>` key, so concurrent PUTs concentrate
on one object-store prefix. S3-class stores cap sustained mutating
throughput at roughly **3,500 PUT/s per prefix**; a collection near that
line is hitting a per-prefix ceiling, not a pricing limit. This is
inherent to a single linearized per-collection log, the same property
that gives per-collection ordering. It sits well past the published
~30-writes/min/collection envelope. Spreading load across more
collections is the lever.
