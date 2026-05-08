# Architecture Decision Records

Each ADR captures one load-bearing technical decision: the context, the
choice, and the consequences. ADRs are *immutable once decided* — if a
decision is later reversed, write a new ADR that supersedes the old one
rather than editing it in place.

These are decisions, not principles. Cross-cutting philosophy lives in
[engineering-principles.md](../engineering-principles.md).

## Index

- [0001 — No AWS SDK](./0001-no-aws-sdk.md)
- [0002 — Branded types over plain strings](./0002-branded-types.md)
- [0003 — Error code discriminant over `instanceof`](./0003-error-code-discriminant.md)
- [0004 — oxlint / oxfmt / tsgo over the JS-native trio](./0004-oxlint-oxfmt-tsgo.md)
- [0005 — Client-only architecture (no server)](./0005-client-only.md)

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
