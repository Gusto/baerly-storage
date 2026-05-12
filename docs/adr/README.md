---
title: Architecture Decision Records
audience: meta
summary: Index of ADRs. Each ADR captures one load-bearing technical decision.
last-reviewed: 2026-05-12
tags: [index, decisions]
related: ["../engineering-principles.md"]
---

# Architecture Decision Records

Each ADR captures one load-bearing technical decision: the context,
the choice, and the consequences. Decisions are revised in place
when they become noise (e.g. tool choices that have no live
follow-up cost) or when they are superseded; the numbering may have
gaps as a result.

These are decisions, not principles. Cross-cutting philosophy lives
in [engineering-principles.md](../engineering-principles.md).

## Index

- [0001 — No AWS SDK](./0001-no-aws-sdk.md)
- [0002 — Branded types over plain strings](./0002-branded-types.md)
- [0003 — Error code discriminant over `instanceof`](./0003-error-code-discriminant.md)
- [0006 — Server component (`@baerly/server`)](./0006-server-component.md)
- [0011 — CAS scope is per-collection](./0011-cas-scope.md)
- [0012 — Transaction scope is single-table](./0012-transaction-scope.md)
- [0013 — Export contract is Postgres-logical-replication-shaped](./0013-export-contract.md)
- [0014 — Auth as a `Verifier` interface](./0014-auth-verifier-interface.md)
- [0015 — Cost ceiling is a published bound](./0015-cost-ceiling.md)
- [0016 — Forward-only schema migration via `schema_version`](./0016-schema-migration.md)
- [0017 — Chunked level-based snapshot layout](./0017-snapshot-levels.md)
- [0018 — Tenant CAS isolation](./0018-tenant-cas-isolation.md)
- [0019 — API surface lock](./0019-api-surface-lock.md)
- [0020 — GC lag window](./0020-gc-lag-window.md)
- [0021 — Sync bounds across adapters](./0021-sync-bounds-across-adapters.md)
- [0022 — Observability tag naming](./0022-observability-tag-naming.md)

## Template

```markdown
# NNNN — Title

## Context

What was true when the decision was made. The problem; the constraints;
the alternatives considered.

## Decision

The choice. One paragraph.

## Consequences

What this commits us to — both the wins and the costs. What changes
later if we reverse course.
```
