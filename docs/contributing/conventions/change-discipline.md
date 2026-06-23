---
title: Conventions for changing code
audience: coder
summary: How to make non-trivial changes — no silent compat shims, one canonical form per operation, types over JSDoc.
last-reviewed: 2026-06-22
tags: [conventions, discipline]
related: [docs.md, tests.md, "../../about/thesis.md", "../../adr/002-api-surface-lock.md"]
---

# Change discipline

Rules for non-trivial code changes across `packages/`, `scripts/`,
`bench/`, `examples/`, and `manual-e2e/`.

## Backwards compatibility

When behavior changes, make the new contract the only contract in the
tree. A half-migration leaves the next contributor, and the next coding
agent, to guess which path is real.

In the same change:

- Update all in-repo callers and tests to the new contract.
- Remove obsolete code paths in the same change — no half-finished
  migrations sitting in the tree.
- Do not add compatibility aliases, dual writes, old/new schemas,
  temporary adapters, or legacy fallbacks **without asking the user**.
  A compat shim is a real commitment, not a free convenience — it
  needs explicit sign-off.

## One canonical form per operation

If a new public addition makes both `.get(id)` and
`.where({_id}).first()` type-check, both forms are available to
generated code. A shorter recommended form does not erase the longer
legal one.

That is why new public additions should preserve one type-valid path per
operation unless ADR-002 or this section records why both forms stay.
The operation is the capability; the spelling is the form. A second
type-valid form for the same capability is *redundant ceremony* — a
defect against criterion #4 of the
[product thesis](../../about/thesis.md), and out of scope of the
[additive-only lock](../../adr/002-api-surface-lock.md).

When adding a method, ask: does an existing path already express this
operation in a type-valid way?

- **No** — straightforward addition. ADR-002 §"Allowed additive
  changes" applies.
- **Yes** — pick one form. The non-canonical form should not
  type-check (narrow a `Predicate<T>` field, remove an overload,
  etc.). If the ceremony path must stay legal (e.g. because it
  composes with operators the canonical path doesn't), amend ADR-002
  with the justification.

Prefer type-level enforcement over JSDoc steering. LLMs follow what the
type system permits; prose warnings are weaker than a compile error. If
`.where({_id: x}).first()` compiles, some fraction of generated code
will use it regardless of what the `@remarks` block says.

## What we keep even when it looks like ceremony

The one-canonical-form rule above reduces API surface; it is not a ban
on every surface that looks extra. Some apparent ceremony carries a job
the type surface cannot carry by itself. A surface that fails the
one-canonical-form test _but_ satisfies one of these three tests stays:

1. **Kernel-bug tripwires.** Surfaces that let maintainers _and
   users_ catch protocol regressions before they hit the invoice
   (`baerly cost`'s % of free tier, write-amp counters, op-count
   histograms). The CI gate is the canonical enforcement; the
   user-visible surface is the second line of defence and the one users
   feel first when something drifts.

2. **Empirical LLM ergonomics.** Pre-wired surfaces validated
   against real zero-shot scaffold use stay even when they look
   like ceremony. Pre-installed `vitest` is the canonical case:
   LLMs reach for tests by default, and `pnpm install vitest` adds
   setup work and consumes context. If a surface measurably improves
   zero-shot app construction, it's load-bearing.

3. **Audience reach across deploy targets.** "Self-hosted Node"
   means _any_ Node target — including container-only,
   air-gapped, or no-PaaS environments. Surfaces that the
   happy-path PaaS audience doesn't need (Dockerfile, `healthz`,
   explicit Node start entry) stay if they unblock a real
   deploy population.

## Operator-burden test for new mechanisms

Many maintenance ideas start with a hidden actor: a cron job, a sidecar,
a lock table, a scheduler, a queue that survives the request. In
baerly-storage, that actor is the hard part. The default deployment is a
bucket plus an HTTP handler, so correctness cannot depend on a resident
actor between requests or on in-memory state surviving a request-bounded
continuation.

