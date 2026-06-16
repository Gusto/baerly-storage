---
title: Product thesis
audience: product
summary: Why Baerly exists, what it is, and what it deliberately is not.
last-reviewed: 2026-06-14
tags: [positioning, product]
related: [cost-model.md, "../contributing/conventions/change-discipline.md"]
---

# Baerly — product thesis

Baerly is a vendorless document database. **AWS S3 and Cloudflare R2 are
supported** (CI-conformance-gated); other S3-compatible stores are
conformance-gated, not promised — run the live CAS probe in
`baerly doctor --bucket` first (green ⇒ should work, you own it).
Your data lives in your bucket; the
protocol kernel is small enough that an LLM can use the public API
zero-shot from the `.d.ts` files alone. Day-1 templates ship for
Cloudflare Workers (zero infra, free tier, one command to deploy)
and self-hosted Node (your hardware, your bucket, your auth). AWS
Lambda / Bun / Deno / Fly are not shipped targets yet; they are a
paper-thin adapter package away from the same protocol kernel.

This page is the positioning — _why_ the system is shaped the way
it is. The narrative long-form is the blog post _Storage is the
Missing Primitive for Agent-Built Software_; the technical detail
lives across the rest of `docs/`.

## The workload shape has changed

The cost of trying a software idea collapsed. Downstream of that is
a new _population_ of software: many small, semi-serious artifacts
authored through the agent loop. Dashboards, internal trackers,
personal apps, half-products, sidecars to existing systems. Some
die after a presentation. Some run every Tuesday for five years.
Some accidentally become important. Most live in the wide territory
between toy and production.

You need three primitives to build software in 2026: compute,
tokens, and storage. Compute has an answer (FaaS — pay per request,
scale to zero). Tokens have an answer (POST your prompt, get a
response). **Storage is the missing primitive.** localStorage doesn't
survive a share link; LLM-generated Postgres + RLS is failure-that-
masquerades-as-no-data; a real database invites an agent to
generate the _ceremony_ of a real service that the operator never
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
   _Graduation is the success path, not a failure mode._ A
   prototype-tier app that crossed the ceiling and moved to D1
   is a Baerly **win**, not a churn event. The "no hostage"
   promise is what makes the prototype-tier bet safe to take. Snapshot
   export is shipped today. The `LogEntry` shape is a Debezium-style CDC envelope
   (`{lsn, commit_ts, op, collection, doc_id, after?, before?, key_old?, origin?, session, seq}`)
   precisely so the incremental CDC exit remains mechanical, not
   aspirational.
4. **A small, typed, closed-vocabulary API.** A surface that doesn't
   fit in working memory is a surface that gets called wrong —
   whether the program calling it is an LLM mid-completion or a
   human under deadline. _Type signatures are the contract; JSDoc is
   prose._ The `.d.ts` shapes, `dist/API.md`, and the scaffold
   `AGENTS.md` quickref must all teach one small surface; a caller
   should reach the correct call zero-shot from those files without
   inventing ceremony. Two failure modes follow:
   - _Hallucinated ceremony_ — the agent invents an API the kernel
     does not ship (e.g. `.findOneById()`). The fix is teaching the
     real surface via `@example` blocks and the AGENTS.md quickref.
   - _Redundant ceremony_ — the kernel ships two type-valid paths
     for the same operation (e.g. `.get(id)` _and_
     `.where({_id}).first()`). JSDoc steering does not override
     training-distribution priors; the fix is making one of the
     paths not type-check. The additive-only lock on the public
     surface is codified in
     [ADR-002](../adr/002-api-surface-lock.md), which scopes
     "additive" to _capabilities_, not _forms_.
5. **No DDL.** The moment the loop requires `CREATE TABLE`, "invent
   and preserve a schema across edits" is inserted into the part of
   the loop LLMs are worst at (`category` vs `categories` four
   turns later).
6. **Zero operator burden.** No cron to schedule, no sidecar to run, no
   scheduler to provision, no lock service, no managed catalog. The full
   operator action set is "create a bucket; run the kernel inside an HTTP
   handler." If a feature needs `wrangler.jsonc` edits beyond auth, a
   `node-cron` install, or any "step 2: also configure…" — it's the wrong
   shape for this audience. The closest production precedent is
   PostgreSQL autovacuum / HOT pruning: _the user never schedules
   ordinary storage maintenance_. Baerly generalizes the unscheduled,
   bounded-maintenance part of that precedent to object storage:
   maintenance runs opportunistically on writes, gated so idle buckets
   pay zero. Reads stay pure.

