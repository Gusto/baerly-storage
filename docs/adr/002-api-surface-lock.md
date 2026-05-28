---
title: API surface lock
audience: adr
summary: ADR 002 — API surface lock.
last-reviewed: 2026-05-28
tags: [decision, adr]
related: [README.md]
---

# 002 — API surface lock

## Status

Accepted.

## Context

The SQL-shape collection API lives in
[`packages/server/src/db.ts`](../../packages/server/src/db.ts),
[`packages/server/src/collection.ts`](../../packages/server/src/collection.ts),
and
[`packages/server/src/query.ts`](../../packages/server/src/query.ts).
The barrel at
[`packages/server/src/index.ts`](../../packages/server/src/index.ts)
exports these classes plus `Writer`, the maintenance budget
machinery, and the GC / compactor entry points.

The CLAUDE.md positioning is that "the protocol kernel is small
enough that an LLM can use the public API zero-shot from the `.d.ts`
files alone." Once that surface is exposed, every breaking change is
a downstream churn event with a long blast radius — and every
*redundant* type-valid path is a hallucination magnet that erodes
the zero-shot guarantee.

Three options for what "locked" should mean:

- **Hard lock.** No additions, no renames, no signature changes. The
  strictest interpretation; would block useful follow-ups (adding
  `count` after the fact would be impossible without a major version
  bump).
- **Additive-only lock.** New methods allowed; existing signatures
  frozen; behavioural changes prohibited. Matches semver
  minor-version semantics.
- **Convention-only.** Reviewer judgement, no rule. Inadequate for a
  vendorless library whose value-prop is "any LLM can use the `.d.ts`
  zero-shot."

## Decision

The public surface is **additive-only locked, scoped to
capabilities**. New methods, new optional config fields, and new
`BaerlyErrorCode` values are allowed without an ADR; renames and
behavioural shifts are prohibited and require a supersession ADR. A
second type-valid path to an existing capability is **not** an
addition — it is redundancy, and redundant forms are a defect.

## Locked surface

- `Db` ([`packages/server/src/db.ts`](../../packages/server/src/db.ts)) —
  exactly three methods:
  - `Db.create({ storage, app, tenant, config? }) -> Db` — fails
    `BaerlyError{code:"InvalidConfig"}` if `app` or `tenant` is
    empty.
  - `db.collection<T>(name) -> Collection<T>` — name must be
    non-empty and must not contain `/`.
  - `db.transaction<T>(collection, body) -> Promise<void>` — body
    receives `Collection<T>`, NOT `Db`; cross-collection writes are
    a compile error; single-attempt, CAS conflict throws
    `BaerlyError{code:"Conflict"}`.
  - Readonly properties: `db.app`, `db.tenant`.

- `Collection<T>`
  ([`packages/server/src/collection.ts`](../../packages/server/src/collection.ts)):
  `name` (readonly), `first()`, `all()`, `count()`, `get(id)`,
  `where(predicate)`, `order(spec)`, `limit(n)`, `insert(doc)`,
  `update(id, patch)`, `replace(id, doc)`, `delete(id)`. Mutation
  verbs operate by primary key.

- `Query<T>`
  ([`packages/server/src/query.ts`](../../packages/server/src/query.ts)):
  `where(predicate)`, `order(spec)`, `limit(n)`, `first()`, `all()`,
  `count()`, `update(patch)`, `delete()`. Bulk mutation verbs are
  kernel-only; no HTTP mirror exists, so `ClientQuery<T>` is
  read-only.

- `Db.transaction` callback context: a `Collection<T>` whose mutation
  verbs buffer; reads pass through to live storage. No MVCC, no
  read-your-writes. The buffer commits atomically via one
  `commitBatch` call.

- Predicates: object-form `Predicate<T>` is equality-only. The
  operator vocabulary (`eq` / `gt` / `gte` / `lt` / `lte` / `in`)
  lives on `PredicateBuilder<T>`, accessed via
  `.where(q => q.gte("priority", 5))`. Both forms normalise to one
  wire shape: a flat `clauses: PredicateClause[]` conjunction.

- Type-level guards: `_id` is excluded from `Path<T>` /
  `Predicate<T>` at the top level
  (`Path<T> = Exclude<_AllPaths<T>, "_id" | \`_id.${string}\`>`).
  Nested `_id`-named fields (embedded references) survive — at
  nested positions the field names a different document's primary
  key, not this row's.

- HTTP wire: `/v1/c/:collection`, `?collection=`, `?where=` carrying
  the flat-clauses JSON.

## Rationale

### Capabilities, not forms

The lock is on *capabilities*. A second type-valid path to an
existing capability is redundancy, not an addition — and redundant
forms are a defect against criterion #4 of the
[product thesis](../about/thesis.md) (the *redundant ceremony*
failure mode). If a PR adds `Collection<T>.method(x)` and the same
operation was previously expressible as
`Collection<T>.where({...}).other()`, the PR should either (a) make
the ceremony path not type-check, or (b) amend this ADR with the
justification for keeping both.

