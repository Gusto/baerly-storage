---
title: Versioning and compatibility
audience: maintainer
summary: The five version axes, where each lives, and the wire/schema/layout compatibility rules under semver. The machine-readable source is version-matrix.json.
last-reviewed: 2026-06-27
tags: [versioning, compatibility, governance, contract]
related: [change-discipline.md, "../../adr/003-layout-versioning-cordon.md", "../../adr/005-logentry-versionless.md", "../publishing.md", "../../spec/log-entry-shape.md"]
---

# Versioning and compatibility

baerly-storage has **five independent version axes**. Use these names
everywhere — docs, code, fixtures, and any second-language
implementation. The machine-readable source of truth is
[`../version-matrix.json`](../version-matrix.json), guarded against
code drift by `scripts/check-version-matrix.ts` on every `pnpm verify`.

## The five axes

| Axis | What it signals | Source of truth | Today |
| --- | --- | --- | --- |
| **Package semver** | npm release train + public TS API compatibility | `package.json#version` (lockstep: `@gusto/baerly-storage` + `@gusto/create-baerly-storage`) | `0.3.0` |
| **`specVersion`** | `/v1/spec` IR + HTTP/API contract shape — NOT bucket layout | `buildSpecIR().specVersion` (`packages/server/src/spec/ir.ts`) | `"1"` |
| **Per-artifact `schema_version`** | durable control-object schema (`current.json`, `gc/pending.json`, snapshot) | the `*_SCHEMA_VERSION` constants in `packages/protocol/src/constants.ts` | 3 / 1 / 1 |
| **`layout_version`** | bucket key-layout axis only | deferred; reserved namespace per [ADR-003](../../adr/003-layout-versioning-cordon.md) | implicit 1 (absent) |
| **Conformance corpus version** | checked-in fixture/test-data artifact | not yet introduced (Tier B) | — |

`LogEntry` carries **no** `schema_version`. It is versionless and
additive-only by decision — see
[ADR-005](../../adr/005-logentry-versionless.md).

## Compatibility rules

Public TS API compatibility is governed by the
[API surface lock](change-discipline.md#api-surface-lock) (additive-only
lock, v1.0 hardening trigger). Durable-artifact schema evolution is
governed by [ADR-003](../../adr/003-layout-versioning-cordon.md)
(additive-optional fields don't bump; breaking shape changes bump the
artifact's `schema_version`). This section covers the **wire + schema +
layout** compatibility *promise under semver*, which the API lock and
ADR-003's versioning mechanism do not by themselves state.

**Before a first production/external consumer, conformance corpus, or
second implementation exists** (today), the project moves fast: pre-1.0
semver owes consumers no compat guarantee, exactly as
[`publishing.md`](../publishing.md#versioning) states for the package
axis. Wire/schema/layout may change on a patch, except where a narrower
artifact policy already applies (for example ADR-005's versionless
additive-only `LogEntry` rule).

**After the first production/external consumer, conformance corpus, or
second implementation exists:**

- No breaking wire/schema/layout change ships as a **patch**.
- While `0.x`: a breaking wire/schema/layout change requires a **minor**
  bump and a migration note in `CHANGELOG.md`.
- After `1.0`: it requires a **major** bump (aligns with the API surface
  lock's v1.0 hardening trigger — there is one hardening story, not two).
- Fixture regeneration requires a changeset, a schema/version impact
  note, and a fixture-diff summary (a future Tier B drift gate is
  planned to enforce the mechanics).
- Keep at least one previous-corpus readback fixture after the first
  compatibility promise.

## Bumping an axis

- **A durable schema** (`current.json` / `gc/pending` / snapshot): bump
  the matching `*_SCHEMA_VERSION` constant *only* on a breaking shape
  change (rename/remove/repurpose a field). Adding an optional field is
  not breaking (ADR-003). `pnpm gen:version-matrix` then refreshes
  `version-matrix.json`; commit it.
- **`specVersion`**: bump in the IR generator when the `/v1/spec`
  contract shape changes; `check-spec-drift` + `check-version-matrix`
  both gate it.
- **`layout_version`**: do not add until a real key-layout change
  exists; that is an ADR-003 amendment, not a silent matrix edit.
- **Corpus version**: introduced by Tier B; until then the matrix
  records `null` / `not-yet-introduced`.
