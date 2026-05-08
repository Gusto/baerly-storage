---
description: Conventions for content under docs/
appliesTo: docs/**
---

# docs/ rules

## Source of truth
- Everything in `docs/` is hand-written.
- The public-API reference lives as JSDoc on `src/mps3.ts` (the
  `MPS3` class and the `MPS3Config` interface). IDE hover and `tsgo`
  consume it directly — there is no rendered markdown ref.

## Style
- Markdown line wrap ~80 chars (matches existing `sync_protocol.md` and
  `causal_consistency_checking.md`).
- Mermaid blocks render on GitHub — use them for diagrams.
- Inline code paths are `src/foo.ts` (relative to repo root).

## When to update which doc

| Change | File to update |
|---|---|
| New module / refactor | `docs/ARCHITECTURE.md` (graph + lifecycle) |
| New developer setup step | `docs/DEVELOPMENT.md` |
| New extension pattern | `docs/EXTENDING.md` |
| Protocol change | `docs/sync_protocol.md` (and a coverage entry in `docs/causal_consistency_checking.md`) |
| New `MPS3` config field | JSDoc on the field in `src/mps3.ts` |

## Don't

- ❌ Duplicate content between `CLAUDE.md` and `docs/*.md`. CLAUDE.md
  links out; long-form lives in `docs/`.
- ❌ Add screenshots without compressing — keep `docs/diagrams/` lean.
