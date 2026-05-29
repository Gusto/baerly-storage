---
title: Product thesis
audience: product
summary: Why Baerly exists, what it is, and what it deliberately is not.
last-reviewed: 2026-05-28
tags: [positioning, product]
related: [cost-model.md, "../contributing/conventions/change-discipline.md"]
---

# Baerly — product thesis

Baerly is a vendorless document database that runs over any
S3-compatible bucket. Your data lives in your bucket; the protocol
kernel is small enough that an LLM can use the public API zero-shot
from the `.d.ts` files alone. Day-1 templates ship for Cloudflare
Workers (zero infra, free tier, one command to deploy) and
self-hosted Node (your hardware, your bucket, your auth). AWS
Lambda / Bun / Deno / Fly are a paper-thin adapter package away.

This page is the positioning — *why* the system is shaped the way
it is. The narrative long-form is the blog post *Storage is the
Missing Primitive for Agent-Built Software*; the technical detail
lives across the rest of `docs/`.

## The workload shape has changed

The cost of trying a software idea collapsed. Downstream of that is
a new *population* of software: many small, semi-serious artifacts
authored through the agent loop. Dashboards, internal trackers,
personal apps, half-products, sidecars to existing systems. Some
die after a presentation. Some run every Tuesday for five years.
Some accidentally become important. Most live in the wide territory
between toy and production.

You need three primitives to build software in 2026: compute,
tokens, and storage. Compute has an answer (FaaS — pay per request,
scale to zero). Tokens have an answer (POST your prompt, get a
response). **Storage is the hole.** localStorage doesn't survive a
share link; LLM-generated Postgres + RLS is failure-that-
masquerades-as-no-data; a real database invites an agent to
generate the *ceremony* of a real service that the operator never
sees. Baerly is a storage primitive sized for this category.

## What prototype-tier storage needs

The criteria the rest of this document is shaped around:

1. **Idle rounds to zero.** No $5/mo floors multiplied across forty
   abandoned internal tools. A prototype should not accumulate rent
   for existing.
2. **Low operational overhead.** No CVE rotation, no kernel patches,
   no on-call for an app with fifteen users.
3. **Graduation path with no hostage situation.** Prototype-tier
   storage without an exit is deferred migration pain. The day the
   app outgrows the system, leaving has to be mechanical.
   *Graduation is the success path, not a failure mode.* A
   prototype-tier app that crossed the ceiling and moved to D1
   is a Baerly **win**, not a churn event. The "no hostage"
   promise is what makes the prototype-tier bet safe to take. The
   `LogEntry` shape is Postgres-logical-replication-shaped
   (`{lsn, op, relation, key, before?, after?, ts, epoch}`)
   precisely so `baerly export --target=postgres` is mechanical,
   not aspirational.
4. **A small, typed, closed-vocabulary API.** A surface that doesn't
   fit in working memory is a surface that gets called wrong —
   whether the program calling it is an LLM mid-completion or a
   human under deadline. *Type signatures are the contract; JSDoc is
   prose.* The `.d.ts` shapes are the canonical authority; a caller
   should reach the correct call zero-shot from them alone. Two
   failure modes follow:
   - *Hallucinated ceremony* — the agent invents an API the kernel
     does not ship (e.g. `.findOneById()`). The fix is teaching the
     real surface via `@example` blocks and the AGENTS.md quickref.
   - *Redundant ceremony* — the kernel ships two type-valid paths
     for the same operation (e.g. `.get(id)` *and*
     `.where({_id}).first()`). JSDoc steering does not override
     training-distribution priors; the fix is making one of the
     paths not type-check. The additive-only lock on the public
     surface is codified in
     [ADR-002](../adr/002-api-surface-lock.md), which scopes
     "additive" to *capabilities*, not *forms*.
5. **No DDL.** The moment the loop requires `CREATE TABLE`, "invent
   and preserve a schema across edits" is inserted into the part of
   the loop LLMs are worst at (`category` vs `categories` four
   turns later).

Plus one anti-feature:

- **RLS-as-tenancy is out.** Asking an LLM to generate
  `CREATE POLICY` statements over a real customer database places
  the most security-sensitive primitive in the least supervised
  part of the loop. Tenant isolation in Baerly is prefix-scoped at
  the `Db` layer ([ADR-001](../adr/001-tenant-cas-isolation.md)),
  not delegated to generated SQL.

## Why not Postgres

Criteria #2 and #5 above rule out Postgres directly — this is what
that looks like in practice.

**(1) Real DBs entail real obligations.** Provisioning, secrets,
backups, CVE rotation, migrations, alarms when the disk fills,
alarms when the pool is exhausted — none of that becomes free
because the app has four users.

**(2) A DB-shaped tool invites DB-shaped ceremony in the codebase.**
Schemas to invent and preserve across edits, migrations to author and
order, RLS to write — the entire ceremony stack arrives whether the
workload deserves it or not.

