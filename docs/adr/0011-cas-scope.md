---
title: CAS scope is per-collection
audience: adr
summary: ADR 0011 — CAS scope is per-collection.
last-reviewed: 2026-05-12
tags: [decision, adr]
related: [README.md]
---

# 0011 — CAS scope is per-collection

## Status

Accepted.

## Context

A multi-writer document database needs a linearization point: a single
key whose compare-and-swap success defines the order of committed
writes. Baerly's coordination object is `current.json`, and the
granularity question is how many such keys exist per tenant.

The two realistic options are:

- **Per-tenant CAS.** One `current.json` per tenant. Every write
  across every collection serializes through that one key. The key
  count stays small (one per tenant) and cross-collection atomicity
  becomes free, but every writer in the tenant contends on the same
  mutex.
- **Per-collection CAS.** One `current.json` per `(tenant,
  collection)` pair. Collections are independent of each other —
  writes to `users` never block writes to `audits` — at the cost of a
  larger key count (one per collection rather than one per tenant)
  and the loss of cross-collection atomicity at the protocol level.

The published cost-model bound (see
[ADR-0015](./0015-cost-ceiling.md)) is `< 1 Class A op / writer /
hour` for idle readers polling the manifest. That bound is only
tractable if the idle reader can poll one cheap key per collection
without serializing through a contended global mutex; per-tenant CAS
makes the bound unmeetable on any workload with more than one busy
collection.

## Decision

CAS scope is **per-collection**. Each table has its own `current.json`
keyed by `(tenant, collection)`, and every commit reads, mutates, and
CAS-writes that single object. There is no per-tenant or per-bucket
mutex. The convention is documented inline at
[`packages/protocol/src/coordination/current-json.ts:1-36`](../../packages/protocol/src/coordination/current-json.ts)
("One per `(tenant, collection)` key" — see lines 42–54) and enforced
by the writer at
[`packages/server/src/server-writer.ts:1-25`](../../packages/server/src/server-writer.ts),
which reads `current.json` fresh on every commit, CAS-advances with
`If-Match`, and loses cleanly with a 412 surfaced as
`BaerlyError{code:"Conflict"}`.

## Consequences

- Collections are independent. A write storm on one table does not
  block writers on another table in the same tenant.
- More `current.json` objects per tenant. The count is bounded — one
  per collection — and lifecycle is managed by the same
  compactor/GC pair that handles snapshot files
  (see [ADR-0017](./0017-snapshot-levels.md)).
- Hot single-collection workloads above roughly 30 writes per minute
  on the same table see CAS contention. The documented mitigation is
  the `r2-contention-bench` follow-up; until that bench runs,
  per-collection scope is the committed default and not negotiable.
- Cross-collection atomicity is impossible by construction.
  Applications that need to commit across two tables atomically use
  the raw log via `db._raw` or graduate to Postgres
  (see [ADR-0013](./0013-export-contract.md)).
  Transaction scope inherits the per-collection boundary — see
  [ADR-0012](./0012-transaction-scope.md).
- The tenant prefix the CAS key is built on derives from the auth
  layer's `Verifier` output
  (see [ADR-0014](./0014-auth-verifier-interface.md)); a
  misconfigured verifier handing back the wrong prefix is the
  tenancy-leak vector this scope choice does not paper over.
