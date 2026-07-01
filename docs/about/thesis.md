---
title: Product thesis
audience: product
summary: Why baerly-storage exists, who it fits, and which boundaries it deliberately keeps.
last-reviewed: 2026-06-29
tags: [positioning, product]
related: [how-it-works.md, workload-fit.md, cost-model.md, graduation.md, "../contributing/conventions/change-discipline.md"]
---

# baerly-storage — product thesis

baerly-storage is for live application data that has outgrown a browser
tab but has not yet earned a database service. It is a TypeScript
library that runs in your Worker or Node request handler and stores
database state as objects in your bucket.

The product shape follows from that boundary: there is no separate
database server, the authoring API stays small, and leaving the system
is mechanical. baerly-storage runs wherever the bucket credentials
safely live.

The threshold concept is single-write commit: a write commits when the
handler creates the next numbered log object with create-if-absent. The
bucket arbitrates that race; no resident coordinator decides the winner.
The mechanism is explained in [how-it-works.md](how-it-works.md), the
storage contract in
[storage-compatibility.md](../spec/storage-compatibility.md), and the
formal protocol in [sync-protocol.md](../spec/sync-protocol.md).

The public surface is intentionally small enough for an LLM to learn
from the `.d.ts` files. Day-1 templates ship for Cloudflare Workers and
self-hosted Node; other runtimes are adapter work over the same protocol
kernel.

This page explains _why_ the system has that shape. The narrative
long-form is the blog post _Storage is the Missing Primitive for
Agent-Built Software_; the technical detail lives across `docs/`.

## The workload shape has changed

It is now cheap to try a software idea. That creates many small apps
with uncertain lifespans and mixed criticality: dashboards, internal
trackers, personal apps, workflow sidecars. Some run for a week. Some
run every Tuesday for five years. Some become important. Most are
production apps — real data, real users — that simply live inside a
defined workload envelope.

You need three primitives to build software in 2026: compute, tokens,
and storage. Compute has an answer: FaaS, pay per request, scale to
zero. Tokens have an answer: POST your prompt, get a response.
**Storage is the missing primitive.**

The gap shows up as ordinary failures: `localStorage` does not survive a
share link; LLM-generated Postgres + RLS can return empty arrays when a
policy is wrong, which looks like "no data" instead of broken
authorization; a real database invites service ceremony the operator
never sees. baerly-storage is built for production apps that live
within a defined workload envelope — internal tools, admin panels,
dashboards, and low-to-moderate-traffic line-of-business apps. The
ceiling is scale and shape, not seriousness.

Better models do not remove that need. Stronger agents do better when
the surface is small, tools are boring, and invalid states are
unrepresentable.

## What apps within the envelope need

Apps within the envelope run real data and real users. What they share
is that they have not yet crossed — or do not need to cross — the
cost-and-commitment threshold of standing infrastructure: a managed
database service, a migration workflow, a DBA on-call. Sandboxes and
review bots reduce blast radius after a tool has chosen a storage
shape; baerly-storage supplies the safer default before that investment
is warranted.

The criteria:

1. **Idle rounds to zero.** No $5/mo floors multiplied across forty
   abandoned internal tools. An app should not accumulate rent for
   merely existing.
2. **Low operational overhead.** No CVE rotation, no kernel patches, no
   on-call for an app with fifteen users.
3. **Graduation path with no hostage situation.** Storage within a
   scale envelope without an exit is deferred migration pain. _Graduation is
   the success path, not a failure mode._ When an app crosses the
   envelope and moves to Cloudflare D1 or Postgres, that is a
   baerly-storage **win**, not a churn event. Snapshot export ships
   today; the log shape is designed so future incremental CDC exit stays
   mechanical rather than aspirational. The wire contract lives in
   [log-entry-shape.md](../spec/log-entry-shape.md).
