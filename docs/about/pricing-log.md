---
title: Pricing log
audience: operator
summary: Append-only audit of price and cap changes.
last-reviewed: 2026-06-12
tags: [audit, pricing]
related: [cost-model.md]
---

# Pricing log

One line per price-or-cap change that affects Baerly users. Append-
only. Read top-to-bottom for the rate-of-change of what costs money
or graduates the user out.

This is a **trust artifact**, not a marketing page. If Baerly's
ceiling shifts, the new ceiling lands here on the same day it lands
in code. If an upstream provider changes a billable rate, the
multiplier on Baerly's cost model lands here on the same day the
cost model gets the new number.

Cost model: [docs/cost-model.md](cost-model.md).

| Date | Change | Workload-shape impact |
|---|---|---|
| 2026-05-11 | **Initial workload ceiling published.** ~30 logical writes/min/collection sustained; ~10 GB/tenant total; ~100 collections/tenant fan-out. Above any one of these: graduate to D1 / Postgres. Platform-independent — same ceiling on Cloudflare Workers, self-hosted Node, AWS Lambda. | This is the design ceiling, not a quota. Workloads inside the ceiling sit in Cloudflare's free tier for storage (10 GB-mo free) and stay below ~$20/mo total at the M-size operating point. Workloads above the ceiling start hitting R2 Class A op cost (the protocol's 3× write-amplification compounds), Worker CPU-ms overage, and per-collection log-fold latency. |
| 2026-05-27 | **Positioning.** Reframed "cost is not the moat" thesis bullet + cost-model.md to a 4-axis CTO comparison (per-write unit cost, idle × portfolio, availability, switching cost). Added "At the audience operating point" table grading cost at idle × N=30 portfolio (Baerly $0–$5, Supabase Pro $750, Neon Launch $150). M-size alt-DB table preserved as graduation-cliff reference. | No rate change. Docs-only. Workload ceiling and per-line-item rates unchanged. |
| 2026-06-12 | **Provider rate re-check.** Official Cloudflare R2, Workers pricing, and Workers limits pages still match the published cost model: R2 Standard storage $0.015/GB-mo, Class A $4.50/1M, Class B $0.36/1M, 10 GB / 1M Class A / 10M Class B free tier; Workers Paid $5 floor, 10M requests + 30M CPU-ms included, $0.30/1M requests and $0.02/1M CPU-ms after that; Workers Free CPU 10 ms, Paid default 30 s / max 5 min. | No rate change. Documentation review only. |
