---
title: Alternatives
audience: product
summary: How baerly-storage compares to Firebase, Supabase, Convex, and Cloudflare D1 — on ceremony, vendor commitment, availability surface, and exit path.
last-reviewed: 2026-07-01
tags: [positioning, product, comparison]
related: [thesis.md, workload-fit.md, cost-model.md, graduation.md]
---

# Alternatives

baerly-storage is the database built for the software LLMs write — and
the builders they hand it to. The whole thing is a small, typed
TypeScript library that runs in your own request handler over a bucket
you already own: no schema migrations to author, no row-level-security
policies to generate, no service to stand up or keep online. It is small
enough to give a non-engineer building an internal tool and let them go.

It fits a specific niche: live application data for apps that have
outgrown a browser tab but haven't yet earned a database service —
internal tools, admin panels, dashboards, and low-to-moderate-traffic
line-of-business apps. This page compares it to the four alternatives
most often reached for at that tier.

Firebase, Supabase, Convex, and D1 are all capable backends. The
question here is what it costs — in ceremony, in vendor commitment, and
in exit risk — to reach for one instead. The lens is positioning, not
dollars; cost modeling lives in [cost-model.md](cost-model.md).
Competitor facts were web-verified 2026-07-01 ([sources](#sources)).

## At a glance

|                         | baerly-storage                        | Firebase (Firestore)       | Supabase                       | Convex                     | Cloudflare D1              |
| ----------------------- | ------------------------------------- | -------------------------- | ------------------------------ | -------------------------- | -------------------------- |
| **Schema / migrations** | none (optional validators)            | schemaless                 | Postgres DDL + migrations      | optional TS schema         | SQL DDL + migrations       |
| **Tenancy / auth**      | prefix-scoped in code                 | Security Rules DSL         | RLS policies                   | app code                   | app code                   |
| **Query model**         | document DB, no joins                 | NoSQL doc queries          | full SQL (joins, FTS)          | reactive TS queries        | full SQL (SQLite)          |
| **Real-time**           | long-poll                             | ✅ native push             | via Postgres                   | ✅ native                  | ❌                         |
| **Runtime & data**      | your S3 bucket; nothing resident      | Google's managed service   | managed PG service (or self-host) | Convex's managed service | Cloudflare's managed service |
| **To adopt**            | use a bucket you already have         | new vendor (legal + procurement) | new vendor (legal + procurement) | new vendor (legal + procurement) | new vendor (legal + procurement) |
| **Exit path**           | `baerly export` → SQL                 | proprietary, paid plan     | `pg_dump` → SQL                | JSON (+ script for SQL)    | `.sql` export              |

On availability and supply chain: baerly-storage adds no service beyond
the bucket and compute you already run — one fewer vendor in your
critical path and your dependency tree. Servers that don't exist can't
go down. Your bucket (S3/R2) and your handler's host keep their own
SLAs; baerly-storage just doesn't add a third to depend on.

## Cost & limits

|                | baerly-storage                     | Firebase           | Supabase                        | Convex                        | Cloudflare D1                |
| -------------- | ---------------------------------- | ------------------ | ------------------------------- | ----------------------------- | ---------------------------- |
| **Idle cost**  | $0 on S3; ~$5/mo CF floor, amortized | $0 (Spark)       | auto-pauses idle; Pro always-on | $0 (free tier)                | $0, scale-to-zero            |
| **Free tier**  | your storage bill only             | 50k reads/day, 20k writes/day, 1 GiB stored | project-based (see pricing) | 0.5 GB, 1M calls/mo, 20 GB-hr | 5M rows read/day, 100k rows written/day, 5 GB |

Idle cost is a portfolio story: one amortized floor across a fleet of
mostly-idle apps, not a per-project bill multiplied by forty. The fleet
math lives in [cost-model.md](cost-model.md).

## Reach for…

- **baerly-storage** — you want a database small and safe enough to hand
  to an LLM or a non-engineer and walk away: no migrations, no
  security-policy DSL, no service to operate. The data lives in a bucket
  you already own, nothing new joins your uptime path or your vendor
  list, and the exit is `baerly export` → standard SQL. Best when each
  screen maps to one collection.
- **Firebase** — consumer and mobile apps needing real-time sync at
  scale with mature native SDKs.
- **Supabase** — you need relational queries (joins, full-text search,
  PostGIS); its `pg_dump` exit is every bit as clean as baerly's, into
  the entire Postgres ecosystem.
- **Convex** — real-time collaborative apps built on reactive
  TypeScript. Like baerly-storage it is TypeScript-first and
  low-ceremony; unlike it, Convex is a managed service that holds your
  data and sits in your uptime path, and onboarding it is a new-vendor
  decision.
- **Cloudflare D1** — Workers apps that want SQL and are content to stay
  on Cloudflare.

## When baerly-storage is the wrong fit

Two axes disqualify it, each with its own page:

- **Shape doesn't fit** — core screens need cross-collection joins,
  aggregations, or full-text search. See [workload-fit.md](workload-fit.md).
- **Scale exceeds the envelope** — sustained single-collection write
  contention (roughly above ~30 writes/min, an estimate pending
  real-infra measurement) or high-throughput workloads. See
  [graduation.md](graduation.md).

For real-time push to many clients, Firebase or Convex have better
primitives — baerly-storage offers per-collection long-poll, not a
managed subscription graph.

## Sources

All verified 2026-07-01.

- Firebase: [export/import](https://firebase.google.com/docs/firestore/manage-data/export-import), [pricing](https://firebase.google.com/pricing)
- Supabase: [backups](https://supabase.com/docs/guides/platform/backups), [pricing](https://supabase.com/pricing)
- Convex: [export](https://docs.convex.dev/database/import-export/export), [pricing](https://www.convex.dev/pricing)
- Cloudflare D1: [import/export](https://developers.cloudflare.com/d1/best-practices/import-export-data/), [pricing](https://developers.cloudflare.com/d1/platform/pricing/)
