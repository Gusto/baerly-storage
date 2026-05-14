---
title: Predicate-routing — open follow-ups
audience: coder
summary: Deferred items from the predicate-routing chapter (T1–T5).
last-reviewed: 2026-05-14
tags: [followups, indexes, query-planner]
related: ["../features.md", "../architecture.md", "../extending.md"]
---

# Predicate-routing — open follow-ups

The predicate-routing chapter (`worktree-predicate-routing`, T1–T5)
shipped the auto-planner, composite reads, range/`$in` operators,
and filtered indexes. The items below were explicitly deferred from
the chapter; each carries a short rationale and a pointer to the
ticket where the deferral was decided. This file is the permanent
backlog the next iteration's planning consults — the ticket scratch
under `.claude/research/planning/tickets/predicate-routing/` is
deleted at chapter close.

## 1. Auto-rebuild-on-config-change for filtered-index filter mutations

When an operator tightens a filtered index's `def.predicate`, they
must run `pnpm exec baerly admin rebuild-index <collection> <name>`
manually. Follow-up: a `baerly doctor --check=index-filter-drift`
surface that flags pre-existing index keys whose docs no longer match
the current filter, plus an opt-in auto-rebuild path.

- Decided in: T4.
- Pointer: `packages/cli/src/admin/rebuild-index.ts`;
  `packages/server/src/rebuild-index.ts`.
