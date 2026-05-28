---
title: Pare-back sweep — 2026-05-27
discovered: 2026-05-27
candidate_count: 0
verified_dropped: 2
---

# Pare-back sweep — 2026-05-27

Ranked by `est_loc ÷ risk_score`, descending. Re-validate each
candidate's evidence before opening a cut ticket. Subagent reports
were verified by re-grepping symbol locations and reading the cited
files; two candidates were dropped because the subagent's framing
did not survive verification (see the verification log below).

## Top ranked

(none open — both candidates shipped 2026-05-27.)

## By concern

### redundant-api-forms (0)

(none found — the one candidate proposed by the subagent had its
cut direction reversed; see verification log.)

### configurability-without-consumers (0)

(none open — `cut-since-max-events` shipped 2026-05-27.)

### operator-verb-without-audience (0)

(none found — prior cuts `cut-cli-admin-copy`,
`cut-cli-admin-compact-gc`, `cut-cli-admin-migrate` already
collapsed the on-call-shaped surface. The remaining verbs
(`baerly cost`, `baerly doctor`, `baerly export`, `baerly admin
dump/restore/fsck`, `baerly inspect`, `baerly init`, `baerly
deploy`) each satisfy one of the three thesis exceptions or have
documented audience reach.)

### internal-seam-without-payoff (0)

(none open — `cut-observability-unit-type` shipped 2026-05-27.)

### doc-surface-tracking-ghost-features (0)

(none open — `cut-extending-md-schemas-section` shipped 2026-05-27.
The fix also closed silent drift in `bench/load-harness/` where
`indexes:` was being passed to `Db.create` and ignored — see the
shipping commit for details.)

### dev-or-test-scaffolding-leaking-public (0)

(none found — the one candidate proposed by the subagent
(`getOrCreateMemoryStorageForBucket` / `resetMemoryStorage`) had
its leak-framing fail verification; see verification log.)

## Verification log

Main-agent spot-checks performed before files landed:

- `cut-extending-md-schemas-section.md` — VERIFIED. Read the cited
  subsection (`extending.md` §"Wiring schemas into `Db.create`")
  end-to-end: section opens with the false claim "`Db.create`
  accepts a flat `schemas: ReadonlyMap<string, SchemaValidator>`"
  and the worked example passes `schemas` as a `Db.create`
  parameter, both of which contradict the 2026-05-27 ADR-002
  amendment. Verified the other two `Db.create(...)` references
  in the same file (`extending.md:Db.create at the "test the
  feature" example` and `extending.md:Db.create at the "tests
  live in" example`) are current `{ storage, app, tenant }`-only
  signatures; they are out of scope.

- `cut-table-whole-collection-reads.md` — DROPPED. Subagent
  proposed cutting `Table<T>.first()` / `.all()` / `.count()` (the
  no-arg forms) in favour of forcing every caller through
  `.where({}).first/all/count()`. Verification reversed the
  direction: every production scaffold uses the no-arg shorthand
  (`examples/minimal-cloudflare/src/web/main.ts:client.table<Note>("notes").all()`
  and three sibling files), and 0 production callers use
  `.where({})`. The "Equivalent to `.where({}).first()`" JSDoc on
  the Table methods is an *equivalence note for users*, not a
  signal that the short form is the redundant side. The reverse
  cut (forbid empty-object `Predicate<T>`) is a Predicate
  type-system redesign and falls outside the pare-back lens
  ("removing", not "redesigning"). No file written.

- `cut-test-harness-singletons.md` — DROPPED. Subagent claimed
  `getOrCreateMemoryStorageForBucket` / `resetMemoryStorage` leak
  to user-facing surface via `packages/protocol/src/storage/index.ts`'s
  `export *`. Verification: `@baerly/protocol` is a
  workspace-internal package (no `publishConfig`), consumed only
  by adapter / cli / server source. The user-facing barrel
  `packages/server/src/index.ts` curates re-exports from
  `@baerly/protocol` by name and includes `MemoryStorage` only —
  the two test helpers are NOT re-exported. Additionally,
  `packages/cli/src/bucket-uri.ts:parseBucketUri` is a real
  non-test consumer of `getOrCreateMemoryStorageForBucket` (it
  backs the `memory://<bucket>` CLI URI used by load benchmarks
  and admin tests). Neither the leak premise nor the
  zero-non-test-consumers premise survives verification. No file
  written.

## Concerns not yet swept

All six concern lenses ran to completion. None errored.
