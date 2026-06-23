---
title: Product thesis
audience: product
summary: Why baerly-storage exists, what it is, and what it deliberately is not.
last-reviewed: 2026-06-23
tags: [positioning, product]
related: [workload-fit.md, cost-model.md, graduation.md, "../contributing/conventions/change-discipline.md"]
---

# baerly-storage — product thesis

baerly-storage is for live application data, but it is not a database
service that happens to store bytes in S3. The database is a bucket
layout plus a commit protocol. The implementation shipped today is a
set of TypeScript libraries for Worker and Node apps.

That shape is the product: your data lives in your bucket, and the
library runs inside the trusted request handler where the bucket
credentials safely live. **AWS S3 and Cloudflare R2 are supported.**
Other S3-compatible endpoints are not promised; run the live
conditional-write probe in `baerly doctor --bucket` first (green ⇒
should work, you own production validation).
The public surface is intentionally small enough for an LLM to learn
from the `.d.ts` files. Day-1 templates ship for Cloudflare Workers
(no separate database server, free tier, one command to deploy) and
self-hosted Node (your hardware, your bucket, your auth). AWS Lambda /
Bun / Deno / Fly are not shipped targets yet; they need adapter
packages over the same protocol kernel.

This page is the positioning — _why_ the system is shaped the way
it is. The narrative long-form is the blog post _Storage is the
Missing Primitive for Agent-Built Software_; the technical detail
lives across the rest of `docs/`.

## The workload shape has changed

The cost of trying a software idea collapsed. Downstream of that is
a new _population_ of software: many small apps with uncertain
lifespans and mixed criticality, authored through the agent loop.
Dashboards, internal trackers, personal apps, workflow sidecars. Some
run for a week. Some run every Tuesday for five years. Some become
important. Most live in the wide territory between toy and
production.

You need three primitives to build software in 2026: compute,
tokens, and storage. Compute has an answer (FaaS — pay per request,
scale to zero). Tokens have an answer (POST your prompt, get a
response). **Storage is the missing primitive.**

The missing piece shows up in small failures first. `localStorage`
doesn't survive a share link. LLM-generated Postgres + RLS can return
empty arrays when a policy is wrong, which looks like no data instead
of a broken authorization rule. A real database invites an agent to
generate the _ceremony_ of a real service that the operator never
sees. baerly-storage is a storage primitive sized for the territory
between toy and production.

Better models do not remove that need. A stronger agent in a smaller,
clearer system beats the same agent loose in a larger one. Reducing
surface area, picking boring tools, and making invalid states
unrepresentable makes the result easier for humans and agents to
verify.

## What prototype-tier storage needs

Sandboxes and review bots reduce blast radius after the tool has
already chosen a storage shape. baerly-storage supplies the other
half of the answer: a safer default shape for live data.

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
   prototype-tier app that crossed the ceiling and moved to Cloudflare
   D1 or Postgres is a baerly-storage **win**, not a churn event. The
   "no hostage" promise is what makes the prototype-tier bet safe to take.
   Snapshot export is shipped today. The `LogEntry` shape is a
   change-data-capture envelope, using field names familiar from
   Debezium, so a future incremental CDC exit remains straightforward
   rather than aspirational.
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
     "additive" to _capabilities_, not _forms_. The lock is soft
     until v1.0 — removals are allowed only through the staged
     deprecation lifecycle in that ADR, never as a silent break.
5. **No DDL.** The moment the loop requires `CREATE TABLE`, "invent
   and preserve a schema across edits" is inserted into the part of
   the loop LLMs are worst at (`category` vs `categories` four
   turns later).
6. **Zero operator burden.** No cron to schedule, no sidecar to run, no
   scheduler to provision, no lock service, no managed catalog. The full
   operator action set is "create a bucket; run the kernel inside an HTTP
   handler." If a feature needs `wrangler.jsonc` edits beyond auth, a
   `node-cron` install, or any "step 2: also configure…" — it's the wrong
   shape for this audience.

Plus one anti-feature:

- **RLS-as-tenancy is out.** Asking an LLM to generate
  `CREATE POLICY` statements over a real customer database places
  the most security-sensitive primitive in the least supervised
  part of the loop. Tenant isolation in baerly-storage is prefix-scoped
  at the `Db` layer ([ADR-001](../adr/001-tenant-cas-isolation.md)),
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
bounded. Runtime or operator fields may still be typed for configuration,
but they stay out of the app-authoring quickref and examples unless an
author must set them. Detailed API/reference ownership lives in
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

## Why object storage

Object storage is chosen because the bucket is usually already
approved, and because the hot commit path only needs one coordination
primitive from the store: atomically create the numbered log object if
the key is absent, and reject the rest. The full storage contract also
requires strong read-after-write/list consistency and `If-Match` CAS for
`current.json` compaction; the S3 API exposes those through consistency
guarantees and conditional writes.

