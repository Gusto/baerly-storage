---
title: docs/ — topic map
audience: meta
summary: Index of everything under docs/, grouped by audience.
last-reviewed: 2026-06-23
tags: [index, navigation]
related: ["../CLAUDE.md", "spec/README.md", "adr/README.md"]
---

# `docs/` — topic map

baerly-storage is a vendorless document database for live application
data — software that's real enough to need shared state but not real
enough to deserve a Postgres + Docker + on-call stack. There is no
database server behind the app: baerly-storage runs in your trusted
request handler, wherever the bucket credentials safely live. Your
AWS S3 or Cloudflare R2 bucket is the durable state; other
S3-compatible endpoints require the support checks in
[`spec/storage-compatibility.md`](spec/storage-compatibility.md). The
protocol kernel is small enough that an LLM can use the public API
zero-shot from the `.d.ts` shapes, with `dist/API.md` as the canonical
companion reference. The positioning story is in
[`about/thesis.md`](about/thesis.md).

## Start here

- New to the project: [`../README.md`](../README.md), then
  [`about/how-it-works.md`](about/how-it-works.md).
- Evaluating the bet: [`about/thesis.md`](about/thesis.md), then
  [`about/workload-fit.md`](about/workload-fit.md), then
  [`about/cost-model.md`](about/cost-model.md), then
  [`about/graduation.md`](about/graduation.md).
- Building an app: [`guide/cheatsheet.md`](guide/cheatsheet.md), then
  [`packages/server/API.md`](../packages/server/API.md) — then scaffold
  from [`../examples/`](../examples/) or bolt onto an existing Worker
  with [`guide/add-to-existing-cf-worker.md`](guide/add-to-existing-cf-worker.md).
- Operating a production app: [`guide/operations.md`](guide/operations.md).

## Using baerly-storage

For integrators and operators running baerly-storage against a real bucket.
**The canonical surface is [`packages/server/API.md`](../packages/server/API.md),
published as `node_modules/@gusto/baerly-storage/dist/API.md`** — installed
consumers read the `dist/` copy, repo contributors read the source; they are
the same file, copied into `dist/` at build. It
carries the public API, Verifier presets, observability field
reference, client-fetch wrapping recipes, and the trusted-fields
recipe. The files below cover what doesn't fit there: cross-cutting
invariants, operator runbooks, and target-specific bolt-ons.

- [`guide/operations.md`](guide/operations.md) — Production runbook:
  preflight, auth, backups, observability, capacity, and route checks.
- [`guide/cheatsheet.md`](guide/cheatsheet.md) — One-screen quick
  reference: verbs, modifiers, errors, and the HTTP wire. The thing to
  show someone in 30 seconds; the full surface stays in API.md.
- [`guide/add-to-existing-cf-worker.md`](guide/add-to-existing-cf-worker.md)
  — One-command bolt-on for an existing `wrangler create` project —
  `pnpm create @gusto/baerly-storage@latest .` detects wrangler.jsonc,
  patches it, refreshes agent rules, prints the worker-entry snippet.
- [`guide/auth.md`](guide/auth.md) — Production auth recipes for
  Cloudflare and Node, tenant pinning, and the no-built-in-authorization
  caveat.
- [`guide/backups.md`](guide/backups.md) — Safe NDJSON dump with
  retention rotation, checksums, restore, and restore drills.
- [`guide/client-auth.md`](guide/client-auth.md) — Browser-to-server
  auth recipes and the dev/prod × Cloudflare/Node matrix. Scaffolds
  ship minimal recipes; fail-closed hardening lives in this guide.
- [`guide/observability.md`](guide/observability.md) — Operator
  signals, first-response actions, sinks (OTel / Workers Analytics
  Engine / Datadog), cost-ballooning anti-patterns, and known gaps.
  Canonical log-line shape lives in API.md.
- Runnable scaffolds: `../examples/` (`minimal-cloudflare`,
  `minimal-node`, `react-cloudflare`, `react-node`).

## About baerly-storage

Product and business context.

- [`about/how-it-works.md`](about/how-it-works.md) — the mechanism
  on-ramp: the plain-language mental model — a bucket of files plus a
  library that creates one numbered log entry atomically, and the typed
  layers from protocol to React. Read this to understand (or explain)
  _how_ the system works.
- [`about/thesis.md`](about/thesis.md) — the positioning on-ramp: what
  baerly-storage is, who it's for, and what it deliberately isn't — the _why_.
- [`about/workload-fit.md`](about/workload-fit.md) — the shape-fit
  test: whether the app's core screens can be answered from one
  collection before you count rows or costs.
- [`about/cost-model.md`](about/cost-model.md) — per-line-item rates,
  write-amp meter, compression posture.
- [`about/graduation.md`](about/graduation.md) — the CPU/memory bounds
  that tell you when a collection has outgrown its deployment tier, and
  what to do about it.
- [`about/pricing-log.md`](about/pricing-log.md) — append-only audit of cost commitments.

## Contributing

For people changing the code in this repo.

- [`contributing/architecture.md`](contributing/architecture.md) — module graph and the lifecycle
  of `db.collection(...).insert()`.
- [`contributing/development.md`](contributing/development.md) — local setup, test commands,
  MinIO / Toxiproxy / Postgres stack.
- [`contributing/troubleshooting.md`](contributing/troubleshooting.md) — known pain points: test gating,
  ports, fuzzer, CI formatting.
- [`contributing/extending.md`](contributing/extending.md) — worked examples for adding a `Db`
  method, `Query` constraint, etc.
- [`contributing/features.md`](contributing/features.md) — feature → code map.
- [`contributing/mutation-testing.md`](contributing/mutation-testing.md) — manual
  StrykerJS mutation testing scoped to the protocol kernel: `pnpm test:mutate`.
- [`contributing/publishing.md`](contributing/publishing.md) — how to publish
  `@gusto/baerly-storage` + `@gusto/create-baerly-storage` publicly to npmjs.com.
- [`contributing/day-one-gate.md`](contributing/day-one-gate.md) — pre-release manual gate.
- [`contributing/conventions/`](contributing/conventions/) — path-scoped conventions auto-loaded
  by Claude via `.claude/rules/`:
  - [`contributing/conventions/tests.md`](contributing/conventions/tests.md)
  - [`contributing/conventions/docs.md`](contributing/conventions/docs.md)
  - [`contributing/conventions/observability.md`](contributing/conventions/observability.md)
  - [`contributing/conventions/change-discipline.md`](contributing/conventions/change-discipline.md)
- [`contributing/diagrams/`](contributing/diagrams/) — rendered diagram artifacts and editable
  Excalidraw sources.

## Protocol & decisions

For theory and spec readers.

- [`spec/`](spec/) — protocol theory and stable contracts (sync protocol,
  causal consistency, JSON merge patch, log-entry shape, S3
  features used).
- [`adr/008-single-write-commit.md`](adr/008-single-write-commit.md) —
  live commit model: the numbered `log/<seq>` create is the commit;
  `current.json` is compaction state.
- [`adr/`](adr/) — Architecture Decision Records.

---

AI agents start at `../CLAUDE.md` in the repo root.
