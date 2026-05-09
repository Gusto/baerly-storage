# Features → code map

A feature-oriented index for agents and humans landing in the repo who
know *what* they want to change but not *where* it lives. Each row is a
user-facing capability and the source files, tests, and docs that
implement or describe it.

For a code-oriented view (read-this-first lifecycle), see the module map
in [CLAUDE.md](../CLAUDE.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

## Public API surface

The `MPS3` class is the only intended entry point. Its public methods
(`get`, `put`, `delete`, `subscribe`) and the `MPS3Config` interface
carry full JSDoc with `@example` blocks — your IDE or `tsgo` is the
canonical reference.

- [`src/mps3.ts`](../src/mps3.ts) — class + config

## Causal consistency

The hard invariant of the system. Writes from one client become visible
to others in an order consistent with happened-before.

- Implementation: [`src/syncer.ts`](../src/syncer.ts),
  [`src/manifest.ts`](../src/manifest.ts)
- Constants: [`src/constants.ts`](../src/constants.ts)
  (`LAG_WINDOW_MILLIS` clock-skew tolerance)
- Tests:
  [`src/__tests__/consistency.test.ts`](../src/__tests__/consistency.test.ts)
  (state-machine model),
  [`src/__tests__/randomized.test.ts`](../src/__tests__/randomized.test.ts)
  (property-based, runs against Toxiproxy)
- Theory: [`docs/sync_protocol.md`](./sync_protocol.md),
  [`docs/causal_consistency_checking.md`](./causal_consistency_checking.md)

## Offline-first writes

Local writes survive a tab close / network drop and replay on reconnect.

- Implementation:
  [`src/operationQueue.ts`](../src/operationQueue.ts) (in-memory + IDB
  buffer), [`src/indexdb.ts`](../src/indexdb.ts) (IDB wrapper)
- Tests:
  [`src/__tests__/offlinefirst.test.ts`](../src/__tests__/offlinefirst.test.ts),
  [`src/__tests__/operationQueue.test.ts`](../src/__tests__/operationQueue.test.ts)
  (note: stale-API mismatch — see
  [troubleshooting.md](./troubleshooting.md))

## JSON Merge Patch (RFC 7386)

How partial updates merge into existing documents.

- Implementation: [`src/json.ts`](../src/json.ts)
- Tests: [`src/__tests__/json.test.ts`](../src/__tests__/json.test.ts)
  (always green — pure unit test)
- Docs: [`docs/JSON_merge_patch.md`](./JSON_merge_patch.md)

## Vendorless S3 client

Direct HTTP to S3-compatible APIs via `aws4fetch`. We don't ship
`@aws-sdk/client-s3`.

- Implementation: [`src/S3ClientLite.ts`](../src/S3ClientLite.ts),
  [`src/xml.ts`](../src/xml.ts) (XML parsing for ListObjectsV2),
  [`src/s3-types.ts`](../src/s3-types.ts) (minimal wire-protocol types)
- Tests: [`src/__tests__/xml.test.ts`](../src/__tests__/xml.test.ts),
  [`src/__tests__/conformance.test.ts`](../src/__tests__/conformance.test.ts)
  (multi-backend, needs credentials)
- Docs: [`docs/s3_features_used.md`](./s3_features_used.md),
  [`docs/S3 XML Escaping Cases.md`](./S3%20XML%20Escaping%20Cases.md)
- ADR: [`docs/adr/0001-no-aws-sdk.md`](./adr/0001-no-aws-sdk.md)

## Time / clock-skew tolerance

The protocol assumes loosely-synchronized clocks. Manifest entries
outside `LAG_WINDOW_MILLIS` are rejected.

- Implementation: [`src/time.ts`](../src/time.ts),
  [`src/constants.ts`](../src/constants.ts)
- Tests: [`src/__tests__/time.test.ts`](../src/__tests__/time.test.ts)
  (needs Minio)

## Error model

Discriminated-union errors. Match on `error.code`, never `instanceof`.

- Implementation: [`src/errors.ts`](../src/errors.ts)
- Conventions: [`.claude/rules/src.md`](../.claude/rules/src.md)
- ADR:
  [`docs/adr/0003-error-code-discriminant.md`](./adr/0003-error-code-discriminant.md)

## Branded types

Nominal typing on top of `string` to keep manifest keys, UUIDs, and S3
version IDs from being confused at protocol boundaries.

- Implementation: [`src/types.ts`](../src/types.ts) (definitions and
  boundary helpers `uuid()`, `versionFromUuid()`)
- ADR:
  [`docs/adr/0002-branded-types.md`](./adr/0002-branded-types.md)

## Hashing / content addressing

- Implementation: [`src/hashing.ts`](../src/hashing.ts)
- Tests:
  [`src/__tests__/hashing.test.ts`](../src/__tests__/hashing.test.ts)
  (always green)