## What we keep even when it looks like ceremony

The cutting lens above is strong, and it has three exceptions. A
surface that fails the cutting lens *but* satisfies one of these
stays:

1. **Kernel-bug tripwires.** Surfaces that let maintainers *and
   users* catch protocol regressions before they hit the invoice
   (`baerly cost`'s % of free tier, write-amp counters, op-count
   histograms). The CI gate is the canonical enforcement; the
   user-visible surface is the second line of defence and the
   one users feel first when something drifts.

2. **Empirical LLM ergonomics.** Pre-wired surfaces validated
   against real zero-shot scaffold use stay even when they look
   like ceremony. Pre-installed `vitest` is the canonical case:
   LLMs reach for tests by default, and unsubsidised
   `pnpm install vitest` burns lower-powered-model context. If a
   surface measurably improves zero-shot app construction, it's
   load-bearing.

3. **Audience reach across deploy targets.** "Self-hosted Node"
   means *any* Node target — including container-only,
   air-gapped, or no-PaaS environments. Surfaces that the
   happy-path PaaS audience doesn't need (Dockerfile, `healthz`,
   explicit `node server.js` entry) stay if they unblock a real
   deploy population.

## Why object storage

Two claims, stacked.

**Politically pre-cleared.** Almost every team in every company
already has S3 / R2 / GCS / Azure Blob — for exports, backups,
documents, CSV graveyards. The security review for "give me a
bucket" happened years ago; the budget exists. Object storage is
the only modern infrastructure primitive that is both boring and
almost always available without a new ticket. Hosted alternatives
(D1, Neon, Convex, Supabase, Firebase) are excellent, but each
triggers a fresh vendor procurement review, secrets-manager
integration, and an IT ticket to add a new managed-DB SKU to the
catalog — the bucket already exists.

**Vendor-independent.** D1 / Supabase / Neon / PlanetScale /
Firebase are great, and they are all proprietary runtimes. Object
storage is the rare primitive every cloud implements with the same
abstraction (the S3 API), and the substance is portable by
definition. Your bytes in your bucket — no managed catalog, no
proprietary runtime, leaving needs no vendor cooperation.

## Runtime model: nothing between requests

There is no runtime. None.

Every coordination decision — fencing, conflict resolution, atomic
commit, log emission, index maintenance, garbage collection,
compaction — completes within the lifetime of a single HTTP
request or scheduled cron invocation. The kernel holds no
in-memory state that's load-bearing for correctness; a cold
start reads correctly the same as a warm one. The only
persistent component is the bucket.

This is unusual. Apache Iceberg requires a catalog service.
Delta Lake on S3 requires a DynamoDB lock table. SlateDB is
designed around a long-lived writer and a long-lived compactor.
Cloudflare's Durable Objects is the architectural antithesis —
its pitch is that you *need* a persistent single-threaded
coordinator. Baerly's bet is that you don't, because the
conditional-write primitives that S3, R2, GCS, and Azure Blob
all expose are sufficient — provided the protocol does the work.
The full rationale, comparators, and the rules for what would
break the property are in
[ADR-004](../adr/004-ephemeral-coordination.md).

## Requirements → architecture

Each design choice falls out of a specific criterion above. Built
like git: content-addressed documents, immutable log entries, and a
single CAS-advanced pointer to HEAD.

- **Idle → zero.** Baerly is a ~100 KB gzipped TypeScript library on
  Cloudflare Workers (~155 KB gzipped on Node).
  Your Worker (or Node process) imports it directly. No binary, no
  separate process, no pool / cache / leader. The kernel is
  stateless: ~8 µs router dispatch, then the 5–50 ms waiting on S3,
  and done. The runtime is a rounding error against the bucket.
- **Graduation with no hostage.** The `LogEntry` shape was fixed
  early and is Postgres-logical-replication-shaped:
  `{lsn, op, relation, key, before?, after?, ts, epoch}`. Not
  aesthetic — operational. `baerly export --target=postgres` is a
  mechanical translator, not a marketing line. See
  [docs/spec/log-entry-shape.md](../spec/log-entry-shape.md).
- **Strong consistency under contention.** Old log entries roll up
  into snapshots in the background. Before December 2020,
  S3-as-a-database required a separate linearizable metadata service
  — ZooKeeper, etcd, a DynamoDB lock table, FoundationDB — to hold
  the authoritative pointer to "what exists." After AWS announced
  strong read-after-write consistency on every S3 operation, the
  catalog dissolves into S3 itself, and Iceberg, Delta Lake,
  Turbopuffer, Litestream, and SlateDB all converged on this shape
  after S3 went strongly consistent. See
  [docs/spec/sync-protocol.md](../spec/sync-protocol.md) and
  [docs/spec/s3-features-used.md](../spec/s3-features-used.md).
  Per-collection CAS scope ([ADR-001](../adr/001-tenant-cas-isolation.md))
  is what keeps the idle-poll bound tractable: one cheap key per
  collection, not contention on a global mutex.
