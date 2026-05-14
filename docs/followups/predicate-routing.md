---
title: Predicate-routing — open follow-ups
audience: coder
summary: Deferred items from the predicate-routing chapter (T1–T5).
last-reviewed: 2026-05-13
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

## 1. Value-order-preserving numeric encoder

Range walks over numeric fields fall back to full-scan today because
`encodeIndexValue` is byte-order-preserving on `JSON.stringify(v)`:
`9` JSON-stringifies to `"9"` (0x39), `10` to `"10"` (0x31 0x30), so
`9` lex-sorts above `10`. The T3 numeric-range guard catches this and
emits `FullScanPlan{reason:"numeric-range-on-byte-encoder"}` — correct
results, no optimisation. A value-order-preserving numeric encoder is
its own ticket with its own conformance suite.

- Decided in: T3 §6.a.iv (numeric-range guard).
- Pointer: `packages/server/src/indexes.ts` (`encodeIndexValue`);
  `packages/server/src/query-planner.ts` (planner emit site).

## 2. Range / `$in` implication in `predicateImplies`

`predicateImplies(indexFilter, queryPredicate)` returns `false`
conservatively whenever `indexFilter` contains an operator-shaped
value (CONTRACTS §12). T4 shipped equality-only implication so the
checker stayed simple and decoupled from T1's matcher work. A query
predicate `{age:{$gte:18}}` does not today imply an index filter
`{age:{$gte:21}}` even though logically it does.

- Decided in: T4 (equality-only ships in this chapter).
- Pointer: `packages/protocol/src/query/predicate.ts`
  (`predicateImplies`).

## 3. Configurable `IN_FANOUT_THRESHOLD`

The `$in` multi-walk fan-out threshold is hard-coded to 50 inside
`packages/server/src/query-planner.ts`. A `Db.create({ indexes,
inFanoutThreshold? })` knob lands later if real workloads benefit.

- Decided in: T3.
- Pointer: `packages/server/src/query-planner.ts`
  (`IN_FANOUT_THRESHOLD` constant).

## 4. Bounded parallelism for `$in` multi-walk LISTs

Today `runIndexWalkPlan` issues one LIST per `$in` value
sequentially. The Cloudflare 50-subrequest budget caps this
naturally, but a bounded `Promise.all`-style fan-out (a `p-limit`
analogue) would cut wall-clock latency on multi-value `$in` walks.

- Decided in: T3.
- Pointer: `packages/server/src/query.ts` (`runIndexWalkPlan`).

## 5. Auto-rebuild-on-config-change for filtered-index filter mutations

When an operator tightens a filtered index's `def.predicate`, they
must run `pnpm exec baerly admin rebuild-index <collection> <name>`
manually. Follow-up: a `baerly doctor --check=index-filter-drift`
surface that flags pre-existing index keys whose docs no longer match
the current filter, plus an opt-in auto-rebuild path.

- Decided in: T4.
- Pointer: `packages/cli/src/admin/rebuild-index.ts`;
  `packages/server/src/rebuild-index.ts`.

## 6. Operator-shaped `def.predicate` clauses on filtered indexes

`IndexDefinition.predicate` is equality-only at validation today
(`packages/server/src/indexes.ts:103-117` rejects operator-shaped
values via the post-`validatePredicate` operator scan). Allowing
`{ priority: { $in: ["p0", "p1"] } }` or `{ age: { $gte: 18 } }` in
the filter requires extending `predicateImplies` to reason about
range/`$in` implication (follow-up #2 above), so the two are
naturally coupled.

- Decided in: T4 (decoupling from T1's matcher work).
- Pointer: `packages/server/src/indexes.ts`
  (`validateIndexDefinition`, `assertNoOperatorClause`).