Plus one anti-feature:

- **RLS-as-tenancy is out.** Asking an LLM to generate
  `CREATE POLICY` statements over a real customer database places
  the most security-sensitive primitive in the least supervised
  part of the loop. Tenant isolation in Baerly is prefix-scoped at
  the `Db` layer ([ADR-001](../adr/001-tenant-cas-isolation.md)),
  not delegated to generated SQL.

## Two audiences, two pitches

The criteria above split cleanly across two audiences with different value
props. The docs should not conflate them.

- **For agents and authors writing code** — criterion #4 (LLM-legible API).
  The pitch is _closed-vocabulary, types-as-contract, zero-shot from .d.ts
  alone_. This audience reads the public surface.
- **For platform teams deploying it** — criterion #6 (Zero operator burden).
  The pitch is _no cron, no sidecar, no scheduler, no on-call_. This
  audience reads the deployment story and the runtime model. They care that
  the bucket maintains itself with no intervention.

A design choice that improves one audience without harming the other is a
win. A design choice that improves authoring DX by adding operator chores
(or vice versa) is a regression. When in doubt, the authoring audience wins.
Zero operator burden is the enabler of that goal, not the goal itself: without
it, the deployment friction that blocks builders never clears.

**The operational surface stays off the authoring surface.** App
authors define collections and call a document API; operators set auth,
storage credentials, and the rare maintenance env var in the deploy
environment. A knob the app-authoring agent can see is a knob it will
eventually tune, so ordinary storage maintenance stays automatic and
bounded — a field may be typed in the `.d.ts` yet deliberately absent
from `API.md`, the surface the authoring agent actually reads. Detailed
API/reference ownership lives in
[docs conventions](../contributing/conventions/docs.md); the public
surface lock lives in [ADR-002](../adr/002-api-surface-lock.md).

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
surface that fails the cutting lens _but_ satisfies one of these
stays:

1. **Kernel-bug tripwires.** Surfaces that let maintainers _and
   users_ catch protocol regressions before they hit the invoice
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
   means _any_ Node target — including container-only,
   air-gapped, or no-PaaS environments. Surfaces that the
   happy-path PaaS audience doesn't need (Dockerfile, `healthz`,
   explicit Node start entry) stay if they unblock a real
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
storage is the rare primitive with a common dialect — the S3 API —
that S3, R2, and MinIO speak with the conditional-write semantics
Baerly's coordination needs; those are the stores the CAS contract
is proven against and that `baerly doctor --bucket` gates on (see
[ADR-004](../adr/004-ephemeral-coordination.md)). Azure Blob's
non-S3 dialect and GCS's read-only S3-interop conditional writes
each need a dedicated adapter that doesn't exist yet — but the
substance is portable by definition. Your bytes in your bucket — no
managed catalog, no proprietary runtime, leaving needs no vendor
cooperation.

## Runtime model: nothing resident between requests

There is no runtime. None. And there is no scheduler either.

Every coordination decision — fencing, conflict resolution, atomic
commit, log emission, index maintenance, garbage collection,
compaction — is bounded to the request path. Cloudflare may finish the
maintenance tick after the response with `ctx.waitUntil`; Node runs it
inline unless a host wraps dispatch differently. The kernel holds no
in-memory state that's load-bearing for correctness; a cold start reads
correctly the same as a warm one. The only persistent component is the
bucket. **No cron, no sidecar, no `setInterval`, no scheduled handler is
required for correctness.** Maintenance runs opportunistically on the
write path — **reads are pure; they never tick** — gated by a size-ratio
threshold so idle buckets pay zero. Keeping reads pure is exactly what
preserves the published idle-reader cost bound. The pattern is
PostgreSQL HOT pruning generalized to object storage in the one way
that matters here: cheap gate on hot-path operations, bounded work when
the gate fires, no operator chore to schedule it. Users who _want_
batched maintenance windows can invoke `runScheduledMaintenance` from
their own scheduler — it's an SDK function, never a deployment
requirement. Scaffolds ship with zero cron wiring.

