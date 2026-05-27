# Promote the deferred-spec reasoning to an ADR

**Severity: MEDIUM. Pre-launch doctrine. The reasoning in the
deferred changes-iterator memo is reusable for every future
"should we ship X?" question; it should live where future-us
will find it.**

The deferred changes-iterator memo
(`docs/superpowers/specs/2026-05-25-changes-iterator-design.md`)
contains the strongest articulation of the pre-launch admission
criteria in the codebase. The five-objection structure (§1–§5)
is reusable for every future surface-addition decision; right now
it's living in a `specs/` directory where it'll get lost.

## What to do

Promote the reasoning to a permanent ADR. Suggested:

- **`/Users/eric.baer/workspace/baerly-storage/docs/adr/004-pre-launch-surface-admission-criteria.md`**
  (or wherever the next ADR number lands)

The ADR's job is to codify the **five tests** any new public
surface has to pass before it ships pre-launch:

1. **Workload-shape test.** Does the surface invite a workload
   the published cost ceiling (~30 writes/min/collection, ~10
   GB/tenant) cannot sustain? *(Deferred-memo §1.)*
2. **Graduation-coverage test.** Does the graduation story
   (`baerly export`) already cover the audiences who'd ask for
   this? If so, the absent surface routes them through
   graduation — which is the success path. *(Deferred-memo §2.)*
3. **Canonical-path test.** Does the existing kernel surface
   *already* serve this need via a single canonical path? If
   yes, the new surface is redundant ceremony per ADR-002.
   *(Deferred-memo §3.)*
4. **Escape-hatch pricing test.** Does the new surface exist
   only for power users who chose not to use the canonical
   higher-level surface? If yes, route them through internals or
   a lower-level primitive — don't ship polished surface for an
   audience that is exiting your audience. *(Deferred-memo §4.)*
5. **Reference-class test.** Is the new surface shape borrowed
   from a production-tier reference (Debezium / Datadog /
   Postgres / k8s)? If yes, pre-launch is the window to NOT ship
   borrowed maturity. *(Deferred-memo §5.)*

## ADR shape (rough sketch)

```markdown
# ADR-004: Pre-launch surface admission criteria

## Status
Accepted, pre-launch.

## Context
Pre-launch is the last window to keep the public surface small
and elegant. ADR-002 locks the surface additively. This ADR
documents the five tests a proposed addition must pass before it
ships pre-launch.

## Decision
Any new public surface (CLI verb, kernel method, client method,
React hook, exported type) is held against five tests before
ship. Failing any one is sufficient grounds to defer or cut.

[The five tests, structured as above.]

## Consequences
- "Defer" is a first-class outcome with a deferral-memo template
  (model: `docs/superpowers/specs/2026-05-25-changes-iterator-design.md`).
- New features that pass all five tests still ship additively
  under ADR-002.
- Post-launch the tests' weight shifts — borrowed-maturity surfaces
  may become reasonable once real audience evidence shows the
  workload is bounded.

## Worked examples
- **Deferred:** `client.table(name).changes()` async iterator —
  failed tests #1, #4, #5 (deferred-memo `2026-05-25-changes-iterator-design.md`).
- **Cut (pre-launch trim):** `baerly admin migrate` — failed
  test #1 (workload shape: invites schema-migration as a
  baerly-shaped flow). Failed core thesis ("No automatic schema
  migration").
- **Accepted:** `Db.create({ config })` single canonical form —
  passes tests #3 and #4 by removing `schemas`/`indexes`/`metrics`
  override knobs.
```

## What gets harder after

- Every new surface proposal has a documented gate to clear.
  **Net win** — that's what the ADR is for.
- A reviewer can now point at "test #N" instead of re-arguing the
  deferred-memo every time. **Net win.**

## When to delete

When baerly has shipped publicly for ~12 months and real audience
evidence has materially shifted the picture, this ADR may become
stale. Mark `superseded by ADR-XXX` rather than deleting; the
historical record of how surface was admitted pre-launch is
valuable.

## Related

- **Source memo:** `docs/superpowers/specs/2026-05-25-changes-iterator-design.md`
- **Surface-lock companion:** `docs/adr/002-api-surface-lock.md`
- **Strengthening companion:** `strengthen-thesis-message.md`
- **Every other followup in this directory** that says "cut" —
  this ADR is the doctrine those cuts cite.
