---
title: API surface lock
audience: adr
summary: ADR 0019 — API surface lock.
last-reviewed: 2026-05-12
tags: [decision, adr]
related: [README.md]
---

# 0019 — API surface lock

## Status

Accepted (2026-05-11).

## Context

The SQL-shape table API lives in
[`packages/server/src/db.ts`](../../packages/server/src/db.ts),
[`packages/server/src/table.ts`](../../packages/server/src/table.ts),
and
[`packages/server/src/query.ts`](../../packages/server/src/query.ts).
The barrel at
[`packages/server/src/index.ts`](../../packages/server/src/index.ts)
exports these classes plus `ServerWriter`, the maintenance budget
machinery, and the GC / compactor entry points. The CLAUDE.md
positioning is that "the protocol kernel is small enough that an LLM
can use the public API zero-shot from the `.d.ts` files alone"; once
that surface is exposed, every breaking change is a downstream churn
event with a long blast radius.

Two factual anchors describe what is in the lock today:

1. `Db` exposes exactly four methods: `Db.create`, `db.table`,
   `db.transaction`, and the `db._raw` escape hatch
   ([`packages/server/src/db.ts:120-287`](../../packages/server/src/db.ts)).
2. `Table<T>` exposes seven verbs (`first`, `all`, `count`, `insert`,
   `update`, `replace`, `delete`) plus `where()` returning a `Query`.
   The transaction callback receives a `Table<T>`, not a `Db`, so
   cross-table writes inside `transaction()` are a TypeScript compile
   error
   ([`packages/server/src/db.ts:235-287`](../../packages/server/src/db.ts)).

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
  `first(predicate?)`, `all(predicate?)`, `count(predicate?)`,
  `where(predicate)`, `insert(body)`, `update(predicate, patch)`,
  `replace(predicate, body)`, `delete(predicate)`.
- `Query<T>`
  ([`packages/server/src/query.ts`](../../packages/server/src/query.ts)):
  `first()`, `all()`, `count()`, `update(patch)`, `replace(body)`,
  `delete()`.
- `Db.transaction` callback context: a `Table<T>` whose mutation verbs
  buffer; reads pass through to live storage. No MVCC, no
  read-your-writes. The buffer commits atomically via one `commitBatch`
  call
  ([`packages/server/src/db.ts:265-287`](../../packages/server/src/db.ts)).

Allowed additive changes (no ADR required):

- New methods on `Db` / `Table` / `Query` that do not shadow existing
  names.
- New optional config fields on `Db.create` (e.g. `metrics`, `signal`).
- New `BaerlyErrorCode` values appended to the union in
  [`packages/protocol/src/errors.ts`](../../packages/protocol/src/errors.ts).

Prohibited without a supersession ADR:

- Renaming any method.
- Changing the callback signature of `Db.transaction` (e.g. passing
  `Db` instead of `Table<T>`).
- Adding cross-table writes inside a transaction — this would break
  the no-2PC invariant (see the JSDoc on `Db.transaction` in
  [`packages/server/src/db.ts`](../../packages/server/src/db.ts) and
  [ADR-0018](./001-tenant-cas-isolation.md)).
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
  ([ADR-0018](./001-tenant-cas-isolation.md)). Reversing this lock
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