4. **A small, typed, closed-vocabulary API.** A surface that does not
   fit in working memory is a surface that gets called wrong, whether
   the caller is an LLM mid-completion or a human under deadline. _Type
   signatures are the contract; JSDoc is prose._ The `.d.ts` shapes,
   `dist/API.md`, and the scaffold `AGENTS.md` quickref must all teach
   one small surface; a caller should reach the correct call zero-shot
   from those files without inventing ceremony. The
   [API surface lock](../contributing/conventions/change-discipline.md#api-surface-lock)
   keeps that discipline explicit.
5. **No DDL.** The moment the loop requires `CREATE TABLE`, "invent and
   preserve a schema across edits" enters the part of the loop where
   small naming drift is costly (`category` vs. `categories` four turns
   later).
6. **Zero operator burden.** No cron required for correctness, no sidecar
   to run, no scheduler to provision, no lock service, no managed
   catalog. The full operator action set for serving application data is
   "create a bucket; run the kernel inside an HTTP handler." If a feature
   needs `wrangler.jsonc` edits beyond auth, a `node-cron` install, or
   any "step 2: also configure..." for the database to stay correct — it
   is the wrong shape for this audience. Operational jobs such as backups
   remain optional runbook choices.

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
| Non-engineer builders | #1, #5, no DDL, idle-to-zero | _Ship a shareable app before you know whether it deserves standing infrastructure_ | The scaffold quickstart and cost model |

A design choice that improves one audience without harming the other is
a win. A choice that improves authoring DX by adding operator chores, or
vice versa, is a regression. When in doubt, the authoring audience wins.
Zero operator burden keeps deployment friction from blocking builders.

**The operational surface stays off the authoring surface.** App
authors define collections and call a document API. Operators set auth,
storage credentials, and rare maintenance env vars in the deploy
environment. A knob the app-authoring agent can see is a knob it will
eventually tune, so ordinary storage maintenance stays automatic and
bounded. Public API ownership lives in
[docs conventions](../contributing/conventions/docs.md); the surface
lock lives in
[change-discipline.md](../contributing/conventions/change-discipline.md#api-surface-lock).

## No new vendor

Almost every team already has S3 / R2 / GCS / Azure Blob for exports,
backups, documents, archives, or analytics drops. That is not
database-protocol support, but the security review for "give me a
bucket" happened years ago. Hosted database alternatives (D1, Neon,
Convex, Supabase, Firebase) are excellent, but each triggers a fresh
vendor procurement review, secrets-manager integration, and an IT ticket
to add a new managed-DB SKU to the catalog. The bucket already exists.

That friction is low in a two-person team. In an organisation past
roughly one hundred people, a new vendor relationship requires a legal
review, a security questionnaire, and often an IT change request. The
cost is weeks, not days — for an app with fifteen users. baerly-storage
skips that entirely: the storage vendor review is already closed.

**Vendor-independent where the contract holds.** Object storage is the
rare primitive with a common dialect — the S3 API. Your bytes stay in
your bucket; protocol support belongs to adapters and backends that pass
the storage contract. The precise contract, supported backends, and live
probe rules live in
[storage-compatibility.md](../spec/storage-compatibility.md).

## Runtime model: nothing resident between requests

"Resident" means a required process that stays awake after a request
ends: a server, catalog, lock table, compactor, scheduler, or queue.
baerly-storage avoids that shape. Each request reads bucket state, tries
the conditional log create that commits the write, and leaves no
required process behind.

Servers that don't exist can't go down — nothing resident means a
smaller availability and supply-chain surface. There is no database
process to patch, no connection pool to exhaust, and no managed service
dependency in your critical path.

The kernel holds no in-memory state needed for correctness; a cold start
reads correctly the same as a warm one. The only persistent data
component is the bucket. **No cron, no sidecar, no `setInterval`, no
scheduled handler is required for correctness.**

Maintenance is bounded and write-driven: ordinary reads are pure, idle
buckets pay zero runtime, and opt-in scheduled maintenance is a
convenience rather than a deployment requirement. The mechanism lives in
[how-it-works.md](how-it-works.md#what-about-the-ever-growing-log), the
operator limits in [graduation.md](graduation.md), and the rationale in
[ADR-002](../adr/002-ephemeral-coordination.md).

## Why object storage

The commit path needs exactly one coordination primitive from the store:
under concurrent create-if-absent writes to the next numbered log
object, one writer must win and the rest must get a conflict. Object
storage supplies that primitive and nothing more. (The procurement
angle — why the bucket is usually pre-cleared — is covered in
[§ No new vendor](#no-new-vendor) above.) The precise storage contract,
supported backends, and live probe rules live in
[storage-compatibility.md](../spec/storage-compatibility.md).

## Requirements → architecture

Each design choice falls out of a criterion above. The rough shape is
git-like: immutable content, append-only history, and a small compaction
bookmark. More precisely, baerly-storage stores content-addressed
documents, immutable numbered log entries, and one conditional log create
as the commit, per collection.

That architecture is not the thesis by itself. The thesis is that this
narrow architecture buys the product boundary: idle-to-zero, no resident
coordinator, a small authoring surface, and a mechanical exit path. The
bucket layout and read/write algorithms are explained in
[how-it-works.md](how-it-works.md); module ownership lives in
[architecture.md](../architecture.md); the binding protocol lives in
[sync-protocol.md](../spec/sync-protocol.md).

## What this deliberately is not

- **No SQL, no joins, no LSM.** The small query surface is part of the
  contract. API vocabulary belongs in
  [`packages/server/API.md`](../../packages/server/API.md) and the
  [cheat sheet](../guide/cheatsheet.md).
- **Browser-direct multi-writer is out.** Trusted multi-instance is the
  design center; browser-direct is a different protocol problem and the
  audience does not need it.
- **Realtime is long-poll first.** Polling is always correct; a
  WebSocket tier would be a future opt-in with a documented cost cliff.
- **No generated schema-migration ceremony.** Ordinary schema shape
  changes are config and validator edits, not DDL. Data migrations are
  explicit versioned scripts.
- **No multi-bucket replication / fan-out / mirroring.** baerly-storage
  is one bucket per app, with tenants prefix-scoped inside that app.
  Provider replication tiers or external projections can own fan-out.
- **No on-disk caches.** The durable state is the bucket. Runtime caches
  may help latency, but correctness cannot depend on local disk.
- **Cost is decisive on some axes, a loss on others.** baerly-storage
  wins when the cost line is idle portfolios, per-app managed-DB floors,
  and exit control. At high write volume, D1 can be cheaper per write
  where it is available; that is the graduation signal, not a
  competitive position. See [cost-model.md](cost-model.md).
- **Not a D1 / Postgres replacement.** D1 and Postgres are graduation
  targets. baerly-storage keeps production apps cheap and exit-ready
  until they cross the scale envelope where graduating makes sense.

## Workload ceiling

baerly-storage names its envelope so graduation is a feature rather than
a surprise. Shape comes first: if the product's most important screen is
a view across collections, tenants, users, or organizations, start with
a database or a derived projection rather than counting rows. The
qualitative test lives in [workload-fit.md](workload-fit.md).

Once the shape fits, the numeric envelope belongs to the docs that own
the decision:

- [workload-fit.md#scale-at-a-glance](workload-fit.md#scale-at-a-glance)
  is the builder-facing summary.
- [graduation.md](graduation.md) is the operator-facing decision table
  for CPU, memory, write rate, collection fan-out, and workload
  graduation.
- [cost-model.md](cost-model.md) owns the Class A meter, write-amp, and
  cost-side graduation signals.

Crossing the envelope is the success signal to graduate. Snapshot export
ships today; the log shape is intended to keep future incremental exit
straightforward. The export and exit details live in
[graduation.md](graduation.md) and
[log-entry-shape.md](../spec/log-entry-shape.md).

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

Postgres and D1 are graduation targets, not villains. baerly-storage's
job is to keep production apps cheap and exit-controlled until they
cross the scale envelope where a database service is the right tool.

## Audience in practice

The workload shape produces a population, not a single persona:

- A finance team whose dashboard has so far been a forty-line Claude
  Artifact with the data baked into the HTML.
- A PM at a 10,000-person company building an internal laptop-request
  tracker without an IT ticket for a managed database.
- An engineer's Saturday side project that may or may not become
  important.
- An individual builder who needs a shareable app before they know
  whether it deserves standing infrastructure.

All of them author through the same loop; none of them want to own a
long-running service to find out whether the app deserves one.
