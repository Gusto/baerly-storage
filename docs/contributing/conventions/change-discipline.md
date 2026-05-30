---
title: Conventions for changing code
audience: coder
summary: How to make non-trivial changes — no silent compat shims, one canonical form per operation, types over JSDoc.
last-reviewed: 2026-05-30
tags: [conventions, discipline]
related: [docs.md, tests.md, "../../about/thesis.md", "../../adr/002-api-surface-lock.md"]
---

# Change discipline

Rules for non-trivial code changes across `packages/`, `scripts/`,
`bench/`, `examples/`, and `manual-e2e/`.

## Backwards compatibility

When changing behavior:

- Update all in-repo callers and tests to the new contract.
- Remove obsolete code paths in the same change — no half-finished
  migrations sitting in the tree.
- Do not add compatibility aliases, dual writes, old/new schemas,
  temporary adapters, or legacy fallbacks **without asking the user**.
  A compat shim is a real commitment, not a free convenience — it
  needs explicit sign-off.

## One canonical form per operation

The kernel ships one type-valid path per operation. Two paths to the
same call (e.g. `.get(id)` and `.where({_id}).first()`) is *redundant
ceremony* — a defect against criterion #4 of the
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

The bias is toward type-level enforcement over JSDoc steering. LLMs
reason from type shapes; JSDoc anti-pattern callouts do not override
training-distribution priors. If `.where({_id: x}).first()` compiles,
some fraction of generated code will use it regardless of what the
`@remarks` block says.

## Operator-burden test for new mechanisms

Before proposing a mechanism that involves scheduling, cleanup,
coordination, or cross-request state, run the three checks below. Any
failing answer is a design-error signal, not a configuration option to
expose — re-shape until all three are clean. The principle this enforces
is thesis criterion #6 ([Zero operator burden](../../about/thesis.md#what-prototype-tier-storage-needs)):
"create a bucket; run the kernel inside an HTTP handler" is the entire
operator action set.

1. **Does the default scaffold need to add anything beyond auth config?**
   (Cron entry, scheduled export, sidecar process, additional managed
   service, lock table.) If yes — the mechanism is wrong-shape for the
   audience. Find the inline-on-request version. Anti-precedent: Delta
   Lake on S3 required a [DynamoDB lock table](https://docs.delta.io/latest/delta-storage.html)
   for safe multi-writer commits before S3 strong consistency — exactly
   the operator chore baerly's design refuses. Apache Hudi makes the
   same chore explicit: its multi-writer mode requires an
   operator-installed [lock provider](https://hudi.apache.org/docs/concurrency_control/)
   (ZooKeeper / DynamoDB / Hive Metastore). The right shape coordinates
   through the storage itself — Apache Iceberg and Delta Lake commit
   compaction as an *optimistic* transaction against the table-metadata
   pointer (the `current.json` analog): the loser retries, no lock. That
   is exactly baerly's full-fence CAS on `current.json`.

2. **Does the mechanism require a long-lived process?** (`setInterval`,
   in-memory queue, background thread, persistent connection pool.) If
   yes — it breaks silently on Vercel Functions / AWS Lambda / Google
   Cloud Run / Fly Machines on suspend / any freeze-after-response
   runtime. Use the request-bounded version. The kernel's "no in-memory
   state load-bearing for correctness" promise (thesis §"Runtime model")
   is exactly this constraint expressed positively.

3. **Does the mechanism degrade gracefully on free-tier CF Workers
   (10 ms CPU/request — see [Cloudflare Workers limits](https://developers.cloudflare.com/workers/platform/limits/))?**
   If it requires more CPU than that per invocation, it must be bounded
   by an explicit per-pass budget and *resumable* — checkpointed in
   bucket-state so "many small ticks" eventually converges. Positive
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
> privileged scheduler baerly cannot assume on untrusted, killable
> ephemeral compute. Matching that DX *without* that scheduler is the
> constraint these three checks enforce.

When proposing a maintenance, coordination, or background-work mechanism,
cite this section in the PR description and answer the three questions
explicitly. The pitch is two-audience (see
[thesis §"Two audiences, two pitches"](../../about/thesis.md#two-audiences-two-pitches)):
LLM legibility for code authors (criterion #4), zero operator burden for
platform teams (criterion #6). When the two audiences conflict on a
design choice, the operator-burden audience wins — they have one shot
to say yes or no to deploying this; the authoring audience has many
tools and can adapt.