**Politically pre-cleared.** Almost every team in every company
already has S3 / R2 / GCS / Azure Blob — for exports, backups,
documents, archives, analytics drops. That political fact is not the
same as database-protocol support, but the security review for "give me
a bucket" happened years ago; the budget exists. Object storage is the
modern infrastructure primitive most likely to be both boring and
available without a new ticket. Hosted alternatives (D1, Neon,
Convex, Supabase, Firebase) are excellent, but each triggers a fresh
vendor procurement review, secrets-manager integration, and an IT
ticket to add a new managed-DB SKU to the catalog. The bucket already
exists.

**Vendor-independent where the contract holds.** D1 / Supabase /
Neon / PlanetScale / Firebase are great, and they are all
proprietary runtimes. Object storage is the rare primitive with a
common dialect — the S3 API. The production-supported backends are AWS
S3 and Cloudflare R2; MinIO is the local conformance target, and other
S3-compatible endpoints require a green `baerly doctor --bucket` plus
owner validation (see
[storage-compatibility.md](../spec/storage-compatibility.md) and
[ADR-004](../adr/004-ephemeral-coordination.md)). Azure Blob's non-S3
dialect and GCS's read-only S3-interop conditional writes each need a
dedicated adapter that doesn't exist yet. Your bytes stay in your
bucket; protocol support belongs to adapters and backends that pass the
storage contract.

## Runtime model: nothing resident between requests

Most database-shaped systems keep something awake between requests: a
server, a catalog, a lock table, a compactor, a scheduler. The
baerly-storage rule is stricter: each request reads the bucket state,
tries the conditional log create that commits the write, and leaves no
required process behind.

Concretely, every coordination decision — fencing, conflict
resolution, atomic commit, log emission, index maintenance, garbage
collection, compaction — is bounded to the request path. Cloudflare
may finish the maintenance tick after the response with
`ctx.waitUntil`; Node runs it inline unless a host wraps dispatch
differently. The kernel holds no in-memory state needed for
correctness; a cold start reads correctly the same as a warm one. The
only persistent data component is the bucket. **No cron, no sidecar,
no `setInterval`, no scheduled handler is required for correctness.**
Maintenance runs opportunistically on the write path — **reads are
pure; they never tick** — gated by a size-ratio threshold so idle
buckets pay zero. Keeping reads pure is what preserves the published
idle-reader cost bound. The pattern echoes PostgreSQL autovacuum / HOT
pruning in the one way that matters here: ordinary maintenance is
bounded, automatic, and not a user-scheduled chore. Users who _want_
batched maintenance windows can invoke `runScheduledMaintenance` from
their own scheduler — it's an SDK function, never a deployment
requirement. Scaffolds ship with zero cron wiring.

The subtle part is coordination. Apache Iceberg requires a catalog
service. Delta Lake on S3 uses a DynamoDB lock table for multi-cluster
S3 writes. SlateDB is designed around a long-lived writer and a
long-lived compactor. Cloudflare Durable Objects are stateful named
coordinators with colocated durable storage. baerly-storage's bet is
that you don't need a resident coordinator for this workload, because
the conditional-write contract (`If-Match` / `If-None-Match` on ETags)
that supported object stores expose is sufficient — provided the
protocol does the work.
The full rationale, comparators, and the rules for what would
break the property are in
[ADR-004](../adr/004-ephemeral-coordination.md).

## Requirements → architecture

Each design choice falls out of a specific criterion above. The rough
shape is git-like: immutable content, an append-only history, and a
small pointer. More precisely, baerly-storage stores
content-addressed documents, immutable numbered log entries, and one
conditional log create as the commit, per collection.

- **Idle → zero.** baerly-storage is a TypeScript library — the full
  Cloudflare Workers bundle (`cloudflare.js`) is budgeted at 117 KiB
  gzipped, and the Node HTTP closure (`http.js`) at 99 KiB gzipped.
  Your Worker (or Node process) imports it directly. No binary, no
  separate process, no pool / cache / leader. The kernel is
  stateless; the request mostly waits on object storage. The
  request-handler work is a rounding error against the bucket.
- **Graduation with no hostage.** The `LogEntry` shape is a
  Debezium-style CDC envelope:
  `{lsn, commit_ts, op, collection, doc_id, after?, before?, key_old?, origin?, session, seq}`. Not
  aesthetic — operational. Pre-launch it may still narrow; after the
  first production consumer, removing, renaming, or repurposing fields
  is a major-version migration. Snapshot export to SQL is shipped; the
  log shape is intended to keep future incremental CDC export mechanical
  rather than a marketing line. See
  [log-entry-shape.md](../spec/log-entry-shape.md).
