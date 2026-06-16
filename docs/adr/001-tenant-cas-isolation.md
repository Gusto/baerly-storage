---
title: Tenant CAS isolation
audience: adr
summary: ADR 001 — Tenant CAS isolation.
last-reviewed: 2026-06-14
tags: [decision, adr]
related: [README.md]
---

# 001 — Tenant CAS isolation

## Status

Accepted (2026-05-11). Amended by
[ADR-008](008-single-write-commit.md): the per-collection isolation
decision stands, but commits are now linearized by the numbered
`log/<seq>` create, not by a commit-path CAS on `current.json`.

## Context

Original context, superseded by ADR-008: Baerly's coordination object
was `current.json`; every commit read it, mutated it locally, and
CAS-wrote it back with `If-Match: <etag>`. The current protocol uses a
single-write commit: the winning `If-None-Match: "*"` create on
`log/<seq>.json` is the commit, and `current.json` is compaction state
read by writers but CAS-written only by bootstrap, compaction, and
explicit operator/import paths.
A multi-tenant deployment shares one bucket across many tenants, so two
questions present themselves and must be answered together: how does
tenant T avoid seeing tenant U's keys, and at what granularity does the
CAS object live inside the tenant?

For scope, three options were considered:

- **Per-tenant CAS.** One `current.json` per tenant; every commit across
  every collection serializes through that one key. Simple topology,
  but the published prior-art ceiling on the S3-CAS pattern is roughly
  five writes per second; a 100-collection tenant at the documented
  30-writes-per-minute-per-collection target lands about 10× over the
  ceiling.
- **Per-collection commit scope.** One `current.json` plus one
  numbered log per `(tenant, collection)` pair. More objects per
  tenant, but commit contention stays inside its own collection. Matches
  the granularity of the SQL-shape collection API (`db.collection(name)` in
  [`packages/server/src/db.ts`](../../packages/server/src/db.ts)).
- **Per-tenant with opt-in per-collection.** A flag on the deployment
  config selects between (a) and (b). Two configurations to test and
  document; debuggability suffers because the production scope is no
  longer a single fact.

The fence question is orthogonal but related. Rolling deploys can hand
a Worker invocation off mid-flight to a new container generation, and
CAS alone catches the conflict on the next attempt but does not stop
the stale writer from observing a corrupted view of "its" writes
succeeding in the interim. Mature S3-as-DB systems handle this with
an epoch (FoundationDB `recoveryCount`, IsleDB `writer_fence`,
TigerBeetle view number, Litestream generation). A true server-vended
lease with peer revocation would require a coordination service or
sticky routing; the portable `(Request) => Response` server contract
rules both out.

## Decision

Three coordinated decisions, recorded together because they compose
into a single isolation story:

1. **Isolation by prefix.** `Db.create({ app, tenant })` mints a
   physical-key prefix `app/<app>/tenant/<tenant>/` and refuses to
   enumerate outside it. Cross-tenant key access is therefore a
   programming error inside the runtime, not a permission check on a
   shared bucket. See
   [`packages/server/src/db.ts:65-70`](../../packages/server/src/db.ts).
