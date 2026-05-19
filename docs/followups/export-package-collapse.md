# `@baerly/export`: collapse into CLI; one publishable surface less

**Severity: MEDIUM. The `@baerly/export` package ships ~2300 LoC
and 13 named exports for what's effectively four CLI consumers
in-repo. Pre-launch is the right time to demote it from
publishable package to private CLI module.**

## Current state

`packages/export/src/` totals ~2264 LoC (analyst said 1500; real
number is bigger). The package exports 13 named symbols:

- Types: `ColumnPlan`, `ExportPlan`, `ExportRow`, `SqlTarget`, `SqlType`
- Functions: `inferPlanForCollection`, `loadMaterialisedView`,
  `emitCreateTable`, `emitInsertStatements`, `quoteIdentifier`,
  `quoteValue`, `translatePredicateToSql`
- Plus: `serializeExportPlan`, `deserializeExportPlan`

Real consumers across the repo: **four CLI files**, not the one
the analyst claimed:

- `packages/cli/src/export.ts`
- `packages/cli/src/dump.ts`
- `packages/cli/src/fsck.ts`
- `packages/cli/src/inspect.ts`

Plus one round-trip integration test that exists to validate the
SQLite emitter.

## Two specific cruft items

### a. `where.property.test.ts` is "property"-named but fixture-driven

`packages/export/src/where.property.test.ts` is 359 LOC. Grep for
`fc\.` (fast-check) returns **zero** matches. The file ships a
hand-rolled SQL parser/evaluator as a regression guard for eight
fixtures — that's fixture-driven testing wearing a property-test
costume. Misleading filename.

### b. `package.json` is missing `publishConfig` + `sideEffects`

`packages/export/package.json` lacks the `publishConfig` block
that sibling packages use to rewrite `./src/*.ts` →
`./dist/*.js` for the published artifact. And `sideEffects: false`
is missing. If this package ever shipped publicly, it would
publish raw `.ts` paths and prevent tree-shaking.

Cross-check siblings:

- `packages/client/package.json` — has both fields ✓
- `packages/server/package.json` — has both fields ✓
- `packages/export/package.json` — neither ✗

## Fix

**Collapse `@baerly/export` into `packages/cli/src/export/` as
private modules.**

Move the source tree:

- `packages/export/src/index.ts` → `packages/cli/src/export/index.ts`
- `packages/export/src/*.ts` → `packages/cli/src/export/*.ts`
- Drop the `@baerly/export` workspace package entirely.

Drop the public package + the phantom property-test file. Drop
the `publishConfig` / `sideEffects` concern by virtue of the
package no longer being publishable.

Coordinate with the CLI's existing import shape (the four CLI
files currently `import { ... } from "@baerly/export"` — those
become relative imports under `packages/cli/src/export/`).

If a future adapter or third-party tool needs the SQL emitters
(`emitCreateTable`, `emitInsertStatements`), promote selectively
at that point — but only the actually-needed names, and only with
a real consumer asking for them.

## What about the `where.property.test.ts` rename?

If the collapse happens: move the file alongside its peers under
`packages/cli/src/export/`, rename to `where.test.ts`, and let
the misleading "property" framing die without ceremony.

If the collapse doesn't happen (decision below): rename the file
to `where-fixtures.test.ts` in-place to match what it actually is.
Same week, much smaller PR.

## Decision criteria

The collapse is the right call **unless** at least one of these
becomes true between now and launch:

- A second consumer surfaces (another adapter, a third-party tool,
  a documented use case).
- The export logic needs to live in two runtimes
  (e.g. browser + Node) — and even then, the CLI is Node-only
  today, so this is hypothetical.

Neither feels likely pre-1.0. **Recommendation: collapse.**

## Verify after collapse

- `pnpm verify` passes (no broken imports).
- `pnpm test:export-smoke` and `pnpm test:export-round-trip`
  still run — update the script paths if needed.
- `pnpm build` produces only `dist/cli/...` for the export
  helpers; nothing under `dist/export/`.
- The `@baerly/export` workspace dependency is gone from
  `pnpm-workspace.yaml` and from every consumer's package.json.

## Cross-references

- `cf-worker-surface-trim.md` and other "narrow the surface"
  followups share the same instinct: pre-launch is the time to
  consolidate; once public, every demotion is a breaking change.
