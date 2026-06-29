---
title: Product thesis
audience: product
summary: Why baerly-storage exists, what it is, and what it deliberately is not.
last-reviewed: 2026-06-26
tags: [positioning, product]
related: [workload-fit.md, cost-model.md, graduation.md, "../contributing/conventions/change-discipline.md"]
---

# baerly-storage — product thesis

baerly-storage is for live application data that has outgrown a browser
tab, but has not yet earned a database service. It is a bucket layout
plus a commit protocol, shipped today as TypeScript libraries for Worker
and Node apps. Everything else follows from that: no resident database
server, a small authoring surface, and a mechanical exit path.

That shape is the product: your data lives in your bucket, and the
library runs inside the trusted request handler where the bucket
credentials safely live. **AWS S3 and Cloudflare R2 are supported.**
Other S3-compatible endpoints are not promised; run the live
conditional-write probe in `baerly doctor --bucket=<uri>` first
(green ⇒ should work, you own production validation).

The public surface is intentionally small enough for an LLM to learn
from the `.d.ts` files. Day-1 templates ship for Cloudflare Workers
(no separate database server, free tier, one command to deploy) and
self-hosted Node (your hardware, your bucket, your auth). AWS Lambda /
Bun / Deno / Fly are not shipped targets yet; they need adapter
packages over the same protocol kernel.

This page is the positioning — _why_ the system is shaped this way. The
narrative long-form is the blog post _Storage is the Missing Primitive
for Agent-Built Software_; the technical detail lives across `docs/`.

## The workload shape has changed

It is now cheap to try a software idea. That creates many small apps
with uncertain lifespans and mixed criticality: dashboards, internal
trackers, personal apps, workflow sidecars. Some run for a week. Some
run every Tuesday for five years. Some become important. Most live
between toy and production.

You need three primitives to build software in 2026: compute, tokens,
and storage. Compute has an answer (FaaS — pay per request, scale to
zero). Tokens have an answer (POST your prompt, get a response).
**Storage is the missing primitive.**

The gap shows up as small failures. `localStorage` does not survive a
share link. LLM-generated Postgres + RLS can return empty arrays when a
policy is wrong, which looks like no data instead of broken
authorization. A real database invites an agent to generate the
_ceremony_ of a real service that the operator never sees.
baerly-storage is a storage primitive sized for the territory between
toy and production.

Better models do not remove that need. A stronger agent in a smaller
system beats the same agent loose in a larger one. Reducing surface
area, choosing boring tools, and making invalid states unrepresentable
makes the result easier for humans and agents to verify.

## What prototype-tier storage needs

Prototype-tier does not mean fake data. It means live data while the
operator is still learning whether the app deserves standing
infrastructure. Sandboxes and review bots reduce blast radius after a
tool has chosen a storage shape; baerly-storage supplies the safer
default shape.

The criteria the rest of this document is shaped around:

1. **Idle rounds to zero.** No $5/mo floors multiplied across forty
   abandoned internal tools. A prototype should not accumulate rent for
   merely existing.
2. **Low operational overhead.** No CVE rotation, no kernel patches, no
   on-call for an app with fifteen users.
3. **Graduation path with no hostage situation.** Prototype-tier
   storage without an exit is deferred migration pain. The day the app
   outgrows the system, leaving has to be mechanical. _Graduation is the
   success path, not a failure mode._ When an app crosses the ceiling and
   moves to Cloudflare D1 or Postgres, that is a baerly-storage **win**,
   not a churn event. Snapshot export is shipped today. The `LogEntry`
   shape is a change-data-capture envelope, using field names familiar
   from Debezium, so a future incremental CDC exit remains
   straightforward rather than aspirational.
