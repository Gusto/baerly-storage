# 0012 — Transaction scope is single-table

## Status

Accepted.

## Context

[ADR-0011](./0011-cas-scope.md) commits the protocol to a
per-collection CAS scope: each table has its own `current.json`, and
there is no cross-collection mutex. That choice forces the
transaction-scope question.

The two options are:

- **Cross-table transactions via two-phase commit.** The transaction
  body buffers writes across multiple tables, then commits by
  coordinating CAS against every involved `current.json`. 2PC over
  S3-compatible storage is expensive — multiple round-trips per
  commit, no native fencing primitive, no rollback API to undo a
  successful PUT — and the failure modes it introduces (in-doubt
  transactions, partial visibility, recovery state) contradict the
  cost-ceiling envelope ([ADR-0015](./0015-cost-ceiling.md)).
- **Single-table transactions.** The transaction body is bound to one
  table at compile time, mutations buffer onto a per-transaction
  context, and `commit()` fires exactly one CAS against that table's
  `current.json`. Cross-table atomicity is surfaced as an explicit
  non-goal.

The use cases 2PC would unlock — typically "move a record from one
table to another atomically" — are rare in document workloads and
re-expressible at the application layer (idempotent move keyed off
the source-row state, or a single denormalized table with a `status`
column).

## Decision

Transactions are **single-table**. `db.transaction(table, body)`
takes a table reference and hands the callback a `Table<T>` bound to
that one table; mutations buffer onto a `TxContext`
([`packages/server/src/db.ts:19-55`](../../packages/server/src/db.ts))
and commit atomically via one `commitBatch` call
([`packages/server/src/db.ts:235-287`](../../packages/server/src/db.ts);
return shape at
[`packages/server/src/server-writer.ts:142-155`](../../packages/server/src/server-writer.ts)).
Cross-table writes inside a transaction are a TypeScript error: the
callback signature does not expose a way to reach another table's
mutators. The JSDoc at
[`packages/server/src/db.ts:203-234`](../../packages/server/src/db.ts)
spells this out and pins it as the compile-time guarantee.

## Consequences

- One CAS per transaction. Cost-model arithmetic stays predictable:
  three storage operations per logical write irrespective of how
  many mutations the transaction body buffers internally.
- Cross-table atomicity is explicitly out of scope. Applications
  that need it use the raw log via `db._raw` or graduate to Postgres
  (see [ADR-0013](./0013-export-contract.md)).
- Read-your-writes is not supported inside the transaction body —
  reads go through `Storage` live, not against the buffered
  mutations. The behaviour is documented on the public surface and
  asserted in the table-API integration tests.
- Empty transaction bodies are free. A transaction that buffers no
  mutations writes nothing and does not advance `current.json`.
- CAS loss surfaces as `BaerlyError{code:"Conflict"}` exactly once per
  failed commit. Retry policy is the caller's responsibility — the
  protocol does not silently re-run the transaction body.
- Adding cross-table transactions later is a strictly additive
  protocol change (a second mutator that commits N CAS operations as
  a coordinated batch). The single-table mutator does not need to
  change shape to make that possible.