- **Strong consistency under contention.** Old log entries roll up
  into snapshots through bounded write-triggered maintenance. The
  hard part is deciding which writer won without a resident
  coordinator. Before December 2020, S3-as-a-database required a
  separate linearizable metadata service — ZooKeeper, etcd, a
  DynamoDB lock table, FoundationDB — to hold the authoritative
  pointer to "what exists." After AWS announced strong
  read-after-write consistency on every S3 operation, baerly-storage's
  catalog-free protocol became viable when combined with
  exactly-one-winner conditional creates. See
  [sync-protocol.md](../spec/sync-protocol.md) and
  [storage-compatibility.md](../spec/storage-compatibility.md).
  Per-collection commit scope
  ([ADR-001](../adr/001-tenant-cas-isolation.md)) is what keeps the
  idle-poll bound tractable: one cheap log series and one compaction
  bookmark per collection, not contention on a global mutex.
- **LLM-legible API.** Document-DB-shaped — closer to Convex than to
  Mongo or Drizzle. The important property is a closed vocabulary:
  unsupported spellings are not hidden options, they are absent
  types. `db.collection("name")` is the Mongo-style lookup idiom;
  by-id verbs on the collection handle
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
  operators. The whole interface is intentionally kept small enough to
  fit in an authoring agent's context. The additive-only lock is
  codified in [ADR-002](../adr/002-api-surface-lock.md).

## What this deliberately is not

- **No SQL, no joins, no LSM.** Operators land one at a time, gated
  by a passing SQL-translator test. Equality + dotted-path nesting
  on day one. The limit is part of the contract.
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
  both.** baerly-storage wins when the cost line is idle portfolios,
  per-app managed-DB floors, and exit control. At high write volume,
  D1 can be cheaper per write where it is available; that is the
  graduation signal, not a competitive position. See
  [cost-model.md](cost-model.md) for the operating-point tables
  and per-line-item rates.
- **Not a D1 / Postgres replacement.** D1 and Postgres are graduation targets.
  baerly-storage's job is to keep the experiment cheap and fast until the
  user knows whether it's worth graduating. Snapshot SQL export ships
  today; incremental CDC is future-facing protocol work.

## Workload ceiling

A system that names its envelope honestly is a system you can trust.
baerly-storage's envelope is precise — not because those are the only
workloads we want, but because knowing exactly where graduation
starts makes graduation a feature rather than a surprise.

The envelope:

- **~30 logical writes / minute / collection** sustained. This ceiling
  follows from the raw S3-CAS conditional-PUT rate divided by baerly's
  measured write-amplification (see [ADR-001](../adr/001-tenant-cas-isolation.md)
  and [cost-model.md](cost-model.md)); per-collection commit scope is what
  buys the operating headroom.
- **>10 GB / tenant stored** — the R2 free-tier storage line (a cost
  signal, not a protocol ceiling). A tenant is a key prefix; baerly-storage
  enforces no per-tenant byte limit. Once stored bytes cross the R2
  free-tier (10 GB-mo), storage billing begins; see
  [cost-model.md](cost-model.md) for rates.
- **~100 collections / tenant** fan-out — a bench-grounded soft guideline
  (erosion, not a cliff). The `admin usage` sweep grows linearly with
  collection count; ~100 is the range where sweep cost becomes noticeable.
  Nothing in the protocol enforces a per-tenant collection cap.

The cost model can advise graduation earlier; for example, Class A ops
`> 50M/mo` is the published cost trigger. That is a separate axis from
the workload envelope above.
Before counting that axis, run the qualitative shape test in
[workload-fit.md](workload-fit.md): a product whose core screen is the
view across collections is the wrong starting point at any size.

Crossing any of these is the success signal to graduate. For example,
`baerly export --target=postgres ...` dumps a collection's snapshot to
SQL; `--bucket`, `--app`, `--tenant`, and `--collection` identify the
source, and you run it per collection for a whole app. The same log
shape is intended to keep a future incremental exit straightforward.
The protocol currently ships on Cloudflare Workers and self-hosted
Node; future Lambda / Bun / Deno / Fly adapters inherit the same
bucket protocol.
One bucket per app; tenants are prefix-scoped within. Server-only
writes; the browser is a typed HTTP client.

## Audience in practice

The workload shape produces a population, not a single persona.
baerly-storage is the storage primitive matched to all of them:

- A finance team whose dashboard has so far been a forty-line
  Claude Artifact with the data baked into the HTML.
- A PM at a 10,000-person company building an internal laptop-
  request tracker without an IT ticket for a managed database.
- An engineer's Saturday side project that may or may not become
  important.
- An individual builder who needs a shareable app before they know
  whether it deserves standing infrastructure.

All of them author through the same loop. None of them want to own
a long-running service to find out whether the app deserves one.
