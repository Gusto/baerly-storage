# `docs/` — topic map

Everything that doesn't live in `CLAUDE.md` (the agent entry point)
or as JSDoc on the public API. Grouped by audience.

## Start here

You are about to make a change.

- [architecture.md](architecture.md) — module dependency graph and
  the lifecycle of `db.table(...).insert()`.
- [development.md](development.md) — local setup, test commands,
  Minio / Toxiproxy / Postgres stack.
- [extending.md](extending.md) — worked examples of adding a method
  to `Db`, a verb to `Table`, or a new `Query` constraint.

## Code map

- [features.md](features.md) — feature → code map: which test, which
  source file, which doc covers each feature.
- [conventions/](conventions/) — path-scoped conventions
  (`tests.md`, `docs.md`) — auto-loaded by Claude via
  `.claude/rules/`.

## Decisions

- [adr/](adr/) — Architecture Decision Records. Each ADR captures
  one load-bearing choice and the reasoning behind it.

## Protocol & contracts

- [spec/](spec/) — protocol theory and stable contracts. Pure
  "what" — no implementation detail. Sync protocol, causal
  consistency, JSON merge patch, log-entry shape, S3 features used.

## Operations

- [troubleshooting.md](troubleshooting.md) — known pain points and
  fixes.
- [operating/backups.md](operating/backups.md) — `baerly copy`
  cost-aware bucket-to-bucket procedure.
- [pricing-log.md](pricing-log.md) — append-only audit of cost
  commitments.

## Product context

- [product-thesis.md](product-thesis.md) — what Baerly is, who it's
  for, what it's deliberately not.
- [engineering-principles.md](engineering-principles.md) — the bias
  set: ship the smallest slice, prefer changing the contract over
  carrying compat, etc.
- [cost-model.md](cost-model.md) — per-line-item rates, write-amp
  meter, compression posture.

## Diagrams

- [diagrams/](diagrams/) — rendered SVGs at the top level, editable
  sources under `sources/`.
