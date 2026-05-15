---
title: Pricing log
audience: operator
summary: Append-only audit of price and cap changes.
last-reviewed: 2026-05-12
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
| 2026-05-11 | **Initial workload ceiling published.** ~30 logical writes/min/collection sustained; ~10 GB/tenant total; ~100 collections/tenant fan-out. Above any one of these: graduate to D1 / Postgres. Platform-independent — same ceiling on Cloudflare Workers, self-hosted Node, AWS Lambda. | This is the design ceiling, not a quota. Workloads inside the ceiling sit in Cloudflare's free tier for storage (10 GB-mo free) and stay below ~$20/mo total at the M-size operating point. Workloads above the ceiling start hitting R2 Class A op cost (the protocol's 3× write-amplification compounds), Worker CPU-ms overage, and per-collection manifest-scan latency. |