4. **A small, typed, closed-vocabulary API.** A surface that does not
   fit in working memory is a surface that gets called wrong, whether
   the caller is an LLM mid-completion or a human under deadline. _Type
   signatures are the contract; JSDoc is prose._ The `.d.ts` shapes,
   `dist/API.md`, and the scaffold `AGENTS.md` quickref must all teach
   one small surface; a caller should reach the correct call zero-shot
   from those files without inventing ceremony.

   Two failure modes follow:

   - _Hallucinated ceremony_ — the agent invents an API the kernel does
     not ship (e.g. `.findOneById()`). The fix is `@example` blocks and
     the AGENTS.md quickref teaching the real surface.
   - _Redundant ceremony_ — the kernel ships two type-valid paths for
     the same operation (e.g. `.get(id)` _and_
     `.where({_id}).first()`). JSDoc steering does not override
     training-distribution priors; the fix is making one path not
     type-check. The
     [API surface lock](../contributing/conventions/change-discipline.md#api-surface-lock)
     codifies the additive-only lock and scopes "additive" to
     _capabilities_, not _forms_. The lock is soft until v1.0 — removals
     are allowed only through the staged deprecation lifecycle recorded
     there, never as a silent break.
5. **No DDL.** The moment the loop requires `CREATE TABLE`, "invent and
   preserve a schema across edits" enters the part of the loop where
   small naming drift is costly (`category` vs. `categories` four turns
   later).
6. **Zero operator burden.** No cron to schedule, no sidecar to run, no
   scheduler to provision, no lock service, no managed catalog. The full
   operator action set is "create a bucket; run the kernel inside an
   HTTP handler." If a feature needs `wrangler.jsonc` edits beyond auth,
   a `node-cron` install, or any "step 2: also configure…" — it is the
   wrong shape for this audience.

Plus one anti-feature:

- **RLS-as-tenancy is out.** Asking an LLM to generate
  `CREATE POLICY` statements over a real customer database places the
  most security-sensitive primitive in the least supervised part of the
  loop. Tenant isolation in baerly-storage is prefix-scoped at the `Db`
  layer ([ADR-001](../adr/001-tenant-cas-isolation.md)), not delegated
  to generated SQL.

## Two audiences, two pitches

The criteria split across two audiences:

| Audience | Criterion | Pitch | Reads |
| --- | --- | --- | --- |
| Agents and authors writing code | #4, LLM-legible API | _Closed vocabulary, types as contract, zero-shot from .d.ts alone_ | The public surface |
| Platform teams deploying it | #6, zero operator burden | _No cron, no sidecar, no scheduler, no on-call_ | The deployment story and runtime model |

A design choice that improves one audience without harming the other is
a win. A choice that improves authoring DX by adding operator chores, or
vice versa, is a regression. When in doubt, the authoring audience wins.
Zero operator burden enables that goal; without it, deployment friction
blocks builders.

**The operational surface stays off the authoring surface.** App
authors define collections and call a document API. Operators set auth,
storage credentials, and the rare maintenance env var in the deploy
environment. A knob the app-authoring agent can see is a knob it will
eventually tune, so ordinary storage maintenance stays automatic and
bounded. Runtime or operator fields may still be typed for
configuration, but they stay out of the app-authoring quickref and
examples unless an author must set them. Detailed API/reference
ownership lives in [docs conventions](../contributing/conventions/docs.md);
the public surface lock lives in
[change-discipline.md](../contributing/conventions/change-discipline.md#api-surface-lock).

## Why not Postgres

Criteria #2 and #5 rule out Postgres directly:

1. **Real DBs entail real obligations.** Provisioning, secrets, backups,
   CVE rotation, migrations, alarms when the disk fills, alarms when the
   pool is exhausted — none of that becomes free because the app has four
   users.
2. **A DB-shaped tool invites DB-shaped ceremony in the codebase.**
   Schemas to invent and preserve across edits, migrations to author and
   order, RLS to write — the ceremony stack arrives whether the workload
   deserves it or not.

## Why object storage

Object storage is chosen because the bucket is usually already approved,
and because the hot commit path needs one coordination primitive from
the store: atomically create the numbered log object if the key is
absent, and reject the rest. The full storage contract also requires
strong read-after-write/list consistency and `If-Match` CAS for
`current.json` compaction; the S3 API exposes those through consistency
guarantees and conditional writes.

**Politically pre-cleared.** Almost every team already has S3 / R2 /
GCS / Azure Blob for exports, backups, documents, archives, or analytics
drops. That is not database-protocol support, but the security review
for "give me a bucket" happened years ago; the budget exists. Hosted
alternatives (D1, Neon, Convex, Supabase, Firebase) are excellent, but
each triggers a fresh vendor procurement review, secrets-manager
integration, and an IT ticket to add a new managed-DB SKU to the
catalog. The bucket already exists.

**Vendor-independent where the contract holds.** D1 / Supabase / Neon /
PlanetScale / Firebase are great, and they are all proprietary runtimes.
Object storage is the rare primitive with a common dialect — the S3 API.
The production-supported backends are AWS S3 and Cloudflare R2; MinIO is
the local conformance target, and other S3-compatible endpoints require
a green `baerly doctor --bucket=<uri>` plus owner validation (see
[storage-compatibility.md](../spec/storage-compatibility.md) and
[ADR-002](../adr/002-ephemeral-coordination.md)). Azure Blob's non-S3
dialect and GCS's read-only S3-interop conditional writes each need a
dedicated adapter that does not exist yet. Your bytes stay in your
bucket; protocol support belongs to adapters and backends that pass the
storage contract.

## Runtime model: nothing resident between requests

"Resident" means a required process that stays awake after a request
ends: a server, catalog, lock table, compactor, scheduler, or queue.
baerly-storage avoids that shape. Each request reads bucket state, tries
the conditional log create that commits the write, and leaves no
required process behind.

Concretely, conflict resolution, atomic commit, log emission, index
maintenance, garbage collection, and compaction are bounded to the
request path or the post-commit write tick. Cloudflare may finish the
maintenance tick after the response with `ctx.waitUntil`; Node runs it
inline unless a host wraps dispatch differently. The kernel holds no
in-memory state needed for correctness; a cold start reads correctly the
same as a warm one. The only persistent data component is the bucket.
**No cron, no sidecar, no `setInterval`, no scheduled handler is
required for correctness.**

Maintenance runs opportunistically on the write path — **reads are pure;
they never tick**. Compaction is triggered by the live-log/snapshot ratio
and bounded by the host profile; garbage collection runs on its own
cadence and host profile. Idle buckets pay zero runtime.
Keeping reads pure is what preserves the published idle-reader cost
bound. The pattern echoes PostgreSQL autovacuum / HOT pruning in the one
way that matters here: ordinary maintenance is bounded, automatic, and
not a user-scheduled chore. Users who _want_ batched maintenance windows
can invoke `runScheduledMaintenance` from their own scheduler — it is an
SDK function, never a deployment requirement. Scaffolds ship with zero
cron wiring.

The subtle part is coordination. Apache Iceberg requires a catalog
service. Delta Lake on S3 uses a DynamoDB lock table for multi-cluster S3
writes. SlateDB is designed around a long-lived writer and a long-lived
compactor. Cloudflare Durable Objects are stateful named coordinators
with colocated durable storage. baerly-storage's bet is that this
workload can coordinate through supported object-store conditional
writes (`If-Match` / `If-None-Match`) if the protocol does the work. The
full rationale, comparators, and rules for what would break the property
are in [ADR-002](../adr/002-ephemeral-coordination.md).

## Requirements → architecture

Each design choice falls out of a criterion above. The rough shape is
git-like: immutable content, append-only history, and a small compaction
bookmark. More precisely, baerly-storage stores content-addressed
documents, immutable numbered log entries, and one conditional log create
as the commit, per collection.

- **Idle → zero.** baerly-storage is a TypeScript library. The full
  Cloudflare Workers bundle (`cloudflare.js`) is budgeted at 122 KiB
  gzipped; the Node HTTP closure (`http.js`) at 101 KiB gzipped. Your
  Worker or Node process imports it directly. No binary, no separate
  process, no pool / cache / leader. The kernel is stateless; the request
  mostly waits on object storage. The request-handler work is a rounding
  error against the bucket.
- **Graduation with no hostage.** The `LogEntry` shape is a
  Debezium-style CDC envelope:
  `{lsn, commit_ts, op, collection, doc_id, after?, before?, key_old?, origin?, session, seq}`.
  Not aesthetic — operational. `0.3.0` is the public early-access
  baseline for that wire contract; pre-1.0 breaking changes are
  compatibility-managed in the canonical policy. Snapshot export to SQL
  is shipped; the log shape is intended to keep future incremental CDC
  export mechanical rather than a marketing line. See
  [log-entry-shape.md](../spec/log-entry-shape.md).
- **Strong consistency under contention.** Old log entries roll up into
  snapshots through bounded write-triggered maintenance. The hard part is
  deciding which writer won without a resident coordinator. Before
  December 2020, S3-as-a-database required a separate linearizable
  metadata service — ZooKeeper, etcd, a DynamoDB lock table,
  FoundationDB — to hold the authoritative pointer to "what exists."
  After AWS announced strong read-after-write consistency on every S3
  operation, baerly-storage's catalog-free protocol became viable when
  combined with exactly-one-winner conditional creates. See
  [sync-protocol.md](../spec/sync-protocol.md) and
  [storage-compatibility.md](../spec/storage-compatibility.md).
  Per-collection commit scope
  ([ADR-001](../adr/001-tenant-cas-isolation.md)) keeps the idle-poll
  bound tractable: one cheap log series and one compaction bookmark per
  collection, not contention on a global mutex.
- **LLM-legible API.** Document-DB-shaped — closer to Convex than to
  Mongo or Drizzle — with a closed vocabulary: unsupported spellings are
  absent types, not hidden options. `db.collection("name")` is the
  Mongo-style lookup idiom; by-id verbs on the collection handle
  (`.get(id)` / `.update(id, patch)` / `.replace(id, doc)` /
  `.delete(id)`) and the callback-DSL predicate builder are Convex's.
  No SQL builder, no `$`-operators, no standalone operator imports.
  Predicates have two shapes: object literal equality
  (`db.collection('tickets').where({ status: 'open' }).all()`) and a
  callback DSL
  (`db.collection('tickets').where(q => q.gte('priority', 5)).all()`).
  `PredicateBuilder<T>` methods ARE the vocabulary; `or` / `not` /
  `regex` / `ne` / `exists` cannot be invoked because they do not exist.
  Eight verbs (`first`, `all`, `count`, `get`, `insert`, `update`,
  `replace`, `delete`), three modifiers (`where`, `order`, `limit`), six
  predicate operators (`eq`, `gt`, `gte`, `lt`, `lte`, `in`). Operators
  are added one at a time, each gated by whether it admits a correct SQL
  translation. Day-one ships equality, dotted paths, ordered reads, and
  the `eq` / `gt` / `gte` / `lt` / `lte` / `in` predicate operators. The
  whole interface fits in an authoring agent's context; the additive-only
  lock is codified in
  [change-discipline.md](../contributing/conventions/change-discipline.md#api-surface-lock).

## What this deliberately is not

- **No SQL, no joins, no LSM.** Operators land one at a time, gated by a
  passing SQL-translator test. Equality + dotted-path nesting on day
  one. The limit is part of the contract.
- **Browser-direct multi-writer is out.** Trusted multi-instance is the
  design center; browser-direct is a different protocol problem and the
  audience does not need it.
- **Realtime is long-poll first.** The HTTP
  `/v1/since?collection=<name>&cursor=<opaque>` long-poll is the default
  change-notification channel; a WebSocket tier would be a future opt-in
  with a documented cost-cliff note. Polling is always correct.
- **No generated schema-migration ceremony.** Ordinary schema shape
  changes are config and validator edits, not DDL. Data migrations are
  explicit versioned scripts.
- **No multi-bucket replication / fan-out / mirroring.** R2's own
  replication tier handles read fan-out.
- **No on-disk caches.** Object storage + the platform's HTTP cache (CF
  Cache API on the CF target, none on Node by default) + small in-memory
  caches only.
- **Cost is decisive on some axes, a loss on others — we name both.**
  baerly-storage wins when the cost line is idle portfolios, per-app
  managed-DB floors, and exit control. At high write volume, D1 can be
  cheaper per write where it is available; that is the graduation signal,
  not a competitive position. See [cost-model.md](cost-model.md) for the
  operating-point tables and per-line-item rates.
- **Not a D1 / Postgres replacement.** D1 and Postgres are graduation
  targets. baerly-storage's job is to keep the experiment cheap and fast
  until the user knows whether it is worth graduating. Snapshot SQL
  export ships today; incremental CDC is future-facing protocol work.

## Workload ceiling

baerly-storage names its envelope so graduation is a feature rather than
a surprise.

| Axis | Envelope | What it means |
| --- | --- | --- |
| Write rate | **~30 logical writes / minute / collection** sustained | A model/estimate from the raw S3-CAS conditional-PUT contention regime divided by baerly's measured write-amplification (see [ADR-001](../adr/001-tenant-cas-isolation.md) and [cost-model.md](cost-model.md)); per-collection commit scope buys the operating headroom. |
| Stored bytes | **>10 GB / tenant stored** | The R2 free-tier storage line, a cost signal rather than a protocol ceiling. A tenant is a key prefix; baerly-storage enforces no per-tenant byte limit. Once stored bytes cross 10 GB-mo on R2, storage billing begins; see [cost-model.md](cost-model.md) for rates. |
| Collection fan-out | **~100 collections / tenant** | A bench-grounded soft guideline (erosion, not a cliff). The `admin usage` sweep grows linearly with collection count; ~100 is where sweep cost becomes noticeable. Nothing in the protocol enforces a per-tenant collection cap. |

The cost model can advise graduation earlier; for example, Class A ops
`> 50M/mo`, sustained over 7 days, is the published hard cost trigger.
That is separate from the workload envelope above. Before counting that
axis, run the qualitative shape test in [workload-fit.md](workload-fit.md):
a product whose core screen is the view across collections is the wrong
starting point at any size.

Crossing any of these lines is the success signal to graduate. For
example, `baerly export --target=postgres ...` dumps a collection's
snapshot to SQL; `--bucket`, `--app`, `--tenant`, and `--collection`
identify the source, and you run it per collection for a whole app. The
same log shape is intended to keep a future incremental exit
straightforward.

One bucket per app; tenants are prefix-scoped within. Server-only
writes; the browser is a typed HTTP client.

## Audience in practice

The workload shape produces a population, not a single persona.
baerly-storage is the storage primitive matched to all of them:

- A finance team whose dashboard has so far been a forty-line Claude
  Artifact with the data baked into the HTML.
- A PM at a 10,000-person company building an internal laptop-request
  tracker without an IT ticket for a managed database.
- An engineer's Saturday side project that may or may not become
  important.
- An individual builder who needs a shareable app before they know
  whether it deserves standing infrastructure.

All of them author through the same loop. None of them want to own a
long-running service to find out whether the app deserves one.
