# Features → code map

A feature-oriented index for agents and humans landing in the repo who
know *what* they want to change but not *where* it lives. Each row is a
user-facing capability and the source files, tests, and docs that
implement or describe it.

For a code-oriented view (read-this-first lifecycle), see the module map
in [CLAUDE.md](../CLAUDE.md) and [ARCHITECTURE.md](./ARCHITECTURE.md).

## Public API surface

The `MPS3` class is the only intended entry point. Its public methods
(`get`, `put`, `delete`) and the `MPS3Config` interface carry full
JSDoc with `@example` blocks — your IDE or `tsgo` is the canonical
reference. Realtime change notifications are deferred to a Phase 10
opt-in `NotificationBus` package; today callers drive their own
polling by re-calling `get(key)`.

- [`src/mps3.ts`](../src/mps3.ts) — class + config

## Causal consistency

The hard invariant of the system. Writes from one client become visible
to others in an order consistent with happened-before.

- Implementation: [`src/syncer.ts`](../src/syncer.ts),
  [`src/manifest.ts`](../src/manifest.ts)
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
`@aws-sdk/client-s3`.

- Implementation: [`src/s3-client-lite.ts`](../src/s3-client-lite.ts),
  [`packages/protocol/src/xml.ts`](../packages/protocol/src/xml.ts)
  (XML parsing for ListObjectsV2),
  [`src/s3-types.ts`](../src/s3-types.ts) (minimal wire-protocol types)
- Tests: [`packages/protocol/src/xml.test.ts`](../packages/protocol/src/xml.test.ts),
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
- Conventions: [`docs/conventions/src.md`](./conventions/src.md)
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