- **LLM-legible API.** Document-DB-shaped — closer to Convex than to
  Mongo or Drizzle. `db.collection("name")` is the Mongo-style
  lookup idiom; by-id verbs on the collection handle
  (`.get(id)` / `.update(id, patch)` / `.replace(id, doc)` /
  `.delete(id)`) and the callback-DSL predicate builder are
  Convex's. No SQL builder, no `$`-operators, no standalone
  operator imports. Two predicate shapes — object literal for
  equality (`db.collection('tickets').where({ status: 'open' }).all()`)
  and a callback DSL for the operator vocabulary
  (`db.collection('tickets').where(q => q.gte('priority', 5)).all()`).
  The methods on `PredicateBuilder<T>` ARE the supported vocabulary
  — `or` / `not` / `regex` / `ne` / `exists` cannot be invoked
  because they don't exist. Eight verbs (`first`, `all`, `count`,
  `get`, `insert`, `update`, `replace`, `delete`), three modifiers
  (`where`, `order`, `limit`), six predicate operators (`eq`, `gt`,
  `gte`, `lt`, `lte`, `in`), one transaction. Operators are added
  one at a time, each gated by whether it admits a correct SQL
  translation. The whole interface lives in `.d.ts` files small
  enough that even smaller OSS LLMs can keep them in context. The
  additive-only lock is codified in
  [ADR-002](../adr/002-api-surface-lock.md).

## What this deliberately is not

- **No SQL, no joins, no LSM.** Operators land one at a time, gated
  by a passing SQL-translator test. Equality + dotted-path nesting
  on day one. Honest about the limit; Claude respects documented
  constraints.
- **Browser-direct multi-writer is out.** Trusted multi-instance is
  the design center; browser-direct is a different protocol
  problem and the audience does not need it.
- **Realtime is opt-in.** The HTTP `/v1/since?cursor=<lsn>`
  long-poll is the default change-notification channel; a WebSocket
  tier is opt-in with a documented cost-cliff note. Polling is
  always correct.
- **No automatic schema migration.** Migrations are versioned
  scripts.
- **No multi-bucket replication / fan-out / mirroring.** R2's own
  replication tier handles read fan-out.
- **No on-disk caches.** Object storage + the platform's HTTP cache
  (CF Cache API on the CF target, none on Node by default) + small
  in-memory caches only.
- **Cost is decisive on some axes, a loss on others — we name
  both.** At the audience operating point (idle × N portfolio,
  small high-cardinality apps), Baerly rounds to zero against
  per-app managed-DB floors. At M-size, D1 wins per-write
  (~$5 vs. ~$19) where it's available — that's the graduation
  signal, not a competitive position. Availability and switching
  cost both favor Baerly: any S3-API cloud, any Node runtime,
  Postgres-logical-replication-shaped log entries. See
  [cost-model.md](cost-model.md) for the operating-point tables
  and per-line-item rates.
- **Not a D1 / Postgres replacement.** D1 is the graduation target.
  Baerly's job is to keep the experiment cheap and fast until the
  user knows whether it's worth graduating. Graduation is a tool we
  ship, not a feature we promise.

## Workload ceiling

A system that names its envelope honestly is a system you can trust.
Baerly's envelope is precise — not because those are the only
workloads we want, but because knowing exactly where graduation
starts makes graduation a feature rather than a surprise.

The envelope:

- **~10 GB / tenant** total.
- **~30 logical writes / minute / collection** sustained. This
  ceiling reflects the CAS-livelock regime documented in the
  S3-as-database literature at ~5 writes/sec/object; per-collection
  CAS scope ([ADR-001](../adr/001-tenant-cas-isolation.md)) is what
  buys the operating headroom.
- **~100 collections / tenant** fan-out.

Crossing any of these is the success signal to graduate —
`baerly export --target=postgres` is one command, and the on-disk
log shape is Postgres-logical-replication-shaped to make it
mechanical. The ceiling is platform-independent — the kernel makes
the same guarantees on Cloudflare Workers, self-hosted Node, AWS
Lambda. One bucket per app; tenants are prefix-scoped within.
Server-only writes; the browser is a typed HTTP client.

## Audience in practice

The workload shape produces a population, not a single persona.
Baerly is the storage primitive matched to all of them:

- A finance team whose dashboard has so far been a forty-line
  Claude Artifact with the data baked into the HTML.
- A PM at a 10,000-person company building an internal laptop-
  request tracker without an IT ticket for a managed database.
- An engineer's Saturday side project that might — or might not —
  accidentally become important.
- A $20/mo ChatGPT subscriber with a dream.

All of them author through the same loop. None of them want to own
a long-running service to find out whether the app deserves one.
