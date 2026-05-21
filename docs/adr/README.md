---
title: Architecture Decision Records
audience: meta
summary: Index of ADRs. Each ADR captures one load-bearing technical decision whose rationale doesn't fit naturally in any single code or doc file.
last-reviewed: 2026-05-14
tags: [index, decisions]
related: ["../about/thesis.md", "../contributing/conventions/change-discipline.md"]
---

# Architecture Decision Records

ADRs are reserved for cross-cutting decisions whose rationale spans
multiple files and doesn't fit naturally in any one place. Most
load-bearing rationale lives next to the code it constrains (JSDoc,
`docs/spec/`, `docs/contributing/conventions/`) — readers encounter it where
they're already looking. Numbering has gaps from earlier ADRs that
were merged into their natural homes.

These are decisions, not principles. Cross-cutting philosophy lives
in [about/thesis.md](../about/thesis.md); change-discipline
rules live in
[contributing/conventions/change-discipline.md](../contributing/conventions/change-discipline.md).

## Index

- [001 — Tenant CAS isolation](./001-tenant-cas-isolation.md)
- [002 — API surface lock](./002-api-surface-lock.md)
- [003 — Brand-prefix naming convention](./003-naming-convention.md)

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
