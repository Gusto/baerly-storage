---
title: Rewrite "Wiring schemas into Db.create" in extending.md
target: "docs/contributing/extending.md:§Wiring schemas into Db.create"
concern: doc-surface-tracking-ghost-features
consumers_source: 0
consumers_docs: 1
sample_consumers:
  - docs/contributing/extending.md:Wiring schemas into Db.create subsection
est_loc:
  core: 0
  doc_drift: 17
  test_churn: 0
  total: 17
risk: low
risk_score: 1
score: 17
exception_eligible: none
exception_reasoning: n/a
status: proposed
discovered: 2026-05-27
related:
  - cut-db-create-overrides (already-shipped cut whose doc tail this is)
---

## Why this is a candidate

ADR-002 amended 2026-05-27 cut `schemas?`, `indexes?`, and
`metrics?` from `Db.create`'s public config (see memory
`[[cut-db-create-overrides-shipped]]`). The final shape is
`Db.create({ storage, app, tenant, config? })` — four fields.
`docs/contributing/extending.md` §"Wiring schemas into
`Db.create`" still teaches the pre-cut signature, walking the
reader through constructing a `ReadonlyMap<string,
SchemaValidator>` and passing it directly as the now-removed
`schemas:` parameter. Per the cutting lens
"doc-surface-tracking-ghost-features" — a worked example wired
to a deleted public surface.

The drift is load-bearing because `extending.md` is the
"When editing X, read Y" pointer for new write primitives and
new public APIs (see CLAUDE.md's table), and it is also the
canonical "how to add a schema" walkthrough cited from the
schema worked-examples themselves. An agent reaching for the
file gets a `BaerlyError("InvalidConfig")` at runtime — or, worse,
a silent type widening if they cast.

## Evidence

- `docs/contributing/extending.md` §"Wiring schemas into
  `Db.create`" (the H3 subsection of §1b) — the section opener
  reads "`Db.create` accepts a flat `schemas: ReadonlyMap<string,
  SchemaValidator>` keyed by collection name" and the worked
  example ends with `const db = Db.create({ storage, app, tenant,
  schemas });`. Both claims are false post-2026-05-27.
- `packages/server/src/db.ts:Db.create` — current signature is
  `Db.create({ storage, app, tenant, config? })`; schema wiring
  flows through `config.collections[*].schema`. No `schemas:`
  parameter accepted; no `ReadonlyMap` lookup path. (Plus the
  ADR-002 amendment trail at the head of the ADR documents this.)
- Other `Db.create` references in the same file are CURRENT and
  not in scope:
  - `extending.md:Db.create call at the "test the feature" example` — passes only `{ storage, app, tenant }` (current shape).
  - `extending.md:Db.create call at the "tests live in" example` — same.
- ADR-002 §"Amended (2026-05-27)" is the canonical statement of
  what changed; the doc cut should align with that.

## Exception assessment

- Kernel-bug tripwire? No — pure doc drift.
- Empirical LLM ergonomic? No — the section actively teaches an
  API that does not exist, so it is *anti*-ergonomic.
- Audience reach across deploy targets? No — irrelevant to
  deploy population.

## Cut surface

- **Core:** none — no code change.
- **Doc drift:**
  - `docs/contributing/extending.md` §"Wiring schemas into
    `Db.create`" — rewrite the section to describe the
    config-derived path: declare the schema on
    `BaerlyConfig.collections[<name>].schema`; the CLI and HTTP
    adapters thread `config` into `Db.create` and the kernel
    derives the per-collection schema map internally via
    `collectionsToMaps` (which the public barrel already
    re-exports). The worked example becomes the
    `defineConfig({ collections: { tickets: { schema: Ticket } } })`
    shape already shown two H2s up in the file — so the section
    can compress to a short pointer ("schemas are declared on the
    collection, not on `Db.create` — see §"Zod example" above")
    plus a sentence on the internal flattening if helpful for
    contributors writing tests.
- **Test churn:** none.

## Risk

Low. Docs-only change. The grep across `docs/`, `AGENTS.md`,
`examples/`, `bench/`, `manual-e2e/` for `Db.create(.*schemas`
turns up only this one file (the other matches in
`docs/adr/002-api-surface-lock.md` are the historical amendment
record, which describes the cut and stays intact). Adjacent §1c
"Declare an index on a collection" already uses the
`defineConfig({ collections: { tickets: { indexes: [...] } } })`
shape correctly; the §1b schemas subsection just needs the same
treatment. No risk of cascade beyond this file.
