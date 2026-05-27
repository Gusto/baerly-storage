---
title: API surface lock
audience: adr
summary: ADR 002 — API surface lock.
last-reviewed: 2026-05-26
tags: [decision, adr]
related: [README.md]
---

# 002 — API surface lock

## Status

Accepted (2026-05-11).

- Amended (2026-05-21): mutations moved to by-primary-key on `Table<T>`
  (`update(id, patch)`, `replace(id, doc)`, `delete(id)`), and reads
  `first()` / `all()` / `count()` / `get(id)` are now table-level. The
  predicate-aware bulk mutation verbs stay on `Query<T>` (kernel only —
  the wire has no bulk mutation route). The lock's "additive-only"
  contract is reset against the new baseline. See ticket
  `01-table-api-by-id-mutations.md` for the supersession context.
- Amended (2026-05-26): scoped "additive-only" to capabilities, not
  forms — a redundant type-valid path to an existing capability is
  a defect, not an addition. See "Scope of 'additive'" below.
- Amended (2026-05-26): `_id` excluded from `Path<T>` / `Predicate<T>`
  at the top level via `Path<T> = Exclude<_AllPaths<T>, "_id" |
  \`_id.${string}\`>`. Nested `_id`-named fields (embedded references)
  survive — at nested positions the field names a different document's
  primary key, not this row's. The `.where({_id}).first/update/replace/
  delete()` ceremony was a redundant type-valid path to a capability
  served by `.get(id)` / `.update(id, p)` / `.replace(id, d)` /
  `.delete(id)`.

  Mechanism: fewer type-valid paths → tighter typechecker signal on
  a wrong first draft → faster correction in the agent loop. This
  is the empirically-supported mechanism (Type-Constrained Code
  Generation, arXiv:2504.09246 — type constraints in the loop
  measurably reduce compile errors and improve pass@1).

  Cross-system precedent for the asymmetry: Convex reserves
  underscore-prefixed names at the top level of `defineTable` only;
  JSON-LD's `@id` carries different semantics at root vs nested per
  W3C; Prisma allows `id` in nested-relation filters.

  Second worked example of the 2026-05-26 "additive-only scoped to
  capabilities" amendment (the first was the Table API collapse).

  See spec
  `docs/superpowers/specs/2026-05-25-get-by-id-split-design.md`.

- Amended (2026-05-26): predicate redesign — object-form `Predicate<T>`
  is equality-only; the operator vocabulary
  (`eq` / `gt` / `gte` / `lt` / `lte` / `in`) moves to the callback
  builder `PredicateBuilder<T>` accessed via
  `.where(q => q.gte("priority", 5))`. Both forms normalise to one
  wire shape (`{ clauses: PredicateClause[] }`); the server has one
  parser, and `?where=` carries that JSON.

  Mechanism: structural cap on the operator surface. The methods on
  `PredicateBuilder<T>` ARE the vocabulary — there is no `$`-keyed
  AST to over-reach against. `q.regex(...)` / `q.or(...)` /
  `q.ne(...)` / `q.exists(...)` fail TS2339 at the call site instead
  of `InvalidConfig` at runtime; "what we don't support" is no
  longer a page in the docs that the model must keep in context.
  Type-constrained code generation (arXiv:2504.09246) supports the
  mechanism; absent operator-hallucination benchmarks for this exact
  shape, this is a mechanism + industry-signal bet (MongoDB's
  `/query` Copilot extension exists because `$`-keyed shapes
  hallucinate operators with vanilla LLMs).

  Third worked example of the 2026-05-26 "additive-only scoped to
  capabilities" rule: range / in queries are still expressible —
  the capability is preserved — but the redundant
  `{field: {$op: v}}` type-valid path is removed in favour of the
  builder. The new wire shape is the canonical on-disk encoding of
  any predicate; the object literal compiles down to it.

  **Predicate algebra lock decision (settled here).** The wire is
  intentionally a flat `clauses: PredicateClause[]` — a conjunction
  of clauses, no tree root. This commits the algebra to
  conjunction-only in perpetuity; `or` / `not` are NOT a future
  feature behind a deferred amendment. The argument for the flat
  shape is that the structural cap on the vocabulary depends on
  these methods not existing on `PredicateBuilder<T>`; introducing
  them later would re-open the operator surface to hallucination
  pressure that the redesign exists to close. If the case for
  boolean connectives ever becomes load-bearing, that is a separate
  spec AND a separate ADR — never additive on top of this one.

  See spec
  `docs/superpowers/specs/2026-05-25-predicate-redesign-design.md`.

## Context

The SQL-shape table API lives in
[`packages/server/src/db.ts`](../../packages/server/src/db.ts),
[`packages/server/src/table.ts`](../../packages/server/src/table.ts),
and
[`packages/server/src/query.ts`](../../packages/server/src/query.ts).
The barrel at
[`packages/server/src/index.ts`](../../packages/server/src/index.ts)
exports these classes plus `Writer`, the maintenance budget
machinery, and the GC / compactor entry points. The CLAUDE.md
positioning is that "the protocol kernel is small enough that an LLM
can use the public API zero-shot from the `.d.ts` files alone"; once
that surface is exposed, every breaking change is a downstream churn
event with a long blast radius.

Two factual anchors describe what is in the lock today:

1. `Db` exposes exactly four methods: `Db.create`, `db.table`,
   `db.transaction`, and the `db._raw` escape hatch
   ([`packages/server/src/db.ts:140-464`](../../packages/server/src/db.ts)).
2. `Table<T>` exposes the common-case verbs (`first`, `all`, `count`,
   `get`, `insert`, `update`, `replace`, `delete` — by primary key)
   plus modifiers (`where`, `order`, `limit`, `consistency`) returning
   a `Query<T>`. The transaction callback receives a `Table<T>`, not a
   `Db`, so cross-table writes inside `transaction()` are a TypeScript
   compile error
   ([`packages/server/src/db.ts:464-510`](../../packages/server/src/db.ts)).

Three options for what "locked" should mean:

- **Hard lock.** No additions, no renames, no signature changes. The
  strictest interpretation; it would block useful follow-ups (adding
  `count` after the fact would be impossible without a major version
  bump).
- **Additive-only lock.** New methods are allowed; existing signatures
  are frozen; behavioural changes are prohibited. Matches semver
  minor-version semantics.
- **Convention-only.** Reviewer judgement, no rule. Inadequate for a
  vendorless library whose value-prop is "any LLM can use the `.d.ts`
  zero-shot."

## Decision

The public surface is *additive-only* locked. New methods, new
optional config fields, and new `BaerlyErrorCode` values are allowed
without an ADR; renames and behavioural shifts are prohibited and
require a supersession ADR.

Locked surface, by file:

- `Db` ([`packages/server/src/db.ts`](../../packages/server/src/db.ts)):
  - `Db.create({ storage, app, tenant }) -> Db` — fails
    `BaerlyError{code:"InvalidConfig"}` if `app` or `tenant` is empty.
  - `db.table<T>(name) -> Table<T>` — name must be non-empty and must
    not contain `/`.
  - `db.transaction<T>(table, body) -> Promise<void>` — body receives
    `Table<T>`, NOT `Db`; cross-table writes are a compile error;
    single-attempt, CAS conflict throws `BaerlyError{code:"Conflict"}`.
  - `db._raw: RawStorageApi` — escape hatch; re-applies the
    `app/<app>/tenant/<tenant>/` prefix internally.
  - Readonly properties: `db.app`, `db.tenant`.
- `Table<T>`
  ([`packages/server/src/table.ts`](../../packages/server/src/table.ts)):
  `name` (readonly), `first()`, `all()`, `count()`, `get(id)`,
  `where(predicate)`, `order(spec)`, `limit(n)`, `insert(doc)`,
  `update(id, patch)`, `replace(id, doc)`, `delete(id)`. Mutation
  verbs operate by primary key.
- `Query<T>`
  ([`packages/server/src/query.ts`](../../packages/server/src/query.ts)):
  `where(predicate)`, `order(spec)`, `limit(n)`, `first()`, `all()`,
  `count()`, `update(patch)`, `replace(doc)`, `delete()`. Mutation
  verbs are predicate-aware bulk; no HTTP mirror exists for bulk
  mutation, so `ClientQuery<T>` is read-only.
- `Db.transaction` callback context: a `Table<T>` whose mutation verbs
  buffer; reads pass through to live storage. No MVCC, no
  read-your-writes. The buffer commits atomically via one `commitBatch`
  call
  ([`packages/server/src/db.ts:464-560`](../../packages/server/src/db.ts)).

Allowed additive changes (no ADR required):

- New methods on `Db` / `Table` / `Query` that do not shadow existing
  names.
- New optional config fields on `Db.create` (e.g. `metrics`, `signal`).
- New `BaerlyErrorCode` values appended to the union in
  [`packages/protocol/src/errors.ts`](../../packages/protocol/src/errors.ts).

### Scope of "additive"

The lock is on *capabilities*, not *forms*. A second type-valid path
to an existing capability is not an "addition" — it is redundancy,
and redundant forms are a defect against criterion #4 of the
[product thesis](../about/thesis.md) (the *redundant ceremony*
failure mode). When a new canonical form lands for an existing
capability, the prior form is a candidate for removal in the same
amendment cycle. Pre-launch (no external users), the cost of
removal is zero; the 2026-05-21 amendment above is the precedent.

In practice this means: if a PR adds `Table<T>.method(x)` and the
same operation was previously expressible as
`Table<T>.where({...}).other()`, the PR should either (a) make the
ceremony path not type-check, or (b) amend this ADR with the
justification for keeping both.

Prohibited without a supersession ADR:

- Renaming any method.
- Changing the callback signature of `Db.transaction` (e.g. passing
  `Db` instead of `Table<T>`).
- Adding cross-table writes inside a transaction — this would break
  the no-2PC invariant (see the JSDoc on `Db.transaction` in
  [`packages/server/src/db.ts`](../../packages/server/src/db.ts) and
  [ADR-001](./001-tenant-cas-isolation.md)).
- Changing the behavioural contract of an existing method (e.g.
  making `update` upsert instead of no-op-on-missing).

The public surface is the load-bearing deliverable of the kernel
and the contract every downstream consumer codes against. Renames and
behavioural shifts have a long blast radius; additions are cheap. The
additive-only lock gives the runtime a forward-compatible evolution
path without making the public API a moving target.

## Consequences

- The conformance suite at
  [`tests/integration/conformance.test.ts`](../../tests/integration/conformance.test.ts)
  and the table-API integration test at
  [`tests/integration/table-api.test.ts`](../../tests/integration/table-api.test.ts)
  are the executable specification of this lock. Either suite breaking
  on a PR means the surface changed and the PR needs an ADR.
- TypeScript `.d.ts` files exported from `packages/server/dist/` are
  the canonical user-facing artifact. Bundle-size tests at
  [`tests/integration/bundle-size.test.ts`](../../tests/integration/bundle-size.test.ts)
  implicitly track surface drift via byte-count changes.
- `db.transaction`'s single-table scope is the load-bearing composition
  with the per-collection CAS scope
  ([ADR-001](./001-tenant-cas-isolation.md)). Reversing this lock
  would require either 2PC or per-tenant CAS; both were explicitly
  rejected.
- JSDoc on `Db.create`, `db.table`, and `db.transaction` is the source
  of truth for parameter semantics; this ADR pins the surface-level
  shape but the JSDoc owns the behavioural contract. Per
  [`docs/contributing/conventions/docs.md`](../contributing/conventions/docs.md), the public-API
  reference lives as JSDoc on the implementation, not as a
  hand-maintained markdown ref.
- `_raw` is intentionally undocumented in the README and excluded from
  the LLM-zero-shot claim. It exists for graduation paths (e.g.
  `baerly export`, see
  [`docs/spec/log-entry-shape.md`](../spec/log-entry-shape.md)) and is
  not part of the locked surface — `_raw`'s shape is allowed to change
  with a minor version bump because no public-API tutorial mentions it.
- TypeScript is the enforcement mechanism for the callback shape
  (`transaction(callback: (tx: Table<T>) => …)`); branded types (see
  the "Conventions" section of [`CLAUDE.md`](../../CLAUDE.md)) keep
  the verb signatures from being papered over with `as string`.
- The lock is reversible with cost. A future major version may revisit
  it; the supersession ADR records the new surface and consumers are
  notified via the semver major bump.