This is unusual. Apache Iceberg requires a catalog service.
Delta Lake on S3 requires a DynamoDB lock table. SlateDB is
designed around a long-lived writer and a long-lived compactor.
Cloudflare's Durable Objects is the architectural antithesis —
its pitch is that you _need_ a persistent single-threaded
coordinator. Baerly's bet is that you don't, because the
conditional-write contract (`If-Match` / `If-None-Match` on
ETags) that S3-compatible object stores expose is sufficient —
provided the protocol does the work.
The full rationale, comparators, and the rules for what would
break the property are in
[ADR-004](../adr/004-ephemeral-coordination.md).

## Requirements → architecture

Each design choice falls out of a specific criterion above. Built
like git: content-addressed documents, immutable numbered log entries,
and one conditional log create as the commit.

- **Idle → zero.** Baerly is a TypeScript library — the full
  Cloudflare Workers bundle (`cloudflare.js`) is ~113 KB gzipped,
  the Node HTTP closure (`http.js`) ~94 KB gzipped.
  Your Worker (or Node process) imports it directly. No binary, no
  separate process, no pool / cache / leader. The kernel is
  stateless; the request mostly waits on object storage. The runtime
  is a rounding error against the bucket.
- **Graduation with no hostage.** The `LogEntry` shape was fixed
  early as a Debezium-style CDC envelope:
  `{lsn, commit_ts, op, collection, doc_id, after?, before?, key_old?, origin?, session, seq}`. Not
  aesthetic — operational. Snapshot export to SQL is shipped; the log
  shape keeps incremental CDC export mechanical rather than a marketing
  line. See
  [log-entry-shape.md](../spec/log-entry-shape.md).
- **Strong consistency under contention.** Old log entries roll up
  into snapshots through bounded write-triggered maintenance. Before
  December 2020,
  S3-as-a-database required a separate linearizable metadata service
  — ZooKeeper, etcd, a DynamoDB lock table, FoundationDB — to hold
  the authoritative pointer to "what exists." After AWS announced
  strong read-after-write consistency on every S3 operation, the
  catalog dissolves into S3 itself, and Iceberg, Delta Lake,
  Turbopuffer, Litestream, and SlateDB all converged on this shape
  after S3 went strongly consistent. See
  [sync-protocol.md](../spec/sync-protocol.md) and
  [storage-compatibility.md](../spec/storage-compatibility.md).
  Per-collection commit scope
  ([ADR-001](../adr/001-tenant-cas-isolation.md)) is what keeps the
  idle-poll bound tractable: one cheap log series and one compaction
  bookmark per collection, not contention on a global mutex.
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
  `gte`, `lt`, `lte`, `in`). Operators are added
  one at a time, each gated by whether it admits a correct SQL
  translation. Day-one ships equality, dotted paths, ordered reads,
  and the `eq` / `gt` / `gte` / `lt` / `lte` / `in` predicate
  operators. The whole interface lives in `.d.ts` files small
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
- **Realtime is long-poll first.** The HTTP
  `/v1/since?collection=<name>&cursor=<opaque>` long-poll is the
  default change-notification channel; a WebSocket tier would be a
  future opt-in with a documented cost-cliff note. Polling is always
  correct.
- **No generated schema-migration ceremony.** Ordinary schema shape
  changes are config and validator edits, not DDL. Data migrations are
  explicit versioned scripts.
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
  cost both favor Baerly: any conformant S3-API cloud (S3, R2), any Node runtime,
  Debezium-style CDC log entries. See
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
  commit scope ([ADR-001](../adr/001-tenant-cas-isolation.md)) is what
  buys the operating headroom.
- **~100 collections / tenant** fan-out.

Crossing any of these is the success signal to graduate —
`baerly export --target=postgres --collection=<name>` dumps a
collection's snapshot to SQL (run it per collection for a whole app),
and the on-disk log shape is a Debezium-style CDC envelope so a future
incremental exit stays mechanical. The ceiling is protocol-level:
today it is shipped on Cloudflare Workers and self-hosted Node; future
Lambda / Bun / Deno / Fly adapters inherit the same bucket protocol.
One bucket per app; tenants are prefix-scoped within. Server-only
writes; the browser is a typed HTTP client.

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
