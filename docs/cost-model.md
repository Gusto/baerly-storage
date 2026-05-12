---
title: Cost model
audience: product
summary: Per-line-item rates, write-amp meter, compression posture.
last-reviewed: 2026-05-12
tags: [cost, pricing, operations]
related: [pricing-log.md, product-thesis.md, "adr/0015-cost-ceiling.md"]
---

# Cost model

Baerly's pricing posture in one page. The protocol kernel emits
three Class A R2 ops per logical write (content body + log entry +
`current.json` CAS-advance); reads emit Class B ops at a rate that
depends on cache hits. The companion file
[docs/pricing-log.md](pricing-log.md) is the one-line-per-change
history of every price or cap update.

All prices below were read **2026-05-09** from the upstream provider
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
| R2 `DeleteObject` | $0 | unlimited — compaction is free |
| R2 egress to internet | $0 | unlimited |
| Worker requests (Workers Paid) | $0.30 / 1M | 10M / mo (paid plan) |
| Worker CPU-ms (Workers Paid) | $0.02 / 1M | 30M / mo (paid plan) |
| Workers Paid plan floor | $5 / mo | — |

Class A is the meter that matters. Three reasons:

1. **Highest unit cost of the high-volume items** ($4.50 / 1M vs.
   Class B at $0.36 / 1M vs. Worker requests at $0.30 / 1M).
2. **Write-amplified by 3 in the protocol** — every logical write
   produces 3 Class A ops, so it grows fastest with traffic.
3. **Compaction storms hit it** — a runaway compaction job is a
   Class A spike, not a Class B spike.

A `baerly stats` view should surface, in priority order, Class A
ops over a trailing 24 h, the derived effective write-amp
(Class A ops / logical writes — protocol regression detector if it
drifts above ~4), and Class B ops. Storage and Worker request
counts are noise until you graduate.

## Compression off by default in `@baerly/client`

The `@baerly/client` HTTP client defaults `compression: false`.

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

This decision is logged at [docs/pricing-log.md](pricing-log.md)
when it ships in `@baerly/client`.

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
| Supabase Free | Free | $0 | Fits 100 MB and 100 MAU < 50k cap. Pauses after 1 week inactivity. |
| Supabase Pro | $25 base | ~$25 | Always-on Postgres + Auth + Storage. Roughly parity with Baerly + opt-in realtime. |
| Neon Launch | $5 floor | ~$5–10 | Scale-to-zero helps for bursty traffic; CU-hours add up if continuous. |
| Firebase Blaze | PAYG | ~$26 | $0.18 × (14.4M / 100k) reads ≈ $26 + ~$1.30 writes. Roughly 1.3× Baerly. |
| Firebase Spark | Free | $0 if under 50k reads/day; M's 480k/day blows the cap and the project pauses. |

Read this as positioning, not a cost claim:

- **XS / S workloads:** Baerly is genuinely free, at parity with
  Supabase Free, D1 free, Neon free, Firebase Spark. The
  differentiator is *what* you get, not the price.
- **M workload:** Baerly (~$19) is **~4× more expensive than D1
  (~$5)** but cheaper than Firebase Blaze and Supabase Pro. The
  pitch is "you're paying for schemaless docs + multi-instance
  causal consistency, not for ops." A user willing to give those
  up for a SQL schema should **switch to D1** — it's strictly
  cheaper. The product thesis is explicit that
  [cost is not the moat](product-thesis.md#positioning).
- **L workload:** Baerly's R2 Class B alone (~$1 500) costs more
  than a Postgres Pro plan. That's the graduation cliff —
  read-heavy traffic on a per-doc fan-out protocol is
  disproportionately expensive vs. a B-tree lookup in a real DB.

The graduation triggers for `baerly stats` follow directly: any one
of (sustained over 7 days) R2 Class A ops > 50M/month, effective
write-amp > 6, or stored data > 5 GB is the system telling the user
they have outgrown the ceiling.