Before proposing a mechanism that involves scheduling, cleanup,
coordination, or cross-request state, run the three checks below. A
failing answer means the mechanism needs redesign before it becomes a
configuration option. The principle this enforces is thesis criterion #6
([Zero operator burden](../../about/thesis.md#what-prototype-tier-storage-needs)):
"create a bucket; run the kernel inside an HTTP handler" is the entire
operator action set.

1. **Does the default scaffold need to add anything beyond auth config?**
   (Cron entry, scheduled export, sidecar process, additional managed
   service, lock table.) If yes, the mechanism does not fit the default
   deployment model. Find the inline-on-request version.
   Anti-precedent: Delta Lake on S3 required a
   [DynamoDB lock table](https://docs.delta.io/latest/delta-storage.html)
   for safe multi-writer commits before S3 strong consistency — exactly
   the operator chore baerly-storage's design refuses. Apache Hudi makes the
   same chore explicit: its multi-writer mode requires an
   operator-installed [lock provider](https://hudi.apache.org/docs/concurrency_control/)
   (ZooKeeper / DynamoDB / Hive Metastore). The right shape coordinates
   through the storage itself — Apache Iceberg and Delta Lake commit
   compaction as an *optimistic* transaction against the table-metadata
   pointer (the `current.json` analog): the loser retries, no lock. That
   is exactly baerly-storage's full-fence CAS on `current.json`.

2. **Does the mechanism require a long-lived process?** (`setInterval`,
   in-memory queue, background thread, persistent connection pool.) If
   yes, it relies on execution that many runtimes are allowed to freeze:
   Vercel Functions / AWS Lambda / Google Cloud Run / Fly Machines on
   suspend / any freeze-after-response runtime. Use the request-bounded
   version. The kernel's "no in-memory state load-bearing for
   correctness" promise (thesis §"Runtime model") is exactly this
   constraint expressed positively.

3. **Does the mechanism degrade gracefully on free-tier CF Workers
   (10 ms CPU/request — see [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/))?**
   Treat that as the budget for incidental maintenance on the request
   path. If the mechanism can require more CPU than that per invocation,
   it must be bounded by an explicit per-pass budget and *resumable* —
   checkpointed in bucket-state so many request-bounded passes
   eventually converge. Positive
   precedent: PostgreSQL HOT pruning
   ([`heap_page_prune_opt`](https://github.com/postgres/postgres/blob/master/src/backend/access/heap/pruneheap.c))
   — opportunistic in-band cleanup gated by cheap heuristics, bounded
   per-page work, ~1.6% of execution time in dead-tuple-heavy workloads
   per the [PostgreSQL HOT README](https://github.com/postgres/postgres/blob/master/src/backend/access/heap/README.HOT).
   Cautionary precedent: Cassandra's `read_repair_chance` (removed in 4.0,
   [CASSANDRA-13910](https://issues.apache.org/jira/browse/CASSANDRA-13910))
   — unbounded probabilistic on-request work was deemed "more harmful
   than helpful" and removed. The lesson: opportunistic is fine,
   *unbounded* opportunistic is not. A second positive precedent for the
   bounded-and-resumable shape: SQLite's
   [`PRAGMA incremental_vacuum`](https://www.sqlite.org/pragma.html#pragma_incremental_vacuum)
   reclaims a *static, caller-set page budget* per call rather than
   self-metering a closed loop — the correct budget family for a
   killable isolate that cannot observe its own runtime.

> **On the DX bar.** Databricks [Predictive Optimization](https://docs.databricks.com/aws/en/optimizations/predictive-optimization)
> ships zero-operator automatic `OPTIMIZE`/`VACUUM`, which proves the
> "maintenance just happens" expectation is reasonable — but it *hides* a
> privileged scheduler baerly-storage cannot assume on untrusted, killable
> ephemeral compute. Matching that DX *without* that scheduler is the
> constraint these three checks enforce.

When proposing any maintenance, coordination, or background-work
mechanism, cite this section in the PR description and answer the three
questions explicitly. The pitch is two-audience (see
[thesis §"Two audiences, two pitches"](../../about/thesis.md#two-audiences-two-pitches)):
LLM legibility for code authors (criterion #4), zero operator burden for
platform teams (criterion #6). When the two audiences conflict on a
design choice, the authoring audience wins — it is the primary one.
Zero operator burden is not a separate competing goal; it enables the
authoring goal by keeping deployment friction out of the builder path. A
mechanism that adds an operator chore breaks the deployment path builders
depend on, so it harms the authoring audience too. That is what these
three checks protect.
