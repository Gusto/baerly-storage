---
title: Features → code map
audience: coder
summary: Feature-by-feature pointers into source, tests, and docs.
last-reviewed: 2026-05-12
tags: [index, features, code-map]
related: [architecture.md, "spec/README.md", "adr/README.md"]
---

# Features → code map

A feature-oriented index for agents and humans landing in the repo who
know *what* they want to change but not *where* it lives. Each row is a
user-facing capability and the source files, tests, and docs that
implement or describe it.

For a code-oriented view (read-this-first lifecycle), see the module map
in [CLAUDE.md](../CLAUDE.md) and [architecture.md](./architecture.md).

## Public API surface

The `Db` class is the entry point. `db.table<T>(name)` returns a
typed `Table<T>` carrying the locked SQL-shape API
(`first` / `all` / `count` / `insert` / `update` / `replace` /
`delete`) and the predicate AST (`where` / `order` / `limit`).
All public methods carry JSDoc with `@example` blocks — your IDE or
`tsgo` is the canonical reference. Change notifications are
delivered out-of-band by the HTTP `/v1/since` long-poll route.

- [`packages/server/src/db.ts`](../packages/server/src/db.ts) — `Db` class
- [`packages/server/src/table.ts`](../packages/server/src/table.ts) — `Table<T>` verbs
- [`packages/server/src/query.ts`](../packages/server/src/query.ts) — `Query<T>` predicate AST + reader

## Causal consistency

The hard invariant of the system. Writes from one client become visible
to others in an order consistent with happened-before.

- Implementation: [`packages/server/src/server-writer.ts`](../packages/server/src/server-writer.ts),
  [`packages/server/src/query.ts`](../packages/server/src/query.ts)
- Constants: [`packages/protocol/src/constants.ts`](../packages/protocol/src/constants.ts)
  (`LAG_WINDOW_MILLIS` clock-skew tolerance)
- Tests:
  [`tests/unit/consistency.test.ts`](../tests/unit/consistency.test.ts)
  (state-machine model),
  [`tests/integration/randomized.test.ts`](../tests/integration/randomized.test.ts)
  (property-based, runs against Toxiproxy)
- Theory: [`docs/spec/sync-protocol.md`](./spec/sync-protocol.md),
  [`docs/spec/causal-consistency-checking.md`](./spec/causal-consistency-checking.md)

## JSON Merge Patch (RFC 7386)

How partial updates merge into existing documents.

- Implementation: [`packages/protocol/src/json.ts`](../packages/protocol/src/json.ts)
- Tests: [`packages/protocol/src/json.test.ts`](../packages/protocol/src/json.test.ts)
  (always green — pure unit test)
- Docs: [`docs/spec/json-merge-patch.md`](./spec/json-merge-patch.md)

## Vendorless S3 client

Direct HTTP to S3-compatible APIs via `aws4fetch`. We don't ship
`@aws-sdk/client-s3`. Lives inside `@baerly/protocol` as one impl of
the `Storage` interface; consumers can substitute their own.

- Implementation: [`packages/protocol/src/storage/s3-http.ts`](../packages/protocol/src/storage/s3-http.ts)
  (`S3HttpStorage`), [`packages/protocol/src/xml.ts`](../packages/protocol/src/xml.ts)
  (XML parsing for ListObjectsV2)
- Tests: [`packages/protocol/src/storage/s3-http.test.ts`](../packages/protocol/src/storage/s3-http.test.ts)
  (pure-unit, vi.fn-stubbed fetch),
  [`packages/protocol/src/xml.test.ts`](../packages/protocol/src/xml.test.ts),
  [`tests/integration/conformance.test.ts`](../tests/integration/conformance.test.ts)
  (multi-backend, needs credentials)
- Docs: [`docs/spec/s3-features-used.md`](./spec/s3-features-used.md),
  [`docs/spec/s3-xml-escaping-cases.md`](./spec/s3-xml-escaping-cases.md)

## Time / clock-skew tolerance

The protocol assumes loosely-synchronized clocks. Manifest entries
outside `LAG_WINDOW_MILLIS` are rejected.