Two illustrative cases:

- **Mutations are by primary key.** `update(id, patch)`,
  `replace(id, doc)`, `delete(id)` — and `get(id)` for reads — live
  on `Collection<T>`. The predicate-aware bulk verbs stay on
  `Query<T>` for kernel use, but the
  `.where({_id}).first/update/replace/delete()` ceremony for the
  single-id case is gone: `_id` is excluded from `Path<T>` at the
  top level, so the type-valid path simply doesn't exist. One
  canonical form per capability.
- **`Db.create` config is minimal.** `metrics`, `schemas`, and
  `indexes` overrides were redundant with `config.collections[*]`
  (which is canonical) and with the module-level
  `setKernelMetricsRecorder(...)` (which is the right site for an
  observability sink configured once at adapter boot). The final
  shape is `Db.create({ storage, app, tenant, config? })` — four
  fields, no parallel knobs.

### Predicates are conjunction-only

The wire is intentionally a flat `clauses: PredicateClause[]` — a
conjunction of clauses, no tree root. This commits the algebra to
conjunction-only **in perpetuity**; `or` / `not` are NOT a future
feature behind a deferred amendment.

The structural cap on the operator vocabulary depends on these
methods not existing on `PredicateBuilder<T>`. `q.regex(...)` /
`q.or(...)` / `q.ne(...)` / `q.exists(...)` fail TS2339 at the call
site instead of `InvalidConfig` at runtime; "what we don't support"
is no longer a page in the docs that the model must keep in
context. Introducing boolean connectives later would re-open the
operator surface to the hallucination pressure that the design
exists to close. If the case for `or` / `not` ever becomes
load-bearing, that is a separate spec AND a separate ADR — never
additive on top of this one.

### Mechanism: type-constrained code generation

The empirical mechanism behind both choices is the same: fewer
type-valid paths → tighter typechecker signal on a wrong first
draft → faster correction in the agent loop. Type-Constrained Code
Generation (arXiv:2504.09246) measures this directly: type
constraints in the loop reduce compile errors and improve pass@1.
MongoDB's `/query` Copilot extension exists precisely because
`$`-keyed predicate shapes hallucinate operators with vanilla
LLMs — this design closes that surface structurally.

## Allowed additive changes (no ADR required)

- New methods on `Db` / `Collection` / `Query` that do not shadow
  existing names AND that do not provide a second path to an
  existing capability.
- New optional config fields on `Db.create` (e.g. `signal`).
- New `BaerlyErrorCode` values appended to the union in
  [`packages/protocol/src/errors.ts`](../../packages/protocol/src/errors.ts).

## Prohibited without a supersession ADR

- Renaming any method.
- Changing the callback signature of `Db.transaction` (e.g. passing
  `Db` instead of `Collection<T>`).
- Adding cross-collection writes inside a transaction — this would
  break the no-2PC invariant (see the JSDoc on `Db.transaction` in
  [`packages/server/src/db.ts`](../../packages/server/src/db.ts)
  and [ADR-001](./001-tenant-cas-isolation.md)).
- Changing the behavioural contract of an existing method (e.g.
  making `update` upsert instead of no-op-on-missing).
- Adding boolean connectives (`or` / `not`) to the predicate
  algebra — see *Predicates are conjunction-only* above.

## Consequences

- The conformance suite at
  [`tests/integration/conformance.test.ts`](../../tests/integration/conformance.test.ts)
  and the collection-API integration test at
  [`tests/integration/collection-api.test.ts`](../../tests/integration/collection-api.test.ts)
  are the executable specification of this lock. Either suite
  breaking on a PR means the surface changed and the PR needs an
  ADR.
- TypeScript `.d.ts` files exported from `packages/server/dist/`
  are the canonical user-facing artifact. Bundle-size tests at
  [`tests/integration/bundle-size.test.ts`](../../tests/integration/bundle-size.test.ts)
  implicitly track surface drift via byte-count changes.
- `db.transaction`'s single-collection scope is the load-bearing
  composition with the per-collection CAS scope
  ([ADR-001](./001-tenant-cas-isolation.md)). Reversing this lock
  would require either 2PC or per-tenant CAS; both were explicitly
  rejected.
- JSDoc on `Db.create`, `db.collection`, and `db.transaction` is
  the source of truth for parameter semantics; this ADR pins the
  surface-level shape but the JSDoc owns the behavioural contract.
  Per
  [`docs/contributing/conventions/docs.md`](../contributing/conventions/docs.md),
  the public-API reference lives as JSDoc on the implementation,
  not as a hand-maintained markdown ref.
- TypeScript is the enforcement mechanism for the callback shape
  (`transaction(callback: (tx: Collection<T>) => …)`); branded
  types (see the "Conventions" section of
  [`CLAUDE.md`](../../CLAUDE.md)) keep the verb signatures from
  being papered over with `as string`.
- The lock is reversible with cost. A future major version may
  revisit it; the supersession ADR records the new surface and
  consumers are notified via the semver major bump.
