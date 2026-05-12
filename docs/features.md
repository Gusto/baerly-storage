# Features → code map

A feature-oriented index for agents and humans landing in the repo who
know *what* they want to change but not *where* it lives. Each row is a
user-facing capability and the source files, tests, and docs that
implement or describe it.

For a code-oriented view (read-this-first lifecycle), see the module map
in [CLAUDE.md](../CLAUDE.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

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
- Theory: [`docs/sync_protocol.md`](./sync_protocol.md),
  [`docs/causal_consistency_checking.md`](./causal_consistency_checking.md)

## JSON Merge Patch (RFC 7386)

How partial updates merge into existing documents.

- Implementation: [`packages/protocol/src/json.ts`](../packages/protocol/src/json.ts)
- Tests: [`packages/protocol/src/json.test.ts`](../packages/protocol/src/json.test.ts)
  (always green — pure unit test)
- Docs: [`docs/JSON_merge_patch.md`](./JSON_merge_patch.md)

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
- Docs: [`docs/s3_features_used.md`](./s3_features_used.md),
  [`docs/s3-xml-escaping-cases.md`](./s3-xml-escaping-cases.md)
- ADR: [`docs/adr/0001-no-aws-sdk.md`](./adr/0001-no-aws-sdk.md)

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
