---
title: Predicate-routing — open follow-ups
audience: coder
summary: Deferred items from the predicate-routing chapter (T1–T5).
last-reviewed: 2026-05-14
tags: [followups, indexes, query-planner]
related: ["../features.md", "../architecture.md", "../extending.md"]
---

# Predicate-routing — open follow-ups

All predicate-routing follow-ups closed as of 2026-05-14.

The chapter shipped the auto-planner, composite reads, range / `$in`
operators, filtered indexes, the value-order-preserving numeric
encoder, operator-shaped filtered-index predicates with range / `$in`
implication, the `Db.create({ inFanoutThreshold })` knob, the bounded
`$in` parallelism, and the `baerly doctor --check=index-filter-drift`
surface (`packages/cli/src/doctor/index-filter-drift.ts`).
