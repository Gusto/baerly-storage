---
title: Versioning and compatibility
audience: maintainer
summary: The five version axes, where each lives, and the wire/schema/layout compatibility rules under semver. The machine-readable source is version-matrix.json.
last-reviewed: 2026-07-06
tags: [versioning, compatibility, governance, contract]
related: [change-discipline.md, "../../adr/003-layout-versioning-cordon.md", "../../adr/005-logentry-versionless.md", "../publishing.md", "../../spec/log-entry-shape.md"]
---

# Versioning and compatibility

baerly-storage has **five independent version axes**. Each answers a
different question — *which npm train is this?* vs. *has the wire
contract changed?* vs. *did a durable on-bucket schema change?* — and
they move independently, so no single version number can stand in for
the others. Conflating them, by bumping or trusting the wrong one, is
the mistake this table prevents. Use these names everywhere — docs,
code, fixtures, and any second-language implementation. The machine-readable source of truth is
[`../version-matrix.json`](../version-matrix.json), guarded against
code drift by `scripts/check-version-matrix.ts` on every `pnpm verify`.

## The five axes

| Axis | What it signals | Source of truth | Today |
| --- | --- | --- | --- |
| **Package semver** | npm release train + public TS API compatibility | `package.json#version` (lockstep: `@gusto/baerly-storage` + `@gusto/create-baerly-storage`) | `0.3.0` |
| **`specVersion`** | `/v1/spec` IR + HTTP/API contract shape — NOT bucket layout | `buildSpecIR().specVersion` (`packages/server/src/spec/ir.ts`) | `"1"` |
| **Per-artifact `schema_version`** | durable control-object schema (`current.json`, `gc/pending.json`, snapshot) | the `*_SCHEMA_VERSION` constants in `packages/protocol/src/constants.ts` | 3 / 1 / 1 |
| **`layout_version`** | bucket key-layout axis only | deferred; reserved namespace per [ADR-003](../../adr/003-layout-versioning-cordon.md) | implicit 1 (absent) |
| **Conformance corpus version** | checked-in fixture/test-data artifact | not yet introduced | — |

`LogEntry` carries **no** `schema_version`. It is versionless and
additive-only by decision — see
[ADR-005](../../adr/005-logentry-versionless.md).

## Provenance annotations (not axes)

`GET /v1/spec` also carries `serverVersion` — the published server
package `version` (equal to **Package semver** / `packageSemver`). It is
**build provenance, not a governed compatibility axis**: it is not a
sixth row, `check-spec-drift` does not gate its value, and it changes on
every release by construction. Consumers must key contract decisions off
`specVersion`, never `serverVersion`. (It was formerly named
`kernelVersion`, which wrongly implied a separate "kernel" contract axis;
the value and meaning are unchanged.) `specVersion` stays `"1"` across
that rename: pre-1.0, the served shape may change without forcing a
`specVersion` bump (see the compatibility rules below), and the
counter's first bump is reserved for a shape change a consumer or corpus
can actually observe.

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
second implementation exists**, the project moves fast: pre-1.0 semver
owes consumers no compat guarantee, exactly as
[`publishing.md`](../publishing.md#versioning) states for the package
axis and as the GitHub release notes reiterate. Wire/schema/layout may
change on a patch, except where a narrower artifact policy already
applies (for example ADR-005's versionless additive-only `LogEntry`
rule). A first consumer/corpus/second-implementation may already exist
in small numbers; the pre-1.0 latitude is what still permits change,
and those are the signals to tighten as it approaches.

**After the first production/external consumer, conformance corpus, or
second implementation exists:**

- No breaking wire/schema/layout change ships as a **patch**.
- While `0.x`: a breaking wire/schema/layout change requires a **minor**
  bump and a migration note in `CHANGELOG.md`.
- After `1.0`: it requires a **major** bump (aligns with the API surface
  lock's v1.0 hardening trigger — there is one hardening story, not two).
- Fixture regeneration requires a changeset, a schema/version impact
  note, and a fixture-diff summary.
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
- **Corpus version**: not yet introduced; the matrix records `null` /
  `not-yet-introduced`.
