---
title: Layout versioning and the reserved-namespace cordon
audience: adr
doc_type: adr
summary: ADR 003 — schema_version is a per-artifact shape sentinel; the bucket key-layout axis is distinct and deferred (layout_version, additive-optional); the leading-underscore namespace is reserved now. The tolerant-reader rule lives in extending.md; this record keeps the reservation and the rejected upcaster/cordon paths.
last-reviewed: 2026-06-28
tags: [decision, adr, runtime-model]
related: [README.md, "../about/thesis.md", "../contributing/extending.md", 001-tenant-cas-isolation.md, 002-ephemeral-coordination.md]
---

# 003 — Layout versioning and the reserved-namespace cordon

## Status

Accepted (2026-06-01). The "Likely v2 shape" note below is **non-binding**,
pending real v2 requirements; everything else is firm.

## Decision

1. **`schema_version` is a per-artifact shape sentinel.** `current.json`,
   the snapshot blob, and `gc-pending` each carry a monotonic integer for
   their own required shape; a reader that meets an unrecognized version
   **rejects** it rather than coercing an unknown shape.
2. **Two legitimate evolution moves.** (a) *Additive-optional, no bump*: a
   new field is optional with a reader-supplied default and unknown keys
   are ignored — the default move. (b) *Shape bump*: a change needing a
   **required** field bumps that artifact's `schema_version` and readers
   reject the old generation.
3. **Bucket key-layout is a distinct axis, deferred.** Artifact shape and
   *the layout of keys in the bucket* are different axes. Relocating bulk
   keys under a reserved `_v<N>/` prefix is **not** a shape change; when
   needed it ships as additive-optional `layout_version` (default `1`). Not
   introduced now — a bucket written today is unambiguously layout 1.
4. **The leading-`_` namespace is reserved now.** Collection, index, app,
   and tenant names MUST NOT begin with `_` (enforced by the shared
   `assertKeySegment`). This is the one genuinely-irreversible-after-launch
   rule — it constrains user-facing names — so it is reserved **before**
   any name is chosen against the unrestricted space, and it subsumes the
   future `_v<N>` prefix. A reserved-namespace violation throws
   `InvalidConfig`; a name that fails the lexical identifier regex keeps
   `SchemaError` — two rules, two codes, each message naming its own rule.
5. **No standing upcaster framework.** A shape bump is a deploy-time
   constant — the build that reads generation N is the build that writes
   it. No runtime generation knob, no upcaster chain, no auto-migrate on
   boot. Bringing a bucket forward is a deliberate, separately-decided
   operation.

**The live tolerant-reader / additive-optional rule lives in
[extending.md §Forward-only migration](../contributing/extending.md#forward-only-migration);
the reserved-`_` error contract lives in
[extending.md §1c](../contributing/extending.md#1c-declare-an-index-on-a-collection).**

## Operator-burden constraint (firm)

Binding on whatever v2 becomes: **reclaiming cordoned prior data must
never depend on operator-configured bucket policy as a correctness
requirement.** A bare bucket keeps working; cordoned prior-generation data
is idle (idle→zero cost). An operator MAY reclaim it via a lifecycle rule,
but the kernel requires no bucket policy to be correct — the same
zero-operator-infrastructure doctrine that keeps coordination
request-bounded in [ADR-002](002-ephemeral-coordination.md).

## Closed paths

- **Silent cordon** (relocate keys with no version field) — leaves a
  reader unable to tell which layout it is reading.
- **Second-GET detection** (probe for the cordon with an extra GET) — adds
  a per-read storage op and breaks the idle-reader cost bound.
- **Behavior-knob env var, standing upcaster chain, auto-migrate-on-boot**
  — generation is a deploy-time constant; runtime generation selection
  invites environment-divergent behavior.
- **Ad-hoc `/^_v/` carve-out** — rejected for the systematic leading-`_`
  reservation, which subsumes `_v<N>` and matches the Mongo/Firestore
  convention.

## Likely v2 shape — non-binding

An incompatible future change is expected to introduce `layout_version`
and cordon bulk data under `_v<N>/`. How a reader detects the layout, how
migration runs, and whether a `migrate` verb returns are **deferred to
v2's real requirements** — no mechanism is specified here.
