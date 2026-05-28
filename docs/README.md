---
title: docs/ — topic map
audience: meta
summary: Index of everything under docs/, grouped by audience.
last-reviewed: 2026-05-28
tags: [index, navigation]
related: ["../CLAUDE.md", "spec/README.md", "adr/README.md"]
---

# `docs/` — topic map

Baerly is a vendorless document database for the new middle —
software that's real enough to need state but not real enough to
deserve a Postgres + Docker + on-call stack. It runs over any
S3-compatible bucket; your data lives in your bucket, and the
protocol kernel is small enough that an LLM can use the public API
zero-shot from the `.d.ts` files alone. The positioning story is in
[`about/thesis.md`](about/thesis.md).

## Using Baerly

For integrators and operators running Baerly against a real bucket.
**The canonical surface is `dist/API.md` in the published package**
(`node_modules/@gusto/baerly-storage/dist/API.md`) — it carries
the public API, Verifier presets, observability field reference,
client-fetch wrapping recipes, and the trusted-fields recipe. The
files below cover what doesn't fit there: cross-cutting
invariants, operator runbooks, and target-specific bolt-ons.

- `guide/add-to-existing-cf-worker.md` — One-command bolt-on for an existing `wrangler create` project — `pnpm create @gusto/baerly-storage@latest .` detects wrangler.jsonc, patches it, prints the worker-entry snippet.
- `guide/auth.md` — The `config.auth` graduated postures and the no-built-in-authorization caveat. Preset reference and Verifier-shape rationale live elsewhere.
- `guide/backups.md` — Daily NDJSON dump with retention rotation; restoring from any dump file.
- `guide/client-auth.md` — Cross-cutting four-quadrant analysis of the SPA → API auth seam (dev/prod × Cloudflare/Node) — synthesis first, hardened per-quadrant recipes live in scaffold AGENTS.md files.
- `guide/observability.md` — Sinks (OTel / Workers Analytics Engine / Datadog), cost-ballooning anti-patterns, and known gaps. Canonical log-line shape lives in dist/API.md.
- Runnable scaffolds: `../examples/` (`minimal-cloudflare`,
  `minimal-node`, `react-cloudflare`, `react-node`).

## About Baerly

Product and business context.

- `about/thesis.md` — what Baerly is, who it's for, what it
  deliberately isn't.
- `about/cost-model.md` — per-line-item rates, write-amp meter,
  compression posture.
- `about/pricing-log.md` — append-only audit of cost commitments.

## Contributing

For people changing the code in this repo.

- `contributing/architecture.md` — module graph and the lifecycle
  of `db.collection(...).insert()`.
- `contributing/development.md` — local setup, test commands,
  Minio / Toxiproxy / Postgres stack.
- `contributing/troubleshooting.md` — known pain points: test gating,
  ports, fuzzer, CI formatting.
- `contributing/extending.md` — worked examples for adding a `Db`
  method, `Query` constraint, etc.
- `contributing/features.md` — feature → code map.
- `contributing/day-one-gate.md` — pre-release manual gate.
- `contributing/conventions/` — path-scoped conventions auto-loaded
  by Claude via `.claude/rules/`:
  - `contributing/conventions/tests.md`
  - `contributing/conventions/docs.md`
  - `contributing/conventions/observability.md`
  - `contributing/conventions/change-discipline.md`
- `contributing/diagrams/` — rendered SVGs and editable Excalidraw
  sources.

## Protocol & decisions

For theory and spec readers.

- `spec/` — protocol theory and stable contracts (sync protocol,
  causal consistency, JSON merge patch, log-entry shape, S3
  features used).
- `adr/` — Architecture Decision Records.

---

AI agents start at `../CLAUDE.md` in the repo root.