- Implementation: [`packages/protocol/src/time.ts`](../packages/protocol/src/time.ts),
  [`packages/protocol/src/constants.ts`](../packages/protocol/src/constants.ts)
- Tests: [`tests/integration/time.test.ts`](../tests/integration/time.test.ts)
  (needs Minio)

## Error model

Discriminated-union errors. Match on `error.code`, never `instanceof`.

- Implementation: [`packages/protocol/src/errors.ts`](../packages/protocol/src/errors.ts)
- ADR:
  [`docs/adr/0003-error-code-discriminant.md`](./adr/0003-error-code-discriminant.md)

## Branded types

Nominal typing on top of `string` to keep manifest keys, UUIDs, and S3
version IDs from being confused at protocol boundaries.

- Implementation: [`packages/protocol/src/types.ts`](../packages/protocol/src/types.ts) (definitions and
  boundary helpers `uuid()`, `versionFromUuid()`)
- ADR:
  [`docs/adr/0002-branded-types.md`](./adr/0002-branded-types.md)

## Hashing / content addressing

- Implementation: [`packages/protocol/src/hashing.ts`](../packages/protocol/src/hashing.ts)
- Tests:
  [`packages/protocol/src/hashing.test.ts`](../packages/protocol/src/hashing.test.ts)
  (always green)

## Secondary indexes

Query-driven, projection-scoped indexes on user-defined key
expressions with lex-order-preserving base-32 encoding. Writers
emit/retract index entries at fence time; `rebuildIndex` reconciles
idempotently from a `current.json` snapshot.

- Implementation:
  [`packages/server/src/indexes.ts`](../packages/server/src/indexes.ts)
  (`IndexDefinition`, key encoding, per-doc projection),
  [`packages/server/src/rebuild-index.ts`](../packages/server/src/rebuild-index.ts)
- Tests:
  [`tests/integration/table-api.test.ts`](../tests/integration/table-api.test.ts)
  (all four adapter variants)

## SQL export (`baerly export --target=postgres|sqlite|d1`)

One-shot snapshot dump of a Baerly collection into a SQL-native
database. Per-column types are inferred from the materialised L9
snapshot (string / number / boolean / nested-object → SQL type per
target dialect); `_id` is always emitted as the primary key.
Library lives in `@baerly/export`; the CLI wiring lands separately.

- Implementation:
  [`packages/export/src/plan.ts`](../packages/export/src/plan.ts)
  (`inferPlanForCollection`, `loadMaterialisedView`),
  [`packages/export/src/ddl.ts`](../packages/export/src/ddl.ts)
  (`emitCreateTable`),
  [`packages/export/src/rows.ts`](../packages/export/src/rows.ts)
  (`emitInsertStatements`),
  [`packages/export/src/sql-escape.ts`](../packages/export/src/sql-escape.ts)
  (`quoteIdentifier`, `quoteValue`)
- Tests:
  [`packages/export/src/plan.test.ts`](../packages/export/src/plan.test.ts),
  [`packages/export/src/ddl.test.ts`](../packages/export/src/ddl.test.ts),
  [`packages/export/src/rows.test.ts`](../packages/export/src/rows.test.ts),
  [`packages/export/src/sql-escape.test.ts`](../packages/export/src/sql-escape.test.ts)

## Observability

Canonical one-line-per-unit-of-work log plus a pluggable
`MetricsRecorder` (counter / gauge / histogram). The canonical line's
`class_a_ops_total` is asserted equal to the physical bucket op count
by the cost-model gate test — the line is a faithful source of truth
for per-request S3 spend.

- Implementation:
  [`packages/server/src/observability/`](../packages/server/src/observability/)
- Tests:
  [`tests/integration/observability.test.ts`](../tests/integration/observability.test.ts)
- Docs: [`docs/observability.md`](./observability.md),
  [`docs/conventions/observability.md`](./conventions/observability.md)
- ADR:
  [`docs/adr/0022-observability-tag-naming.md`](./adr/0022-observability-tag-naming.md)
