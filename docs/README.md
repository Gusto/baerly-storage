---
title: docs/ — topic map
audience: meta
summary: Index of everything under docs/, grouped by audience.
last-reviewed: 2026-05-15
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

- `guide/auth.md` — Verifier presets (shared secret, JWT, CF Access,
  AWS SigV4, IP allowlist) and the tenant-isolation caveat.
- `guide/add-to-existing-cf-worker.md` — bolt baerly onto an existing
  Cloudflare Worker project with `pnpm create baerly .`.
- `guide/embed.md` — 30-line snippet to drop baerly-storage into an
  existing Node app, bypassing `create-baerly`.
- `guide/client-middleware.md` — wrap `BaerlyClientOptions.fetch` to
  add logging, retry, auth-refresh, and `onSuccess` / `onError`
  hooks without new API surface.
- `guide/observability.md` — canonical log line, sinks (OTel,
  Datadog, Workers Analytics), cost-aware sampling.
- `guide/troubleshooting.md` — known pain points: test gating,
  ports, fuzzer, CI formatting.
- `guide/backups.md` — `baerly admin copy` bucket-to-bucket procedure.
- Runnable scaffolds: `../examples/` (`minimal-cloudflare`,
  `minimal-node`, `react-cloudflare`, `react-node`). The Docker
  add-on lives at `../packages/create-baerly/templates/addons/docker/`
  and layers onto `minimal-node` via `--with=docker` at scaffold time.

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
  of `db.table(...).insert()`.
- `contributing/development.md` — local setup, test commands,
  Minio / Toxiproxy / Postgres stack.
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
