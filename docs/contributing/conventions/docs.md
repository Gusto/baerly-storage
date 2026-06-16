---
title: Conventions for docs/
audience: coder
summary: Source-of-truth rules, markdown style, Mermaid usage, when to update which doc.
last-reviewed: 2026-06-13
tags: [conventions, docs]
related: [tests.md, "../../README.md"]
---

# docs/ conventions

Conventions for content under `docs/`.

## Source of truth

- Everything in `docs/` is hand-written.
- Public API type/hover docs live as JSDoc on
  `packages/server/src/db.ts` and `packages/server/src/collection.ts`.
  IDE hover and `tsgo` consume those directly.
- The curated installed quick reference lives at
  `packages/server/API.md` and is copied to
  `node_modules/@gusto/baerly-storage/dist/API.md` at build time.
  Keep it aligned with JSDoc and the exported `.d.ts` surface; it is
  the first file headless agents are expected to read.

## Style

- Markdown line wrap ~80 chars (matches existing `spec/sync-protocol.md` and
  `spec/causal-consistency-checking.md`).
- Mermaid blocks render on GitHub — use them for diagrams.
- Inline code paths are `packages/<pkg>/src/<file>.ts` (relative to
  repo root).

## When to update which doc

| Change                                   | File to update                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| New module / refactor                    | `docs/contributing/architecture.md` (graph + lifecycle)                                           |
| New developer setup step                 | `docs/contributing/development.md`                                                                |
| New extension pattern                    | `docs/contributing/extending.md`                                                                  |
| Protocol change                          | `docs/spec/sync-protocol.md` (and a coverage entry in `docs/spec/causal-consistency-checking.md`) |
| New `Db.create` / `Collection<T>` option | JSDoc on the param in `packages/server/src/db.ts` or `packages/server/src/collection.ts`          |

## Pinned phrases

Two positioning lines are load-bearing brand copy and must stay
recognizable and consistent wherever they appear. If you reword one,
update every occurrence so they don't silently drift:

- **"There is no runtime. None."** — `README.md`,
  `docs/contributing/architecture.md`, `docs/about/thesis.md`.
- **"Built like git: content-addressed documents, immutable numbered
  log entries, and one conditional log create as the commit, per
  collection."** — `README.md`, `docs/contributing/architecture.md`,
  `docs/about/thesis.md`.

Consistency is of the _wording_, not byte-identical formatting: the
copies are not identical today (e.g. some are bold and standalone,
others are embedded in a longer sentence or soft-wrapped). Keep the
phrasing aligned; don't claim they're byte-identical.

## Don't

- ❌ Duplicate content between `CLAUDE.md` and `docs/*.md`. CLAUDE.md
  links out; long-form lives in `docs/`.
- ❌ Add screenshots without compressing — keep `docs/contributing/diagrams/` lean.
