---
title: Pricing log
audience: operator
summary: Append-only audit of price and cap changes.
last-reviewed: 2026-06-15
tags: [audit, pricing]
related: [cost-model.md]
---

# Pricing log

One line per price-or-cap change that affects baerly-storage users.
Append-only. Read top-to-bottom for the rate-of-change of what costs
money or graduates the user out.

This is a **trust artifact**, not a marketing page. If baerly-storage's
ceiling shifts, the new ceiling lands here on the same day it lands
in code. If an upstream provider changes a billable rate, the
multiplier on baerly-storage's cost model lands here on the same day the
cost model gets the new number.

Cost model: [cost-model.md](cost-model.md).

| Date | Change | Workload-shape impact |
|---|---|---|
| 2026-05-11 | **Initial workload ceiling published.** ~30 logical writes/min/collection sustained; ~10 GB/tenant total; ~100 collections/tenant fan-out. Above any one of these: graduate to D1 / Postgres. Platform-independent — same ceiling on Cloudflare Workers, self-hosted Node, AWS Lambda. *(Clarified 2026-06-14 — see below: this is the protocol-level **workload** ceiling, which is host-independent; the host-dependent number is the **maintenance** ceiling, a separate value.)* | This is the design ceiling, not a quota. Workloads inside the ceiling sit in Cloudflare's free tier for storage (10 GB-mo free) and stay below ~$20/mo total at the M-size operating point. Workloads above the ceiling start hitting R2 Class A op cost (the protocol's 3× write-amplification compounds), Worker CPU-ms overage, and per-collection log-fold latency. |
| 2026-05-27 | **Positioning.** Reframed "cost is not the moat" thesis bullet + cost-model.md to a 4-axis CTO comparison (per-write unit cost, idle × portfolio, availability, switching cost). Added "At the audience operating point" table grading cost at idle × N=30 portfolio (baerly-storage $0–$5, Supabase Pro $750, Neon Launch $150). M-size alt-DB table preserved as graduation-cliff reference. | No rate change. Docs-only. Workload ceiling and per-line-item rates unchanged. |
| 2026-06-12 | **Provider rate re-check.** Official Cloudflare R2, Workers pricing, and Workers limits pages still match the published cost model: R2 Standard storage $0.015/GB-mo, Class A $4.50/1M, Class B $0.36/1M, 10 GB / 1M Class A / 10M Class B free tier; Workers Paid $5 floor, 10M requests + 30M CPU-ms included, $0.30/1M requests and $0.02/1M CPU-ms after that; Workers Free CPU 10 ms, Paid default 30 s / max 5 min. | No rate change. Documentation review only. |
| 2026-06-13 | **Competitor comparison re-check + N=30 portfolio re-expression.** Refreshed Neon, Supabase, and Firebase wording to match current official pricing posture: Neon Launch is usage-based with no monthly minimum, Supabase Pro bills per project (own always-on Postgres compute), and Firebase Spark is a per-project no-cost quota rather than a pause promise. The N=30 idle-portfolio table's competitor cells were re-expressed onto a single consistent **per-app basis × 30 estimate** form: the prior hard totals from the 2026-05-27 entry (Supabase Pro ~$750, Neon Launch ~$150) are **restated as derivations** — Supabase Pro ≈ $25/app × 30 ≈ ~$750/mo *(est.)*, Neon Launch ≈ $5/app × 30 ≈ ~$150/mo *(est.)* — so no usage-based total is asserted as a hard fact and the portfolio multiplier (×30) stays visible in every cell. | No baerly-storage rate or ceiling change. Keeps the N=30 idle-portfolio argument internally consistent (one basis per column) while being honest that variable-priced competitor totals are estimates, not quotes. |
| 2026-06-14 | **Ceiling clarification + CF limit correction (truth-in-docs).** The 2026-05-11 "same ceiling on CF / Node / Lambda" line conflated two distinct ceilings. The *workload* ceiling (~10 GB/tenant, ~30 writes/min/collection, ~100 collections/tenant) is a protocol-level **target** and is host-independent by design — it falls out of S3/R2 CAS-livelock, storage, and fan-out, not the runtime. The *maintenance* ceiling — how large a snapshot a host can fold before compaction defers — **is** host-dependent and not yet fully benched: CF-free is CPU-bound (10 ms caps fold size), CF-paid relaxes CPU (30 s default / 5 min max) but is memory-bound, Node is bounded by host RAM. Corrected a related CF fact: memory is **128 MB on both free and paid** — paid buys CPU + subrequests, **not** memory. | No rate change. Truth-in-docs correction. Whether a host can *sustain* the workload ceiling depends on its maintenance throughput; benching that (and any resulting per-host maintenance profile) is a tracked follow-up. |
| 2026-06-15 | **Provider rate and limit re-check.** Official Cloudflare R2, Workers pricing, Workers limits, R2 consistency, AWS S3 consistency, and Cloudflare Access service-token docs were re-read during the pre-launch docs pass. Published R2 Standard rates and free-tier caps still match the cost model; Workers limits still show 10 ms CPU / 50 subrequests on Free, 30 s default / 5 min max CPU and 10,000 subrequests on Paid, and 128 MB memory on both. Cloudflare Access service-token verification examples were updated to use `CF-Access-Client-Id` + `CF-Access-Client-Secret`; the Worker verifier still consumes the Access JWT injected as `Cf-Access-Jwt-Assertion`. | No baerly-storage rate or ceiling change. Docs-only correction to auth verification and review dates. |
