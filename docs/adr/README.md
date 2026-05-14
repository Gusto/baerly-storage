---
title: Architecture Decision Records
audience: meta
summary: Index of ADRs. Each ADR captures one load-bearing technical decision whose rationale doesn't fit naturally in any single code or doc file.
last-reviewed: 2026-05-14
tags: [index, decisions]
related: ["../engineering-principles.md"]
---

# Architecture Decision Records

ADRs are reserved for cross-cutting decisions whose rationale spans
multiple files and doesn't fit naturally in any one place. Most
load-bearing rationale lives next to the code it constrains (JSDoc,
`docs/spec/`, `docs/conventions/`) — readers encounter it where
they're already looking. Numbering has gaps from earlier ADRs that
were merged into their natural homes.

These are decisions, not principles. Cross-cutting philosophy lives
in [engineering-principles.md](../engineering-principles.md).

## Index

- [0018 — Tenant CAS isolation](./0018-tenant-cas-isolation.md)
- [0019 — API surface lock](./0019-api-surface-lock.md)

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
