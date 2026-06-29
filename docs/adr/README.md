---
title: Architecture Decision Records
audience: meta
doc_type: index
summary: Index of ADRs. Each ADR captures one load-bearing protocol or architecture decision whose rationale and rejected alternatives don't fit naturally in any single code or doc file.
last-reviewed: 2026-06-28
tags: [index, decisions]
related: ["../about/thesis.md", "../contributing/conventions/change-discipline.md"]
---

# Architecture Decision Records

ADRs are reserved for cross-cutting **protocol and architecture**
decisions whose rationale and rejected alternatives span multiple files
and don't fit naturally in any one place. Everything else — current
contracts, API-surface rules, conventions — lives next to the code or doc
it governs (`docs/spec/`, `docs/contributing/`, JSDoc), so readers
encounter it where they are already looking.

These are decisions, not principles. Cross-cutting philosophy lives in
[about/thesis.md](../about/thesis.md); change-discipline rules live in
[contributing/conventions/change-discipline.md](../contributing/conventions/change-discipline.md).

## Index

Each entry is a **baseline guardrail**: a decision plus the closed paths
worth not re-litigating. The live contract lives in the doc readers
already reach for (annotated below); the ADR keeps the rationale and the
rejected designs.

- [001 — Tenant CAS isolation](./001-tenant-cas-isolation.md)
  — _per-collection contract in [spec/sync-protocol.md](../spec/sync-protocol.md#commit-scope-is-per-collection)._
- [002 — Ephemeral coordination](./002-ephemeral-coordination.md)
  — _runtime model in [spec/sync-protocol.md](../spec/sync-protocol.md#maintenance-runtime-model)._
- [003 — Layout versioning cordon](./003-layout-versioning-cordon.md)
  — _tolerant-reader rule in [contributing/extending.md](../contributing/extending.md#forward-only-migration)._
- [004 — Single-write commit](./004-single-write-commit.md)
  — _live protocol in [spec/sync-protocol.md](../spec/sync-protocol.md)._

## Decisions that live elsewhere

The 0.3.0 reset folded the decisions whose entire payload was a rule plus
a one-line rejected alternative into the doc that owns the rule — no stub
left behind. If you remember one of these as an ADR, it now lives at:

- **API surface lock** (additive-only, one canonical form, deprecation
  lifecycle) → [conventions/change-discipline.md](../contributing/conventions/change-discipline.md#api-surface-lock).
- **`Baerly` prefix naming** → [contributing/extending.md](../contributing/extending.md#6-naming-a-public-symbol).
- **Verifier is a function** → [guide/auth.md](../guide/auth.md) and the
  [API reference](../../packages/server/API.md).
- **Package layer invariant** → [architecture.md](../architecture.md#package-layers).
- **Schema-validator shape** → [contributing/extending.md](../contributing/extending.md#1b-declare-a-schema-for-a-collection).

## Policy — ADRs after 0.3.0

`0.3.0` is the **public documentation baseline**; the ADRs were
renumbered contiguously at that reset. The specs, the published API
reference ([`packages/server/API.md`](../../packages/server/API.md)), and
the contributing docs describe the system as it ships; the ADRs are the
durable record of why it took that shape. Treat the set as **settled** —
read them for rationale and closed paths, not as a running history to
extend.

**When a post-0.3.0 change warrants a new ADR.** Only when the change is
load-bearing along one of these axes:

- **Protocol or storage layout** — anything that moves the
  [sync protocol](../spec/sync-protocol.md) or triggers a layout-version
  bump (the ADR-003 layout axis).
- **Operator burden** — measured against the
  [operator-burden test](../contributing/conventions/change-discipline.md#operator-burden-test-for-new-mechanisms).
- **Migration or graduation guarantees** — what we promise across
  versions ([graduation](../about/graduation.md)).
- **Public API surface** — held to the
  [API surface lock](../contributing/conventions/change-discipline.md#api-surface-lock)
  bar.
- **Reopening a closed path** — amend or supersede the ADR that closed it;
  don't relitigate it in prose elsewhere.

Routine features, refactors, and bug fixes get **no ADR** — they land in
the code and the docs that own them.

**What a post-0.3.0 ADR contains.** Status + date, a one-paragraph
decision statement, the closed paths it establishes, durable consequences,
and a link to the live owner doc. It must **not** restate a current
contract — specs (`docs/spec/`), the API reference, and contributing docs
own those, and the ADR links to them. Algorithms, implementation detail,
and chronology live in the code, the spec, and the changelog, never copied
into the ADR.

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
