---
title: Conventions for docs/
audience: coder
summary: Source-of-truth rules, markdown style, Mermaid usage, when to update which doc.
last-reviewed: 2026-08-04
tags: [conventions, docs]
related: [tests.md, "../../README.md"]
---

# docs/ conventions

Conventions for content under `docs/`.

## Source of truth

- Prose in `docs/` is hand-written. `docs/spec/attachments/**` is the
  carve-out for regenerated benchmark evidence and is intentionally
  treated as unformatted data.
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

## Ownership

Route by doc type so each fact stays single-sourced:

- **About docs** (`docs/about/`) own thesis, graduation, and project
  positioning.
- **Specs** (`docs/spec/`) own current protocol contracts.
- **Guides** (`docs/guide/`) own user-facing workflows and examples.
- **ADRs** (`docs/adr/`) own durable rationale and rejected paths.
- **Contributing docs** (`docs/contributing/`) own how-to-change guidance.

Specs and ADRs carry a `doc_type:` frontmatter field recording their role
(`current-contract`, `semantic-reference`, `verification`,
`adapter-edge-case`, `historical`, `rationale`, `adr`). The `spec/` and
`adr/` index READMEs carry `doc_type: index` and group their entries by
that role.

## When to update which doc

| Change                                   | File to update                                                                                    |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| New module / refactor                    | `docs/architecture.md` (graph + lifecycle)                                                        |
| New developer setup step                 | `docs/contributing/development.md`                                                                |
| New extension pattern                    | `docs/contributing/extending.md`                                                                  |
| Protocol change                          | `docs/spec/sync-protocol.md` (and a coverage entry in `docs/spec/causal-consistency-checking.md`) |
| New `Db.create` / `Collection<T>` option | JSDoc on the param in `packages/server/src/db.ts` or `packages/server/src/collection.ts`          |

## Pinned phrases

These positioning lines are load-bearing brand copy and must stay
recognizable and consistent wherever they appear. If you reword one,
update every occurrence so they don't silently drift:

- **"A document database that lives in a bucket you already own — no
  new vendor to clear, no server to keep running, and an API small
  enough for an LLM (or a non-engineer) to use zero-shot."** — the
  README tagline. Explanatory docs may use variants such as **"There
  is no separate database server."** or **"There is no database server
  coordinating state."** where the passage is teaching the runtime
  model.
- **"baerly-storage runs wherever the bucket credentials safely
  live."** — the shortest way to distinguish the TypeScript library
  from a hosted database service.
- **"Built like git: content-addressed snapshots, immutable numbered
  log entries, and one conditional log create as the commit, per
  collection."** — exact lead in `README.md`; architecture and thesis
  may use the same content without the `Built like git:` lead when the
  sentence is embedded in explanatory prose.

Two positioning constraints apply to **product positioning and
graduation copy** — the prose that says what baerly-storage is for,
how far it scales, and when to leave it. They do not reach ordinary
explanatory or reference prose, and they say nothing about how a doc
characterizes the reader's _own_ software.

- **Production-grade within an envelope.** Describe the ceiling in
  terms of workload scale and shape, never maturity. Do not call
  baerly-storage "between toy and production," "prototype-tier," "not
  a real database," or a stepping stone to a "serious" database.
  Internal tools are production systems; the small surface is
  deliberate.
- **Do not invent scale numbers.** `docs/about/workload-fit.md`,
  `docs/about/graduation.md`, and `docs/about/cost-model.md` are the
  canonical owners of throughput, size, and cost figures. Front-door
  copy links to those sources instead of restating their figures.

Consistency is of the _wording_, not byte-identical formatting: the
copies are not identical today (e.g. some are bold and standalone,
others are embedded in a longer sentence or soft-wrapped). Keep the
phrasing aligned; don't claim they're byte-identical.

## Link and anchor checking

`pnpm verify:docs` **does** fail on a broken cross-file anchor
(`other.md#some-heading`) — don't plan a doc restructure on the
assumption anchors are unchecked. Two tools run in that script and only
one checks anchors: `scripts/verify-docs.mjs` validates only that the
target *file* exists (anchor-blind); `remark --frail` runs
`remark-validate-links`, which resolves the fragment against the target
file's actual headings and turns a `missing-heading-in-file` warning
into a hard failure. What's genuinely unchecked is **figure drift** — a
quoted number going stale against the doc that owns it.

## Don't

- ❌ Duplicate content between `CLAUDE.md` and `docs/*.md`. CLAUDE.md
  links out; long-form lives in `docs/`.
