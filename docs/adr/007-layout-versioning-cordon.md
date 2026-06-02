---
title: Layout versioning and the reserved-namespace cordon
audience: adr
summary: ADR 007 — schema_version is a per-artifact shape sentinel; the bucket key-layout axis is distinct and deferred (layout_version, additive-optional); the leading-underscore namespace is reserved now.
last-reviewed: 2026-06-01
tags: [decision, adr, runtime-model]
related: [README.md, "../about/thesis.md", 001-tenant-cas-isolation.md, 004-ephemeral-coordination.md]
---

# 007 — Layout versioning and the reserved-namespace cordon

## Status

Accepted (2026-06-01). Step 2 ("Likely v2 shape") is explicitly
non-binding and pending v2 requirements; everything else is firm.

## Context

Baerly persists three kinds of coordination artifact that a reader
must be able to validate before trusting: `current.json` (the
per-tenant CAS coordination object — see
[ADR-001](001-tenant-cas-isolation.md)), the snapshot blob, and
the `gc-pending` ledger. Each one will change shape over the
project's life. The questions this ADR answers are: *what tells a
reader the shape changed, what is the rule for adding a field
without breaking old readers, and is "the on-disk shape changed"
the same axis as "the keys moved"?*

These questions are pre-launch-cheap and post-launch-expensive in
different amounts. The parts that constrain user-facing names
(what a collection or index may be called) are the expensive ones
once buckets exist in the wild; the parts that are purely internal
(an integer's name, an as-yet-unused field) are reversible at any
time. This ADR decides the expensive parts now and records the
cheap parts as deliberately deferred so their absence reads as the
doctrine being followed, not as a gap.

## Decision

### 1. `schema_version` is a per-artifact shape sentinel

Each coordination artifact carries a `schema_version`: a monotonic
integer for *that artifact's required shape*, bumped when the shape
changes, and rejected by readers when unrecognized. `current.json`,
the snapshot blob, and `gc-pending` each carry their own — the
integer is per-artifact, but it is **the same concept on all
three**, and that uniformity is intentional. A reader that does not
recognize an artifact's `schema_version` refuses it rather than
coercing an unknown shape (`assertCurrentJson` throws
`InvalidResponse`; the `gc-pending` guard does the same).

Worked example — the v1→v2 bump of `current.json` in commit
`a53e4f84`: it added the required `tail_bytes` / `snapshot_bytes` /
`snapshot_rows` fields that the in-band write-tick maintenance loop
needs (byte/row accounting maintained exactly by the full-fence
CAS), and surfaced a hard, actionable reject for v1 buckets. That
bump is move (b) below.

### 2. Two compatible-evolution moves, both legitimate

There are two ways the shape evolves, and the kernel uses **both**:

- **(a) Additive-optional, no bump (Tier 1).** A new field MUST be
  optional with a reader-supplied default, and unknown keys are
  ignored. Forward-compat holds today:
  [`assertCurrentJson`](../../packages/protocol/src/coordination/current-json.ts)
  validates only the fields it knows and never enumerates or
  rejects extras, so an old reader tolerates a future additive
  field, and a new reader supplies the default when the field is
  absent. (Pinned by a regression test landed in the same plan as
  this ADR.) This is the default for non-breaking additions.
- **(b) Shape bump.** When a change needs a *required* field — so
  old artifacts genuinely cannot be read — bump that artifact's
  `schema_version` and have readers reject the old generation. This
  is what `a53e4f84` did.

**Scope the Tier-1 rule honestly.** "New fields are
optional-with-default" is the rule for *additive* evolution, not a
blanket law about every change. A required-field change is move
(b), and this ADR does not claim the kernel only ever does (a) when
shipping code does (b). The rule chooses (a) over (b) whenever (a)
suffices; it does not pretend (b) never happens.

### 3. Bucket key-layout is a distinct axis, deferred

The shape of an artifact and the *layout of keys in the bucket* are
two different axes. The v1→v2 `current.json` bump proves it: the
shape evolved with **zero key relocation**. A future change that
relocates bulk keys — cordoning them under a reserved `_v<N>/`
prefix — is not a shape change and is not governed by
`schema_version`.

When that axis is needed it will be introduced as an
**additive optional field** — intended name `layout_version`,
default `1` when absent — i.e. it follows move (a) and ships
non-breaking. It is **not introduced now**, and that deferral is
itself the canonical worked example of move (a):

- An additive optional field is free to add at the next shape
  generation, so introducing it now is not pre-launch-only work —
  there is no window that closes.
- A bucket written today is *already* unambiguously layout 1,
  because readers default an absent `layout_version` to `1`. There
  is nothing to migrate and nothing to disambiguate.

So the field's absence today is the doctrine working as designed,
not a missing feature. (Name note: `layout_version` pairs with the
`_v<N>` key-layout cordon. `format_version` — the Iceberg
precedent — was considered; either name works, and the choice is
deferred to the point of introduction.)

**Do not add `layout_version` to code as part of this ADR.** This
is a docs-only decision; the field lands only with the v2 change
that needs it.

### 4. The leading-underscore namespace is reserved now

Collection and index names MUST NOT begin with `_` (the rule is
enforced across all key-segment names — app, tenant, and collection —
via the shared `assertKeySegment`, since they share one key
namespace). The leading
underscore is system-reserved (the Mongo/Firestore convention), and
it subsumes the future `_v<N>` layout prefix. This is the one part
that is genuinely harder to introduce once users exist — it
constrains user-facing names — so it is reserved **now**, before
any name has been chosen against the unrestricted space.

#### Error contract for the reserved rule (owning the trade-off)

- A **reserved-namespace violation** (a name beginning with `_`)
  throws `BaerlyError{code:"InvalidConfig"}`, for both collections
  and indexes.
- A **malformed** index name (one that fails the lexical
  identifier regex) keeps `BaerlyError{code:"SchemaError"}`, as it
  does today.

These are two different rules — a *named-rule* check (the reserved
namespace) versus a *lexical* check (the identifier grammar) — so
two error codes is defensible. The honest consequence is that an
index name can fail *either* way and get *different* codes
depending on which rule it trips. We accept that as the cost of
keeping the named-rule and lexical-rule distinctions legible, on
the condition that **each message names its own rule** so a reader
of the error knows which check fired. This is the plan's one
deliberate concession on developer experience (priority #1);
recording the trade-off here is what stops it being re-litigated
later as a bug.

### 5. No standing upcaster framework

A shape bump is a deploy-time constant — the build that reads
generation N is the build that writes generation N. There is no
runtime knob that selects a generation, no chain of upcaster
functions that transforms generation N−k forward at read time, and
no auto-migration on boot. A reader that meets an unrecognized
generation rejects it; bringing a bucket forward is a deliberate,
separately-decided operation, not an implicit runtime behavior.

## Likely v2 shape — pending v2 requirements, not yet doctrine

> This section is **non-binding**. It exists only to explain why the
> reserved `_` namespace and the `layout_version` intent are decided
> now.

An incompatible future change is expected to introduce the
`layout_version` axis and cordon bulk data under a reserved
`_v<N>/` prefix. Everything else — how a reader detects which layout
a bucket is in, how the migration runs, whether prior-generation
data is retained or reclaimed, and whether a `migrate` verb returns
— is **deferred to v2's real requirements and deliberately left
unwritten here**. No mechanism is specified by this ADR.

## Operator-burden constraint (firm)

This is a now-binding constraint on whatever v2 turns out to be:
**reclaiming cordoned prior data must never depend on
operator-configured bucket policy as a correctness requirement.**
Requiring an operator to install an S3/R2 lifecycle rule for the
kernel to behave correctly would violate the "Just a Bucket" thesis
criterion (zero operator infrastructure — see
[thesis.md](../about/thesis.md#what-prototype-tier-storage-needs))
and the operator-burden test in
[`change-discipline.md`](../contributing/conventions/change-discipline.md#operator-burden-test-for-new-mechanisms),
the same doctrine that keeps coordination request-bounded in
[ADR-004](004-ephemeral-coordination.md).

**Resolution:** reclamation is optional and never required for
correctness. A bare bucket keeps working; cordoned prior-generation
data is idle and therefore idle→zero cost (it is read by nothing on
the live path). An operator MAY reclaim it via a lifecycle rule or a
manual purge if they want the space back, but the kernel requires no
bucket policy to be correct.

## Rejected alternatives

- **Rename `schema_version` now.** It is internal, already a
  uniform sentinel across all three artifacts, and renamable at any
  time — not pre-launch-only work, so deferred on the
  do-it-when-it-pays principle.
- **Introduce `layout_version` now.** Additive-optional and free to
  add later (§3); adding it before there is a layout to version is
  speculative.
- **Silent cordon** (relocate keys with no version field). Leaves a
  reader unable to tell which layout it is reading — exactly the
  ambiguity the sentinel exists to prevent.
- **Second-GET detection** (probe for the cordon by issuing an
  extra GET). Adds a per-read storage op and breaks the idle-reader
  cost bound that ADR-004's in-band model preserves.
- **Build the full versioning framework now.** No caller, no
  requirements; speculative generality.
- **Behavior-knob env var** to select a generation at runtime.
  Generation is a deploy-time constant (§5); an env knob invites
  environment-divergent behavior.
- **Standing upcaster chain.** Same reason as §5 — no runtime
  generation selection.
- **Auto-migrate-on-boot.** Migration is a deliberate operation,
  not an implicit boot side-effect.
- **Ad-hoc `/^_v/` carve-out** (reserve only the exact `_v<N>`
  prefix). Rejected in favor of the systematic leading-`_`
  reservation, which subsumes `_v<N>` and matches the
  Mongo/Firestore convention.

## Precedents

A handful of prior-art points that shaped the now-decisions (this is
not a literature review):

- Apache Iceberg's
  [`format-version`](https://github.com/apache/iceberg/blob/main/format/spec.md)
  — a named, monotonic format axis distinct from table data;
  precedent for treating layout as its own versioned axis (§3).
- Delta Lake
  [table features](https://delta.io/blog/2023-07-27-delta-lake-table-features/)
  — additive capability flags that do not force a version bump;
  precedent for the Tier-1 additive-optional move (§2a).
- Martin Fowler's
  [ParallelChange](https://martinfowler.com/bliki/ParallelChange.html)
  (expand / migrate / contract) — the shape of a safe incompatible
  migration when one is eventually needed.

## Surface note

`baerly admin migrate` / `migrateCollection` was cut on 2026-05-27
(it was a collection-rename verb). The v2 migration verb anticipated
in the non-binding section above is a *different* thing and will be
added only when a real caller needs it — not resurrected from the
cut surface.