2. **Per-collection commit/control scope.** Each collection has its own
   numbered log series plus a `current.json` control object at
   `app/<app>/tenant/<tenant>/manifests/<collection>/current.json`. See
   [`packages/protocol/src/coordination/current-json.ts:43-45`](../../packages/protocol/src/coordination/current-json.ts)
   and
   [`packages/server/src/db.ts:247`](../../packages/server/src/db.ts).
   This pins the physical-key layout the commit scope rides on; the
   cost-coupling rationale lives in
   [`docs/spec/sync-protocol.md`](../spec/sync-protocol.md#commit-scope-is-per-collection).
3. **Cooperative fence, not lease.** The `WriterFence` embedded in
   `current.json` carries `epoch: number` (monotonic, the only
   safety-critical field), `owner: string` (informational, may be
   empty), `claimed_at: string` (ISO-8601 stamped from
   `StoragePutResult.serverDate` — the server clock, not local), and
   an optional `lease_until?: string` reserved for future manual
   rotation. See
   [`packages/protocol/src/coordination/current-json.ts:117-155`](../../packages/protocol/src/coordination/current-json.ts).
   The epoch is bumped only by an explicit `claimWriter` call, not on
   every commit; the two-round-trip protocol writes `claimed_at: ""`
   first and overwrites with the real server date in a second CAS
   ([`packages/protocol/src/coordination/current-json.ts:275-355`](../../packages/protocol/src/coordination/current-json.ts)).

Per-collection commit scope clears the documented per-collection
workload target with an order of magnitude of headroom over the
S3-as-database contention envelope; per-tenant would put a
100-collection tenant 10× over the ceiling. Tenant isolation cannot
share a commit/control scope with another tenant for the same reason it
cannot share a key prefix — both are physical co-location hazards. The
cooperative fence recorded here is dormant under ADR-008 but retained
as explicit/admin metadata without introducing a leases-as-state
dependency.

## Consequences

- **Consistency guarantee that the per-collection scope yields.**
  Because each `(tenant, collection)` has its own numbered log, reads
  and writes against one collection are **linearizable** at the winning
  `log/<seq>` create (per ADR-008). **Across** collections there is no
  ordering guarantee and no atomicity: a write spanning two collections
  is two independent log appends, observable in either order.
  Applications needing cross-collection ordering must encode it in a
  single collection.
- More `current.json` objects per tenant, bounded by collection count.
  Lifecycle on collection drop becomes a sweeper concern; the dwell
  window is `GC_GRACE_PERIOD_MILLIS` in
  [`packages/protocol/src/constants.ts`](../../packages/protocol/src/constants.ts)
  and implemented in
  [`packages/server/src/gc.ts`](../../packages/server/src/gc.ts).
- Composes cleanly with the single-collection API scope (see
  [ADR-002](./002-api-surface-lock.md)): every write appends to
  exactly one collection log, so no two-phase commit is required.
- The `owner` field is debug-only. Operators MAY page on it (e.g.
  writer churn) but readers MUST NOT branch on it for safety. Safety
  derives from `epoch`, not from `owner`.
- The `lease_until` slot is reserved for a future explicit rotation
  workflow (an admin marks a writer revoked at a horizon). It is unused
  today; a future ADR may activate it. Adding it now as an optional
  field is forward-compatible per the `CurrentJson` schema-version
  policy in
  [`packages/protocol/src/coordination/current-json.ts`](../../packages/protocol/src/coordination/current-json.ts)
  (`schema_version` field / `CURRENT_JSON_SCHEMA_VERSION` constant —
  adding an optional field is non-breaking; renaming or removing
  requires a major-version bump).
- `claimed_at` carries the server's clock, not the local clock. Under
  multi-instance deployment the local clock may disagree with peers;
  the server's clock is the only one all instances share. See
  [`packages/protocol/src/coordination/current-json.ts:136-146`](../../packages/protocol/src/coordination/current-json.ts).
- A peer landing between the first and second round of `claimWriter`
  loses cleanly with `Conflict`. The fence is durable from the first
  PUT either way
  ([`packages/protocol/src/coordination/current-json.ts:283-290`](../../packages/protocol/src/coordination/current-json.ts)).
- The tenant prefix the commit/control scope rides on derives from the auth
  layer's `Verifier` output (see [`docs/guide/auth.md`](../guide/auth.md)); a
  misconfigured verifier returning the wrong prefix is the
  tenancy-leak vector this scope choice does not paper over.
- Cross-tenant fan-out is unaffected by per-collection scope. If a
  future workload measurement (the deferred R2 contention bench) shows
  per-tenant is acceptable for some narrower workload class, a
  supersession ADR documents the change.
