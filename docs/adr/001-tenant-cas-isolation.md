---
title: Tenant CAS isolation
audience: adr
doc_type: adr
summary: ADR 001 — tenant isolation is by key prefix, and commit/control scope is per collection. The live per-collection contract lives in sync-protocol.md; this record keeps the decision and the rejected per-tenant-CAS and lease paths.
last-reviewed: 2026-06-28
tags: [decision, adr]
related: [README.md, "../spec/sync-protocol.md", "../guide/auth.md", 002-ephemeral-coordination.md, 004-single-write-commit.md]
---

# 001 — Tenant CAS isolation

## Status

Accepted (2026-05-11). The per-collection isolation decision stands;
under [ADR-004](004-single-write-commit.md) commits are linearized by the
numbered `log/<seq>` create, not by a CAS on `current.json`, and the
embedded writer fence is dormant.

## Decision

Two coordinated choices compose into one isolation story:

1. **Isolation by prefix.** `Db.create({ app, tenant })` mints a
   physical-key prefix `app/<app>/tenant/<tenant>/` and refuses to
   enumerate outside it. Cross-tenant key access is a programming error
   inside the runtime, **not** a permission check on a shared bucket.
2. **Per-collection commit/control scope.** Each `(tenant, collection)`
   has its own numbered log series plus a `current.json` control object.
   Reads and writes against one collection are linearizable at the
   winning `log/<seq>` create; **across** collections there is no ordering
   and no atomicity — an app needing cross-collection ordering must encode
   it in a single collection.

**The live per-collection isolation contract lives in
[sync-protocol.md §Commit scope is per collection](../spec/sync-protocol.md#commit-scope-is-per-collection).**
The tenant prefix derives from the auth layer's `Verifier` output (see
[guide/auth.md](../guide/auth.md)); a misconfigured verifier returning the
wrong prefix is the tenancy-leak vector this scope choice does not paper
over.

## Closed paths

- **Per-tenant single CAS** — one `current.json` per tenant, every
  collection serializing through it. A 100-collection tenant at the
  documented write target lands ~10× over the S3-CAS same-key contention
  ceiling. Commit contention must stay inside its own collection.
- **A server-vended lease** with peer revocation. It would require a
  coordination service or sticky routing; the portable
  `(Request) => Response` server contract rules both out (see
  [ADR-002](002-ephemeral-coordination.md)). The `WriterFence` embedded in
  `current.json` is a cooperative epoch retained as dormant admin
  metadata — never a lease.
