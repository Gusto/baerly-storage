---
title: Features → code map
audience: coder
summary: Feature-by-feature pointers into source, tests, and docs.
last-reviewed: 2026-06-13
tags: [index, features, code-map]
related: [architecture.md, "../spec/README.md", "../adr/README.md"]
---

# Features → code map

A feature-oriented index for agents and humans landing in the repo who
know _what_ they want to change but not _where_ it lives. Each row is a
user-facing capability and the source files, tests, and docs that
implement or describe it.

For a code-oriented view (read-this-first lifecycle), see the module map
in [CLAUDE.md](../../CLAUDE.md) and [architecture.md](./architecture.md).

## Public API surface

The `Db` class is the entry point. `db.collection<T>(name)` returns a
typed `Collection<T>` carrying the locked SQL-shape API
(`first` / `all` / `count` / `insert` / `update` / `replace` /
`delete`) and the predicate AST (`where` / `order` / `limit`).
All public methods carry JSDoc with `@example` blocks — your IDE or
`tsgo` is the canonical reference. Change notifications are
delivered out-of-band by the HTTP
`/v1/since?collection=<name>&cursor=<opaque>` long-poll route.

- [`packages/server/src/db.ts`](../../packages/server/src/db.ts) — `Db` class
- [`packages/server/src/collection.ts`](../../packages/server/src/collection.ts) — `Collection<T>` verbs
- [`packages/server/src/query.ts`](../../packages/server/src/query.ts) — `Query<T>` predicate AST + reader

## Causal consistency

The hard invariant of the system. Writes from one client become visible
to others in an order consistent with happened-before.

- Implementation: [`packages/server/src/writer.ts`](../../packages/server/src/writer.ts),
  [`packages/server/src/query.ts`](../../packages/server/src/query.ts)
- Constants: [`packages/protocol/src/constants.ts`](../../packages/protocol/src/constants.ts)
  (`LAG_WINDOW_MILLIS` clock-skew tolerance)
- Tests:
  [`tests/unit/consistency.test.ts`](../../tests/unit/consistency.test.ts)
  (state-machine model),
  [`tests/integration/randomized.test.ts`](../../tests/integration/randomized.test.ts)
  (property-based, runs against Toxiproxy)
- Theory: [`docs/spec/sync-protocol.md`](../spec/sync-protocol.md),
  [`docs/spec/causal-consistency-checking.md`](../spec/causal-consistency-checking.md)

## JSON Merge Patch (RFC 7386)

How partial updates merge into existing documents.

- Implementation: [`packages/protocol/src/json.ts`](../../packages/protocol/src/json.ts)
- Tests: [`packages/protocol/src/json.test.ts`](../../packages/protocol/src/json.test.ts)
  (always green — pure unit test)
- Docs: [`docs/spec/json-merge-patch.md`](../spec/json-merge-patch.md)

## Vendorless S3 client

Direct HTTP to S3-compatible APIs via `aws4fetch`. We don't ship
`@aws-sdk/client-s3`. The implementation lives in the Node adapter as
one impl of the `Storage` interface; consumers can substitute their
own.

- Implementation: [`packages/adapter-node/src/s3-http.ts`](../../packages/adapter-node/src/s3-http.ts)
  (`S3HttpStorage`), [`packages/adapter-node/src/xml.ts`](../../packages/adapter-node/src/xml.ts)
  (XML parsing for ListObjectsV2)
- Tests: [`packages/adapter-node/src/s3-http.test.ts`](../../packages/adapter-node/src/s3-http.test.ts)
  (pure-unit, vi.fn-stubbed fetch),
  [`packages/adapter-node/src/xml.test.ts`](../../packages/adapter-node/src/xml.test.ts),
  [`tests/integration/conformance.test.ts`](../../tests/integration/conformance.test.ts)
  (multi-backend, needs credentials)
- Docs: [`docs/spec/storage-compatibility.md`](../spec/storage-compatibility.md),
  [`docs/spec/s3-xml-escaping-cases.md`](../spec/s3-xml-escaping-cases.md)

## Time / clock-skew tolerance

The protocol assumes loosely-synchronized clocks for log timestamps
that downstream consumers inspect. Kernel ordering is by monotonic
per-collection `seq`, not by wall-clock time; `LAG_WINDOW_MILLIS` is
the named tolerance/property-test bound, not a reader-side rejection
filter.

- Implementation: [`packages/protocol/src/time.ts`](../../packages/protocol/src/time.ts),
  [`packages/protocol/src/constants.ts`](../../packages/protocol/src/constants.ts)
- Tests: [`packages/protocol/src/time.test.ts`](../../packages/protocol/src/time.test.ts)

## Error model

Discriminated-union errors. Match on `error.code`, never `instanceof`.
Rationale lives in the JSDoc on `BaerlyError`.

- Implementation: [`packages/protocol/src/errors.ts`](../../packages/protocol/src/errors.ts)

## Branded types

Nominal typing on top of `string` to keep UUIDs and content version
IDs from being confused at protocol boundaries. See the
"Conventions" section of [`CLAUDE.md`](../../CLAUDE.md).

- Implementation: [`packages/protocol/src/types.ts`](../../packages/protocol/src/types.ts) (definitions and
  boundary helpers `uuid()`, `uuidv7()`)

## Hashing / content addressing

- Implementation: [`packages/protocol/src/hashing.ts`](../../packages/protocol/src/hashing.ts)
- Tests:
  [`packages/protocol/src/hashing.test.ts`](../../packages/protocol/src/hashing.test.ts)
  (always green)

## Secondary indexes

Indexes are declared on the collection config; the planner picks one
automatically from the query predicate. There is no manual-hint API
on `Query<T>` — declaring an `IndexDefinition` under
`BaerlyConfig.collections[*].indexes` is the only way to bias the
read path.

### Declaring an index

```ts
// baerly.config.ts
import { defineConfig } from "@gusto/baerly-storage/config";

export default defineConfig({
  collections: {
    tickets: {
      indexes: [
        { name: "by_status", on: "status" },
        { name: "by_status_priority", on: ["status", "priority"] },
        {
          name: "by_open_assignee",
          on: "assignee",
          predicate: { clauses: [{ op: "eq", field: "status", value: "open" }] },
        },
      ],
    },
  },
});
```

`CollectionDefinition` is defined in
[`packages/server/src/config.ts`](../../packages/server/src/config.ts);
the per-index shape lives at
[`packages/server/src/indexes.ts`](../../packages/server/src/indexes.ts)
as `IndexDefinition`.

### How the planner picks one

- Equality on the leftmost indexed field is the cheapest plan; the
  planner walks under the encoded equality prefix.
- Range (`gt`/`gte`/`lt`/`lte`) and `in` clauses are accepted
  on the **last** indexed field after any equality prefix. Range on
  a non-last field peels the equality and pushes the range clause
  into the post-fetch `matchesWire(...)` residue (`postFilter`).
- When multiple indexes match, the planner prefers (in order):
  filtered indexes whose `def.predicate` (a `PredicateWire`) is
  implied by the query wire; longest equality prefix; definition
  order. A filtered index whose predicate is _not_ implied is ranked
  last and used only as a last resort when it is the only candidate —
  see the soundness caveat below.
- Otherwise `planQuery` emits `FullScanPlan` and the read walks the
  snapshot+log fold. Diagnostic `reason` values:
  `"no-predicate"`, `"no-indexes-declared"`,
  `"no-matching-index"`, `"predicate-uses-operators-only"`.

An index is correct only when its marker set is complete for the
declared definition. Stale extra markers are harmless: the reader
materializes each candidate row and re-checks `matchesWire(...)`, so
extra markers cost I/O but cannot invent rows. Missing markers can hide
rows from an index-routed query. After adding an index to an existing
collection, run `rebuildIndex` / `baerly admin rebuild-index` before
treating the index as authoritative.

Marker completeness is necessary but not sufficient for a _filtered_
(partial) index. The route is sound only when the index's filter
predicate is implied by the query predicate; otherwise the LIST never
yields rows that fall outside the filter, and the post-fetch
`matchesWire(...)` re-check cannot resurrect rows the LIST never
returned. The planner ranks a non-implied filtered index last but, as a
known limitation, will still route through it as a last resort when it
is the only candidate — which is unsound for that query (it can silently
drop matching rows). The fallback and its caveat are documented in the
`rank()` comment in
[`packages/server/src/query-planner.ts`](../../packages/server/src/query-planner.ts).

#### Numeric range and `in` walks

`encodeIndexValue` is value-order-preserving across types: numbers
are encoded as sortable IEEE 754, strings as raw UTF-8, and a
leading type tag keeps `"5"` and `5` in disjoint slots. Range walks
and `in` walks over numeric fields route normally — no full-scan
fallback. The only routing-side guard that remains for `in` is
`IN_FANOUT_THRESHOLD` (50): an `in` whose value list exceeds that
threshold falls back to full-scan because N sequential LISTs cost
more than one snapshot+log fold. String range walks remain safe
under UTF-8 byte order (ISO 8601 timestamps, `"p1"/"p2"/"p3"`
priorities, zero-padded numerics in string form, etc.).

### Pointers

- Implementation:
  [`packages/server/src/query-planner.ts`](../../packages/server/src/query-planner.ts)
  (`planQuery`, `IndexWalkPlan`, `FullScanPlan`),
  [`packages/server/src/indexes.ts`](../../packages/server/src/indexes.ts)
  (`IndexDefinition`, key encoding, filter-aware projector),
  [`packages/server/src/query.ts`](../../packages/server/src/query.ts)
  (`runIndexWalkPlan` at the I/O boundary),
  [`packages/server/src/rebuild-index.ts`](../../packages/server/src/rebuild-index.ts)
  (filter-aware reconciliation),
  [`packages/protocol/src/query/wire.ts`](../../packages/protocol/src/query/wire.ts)
  (`PredicateWire`, `PredicateClause`, `PredicateOpName`),
  [`packages/protocol/src/query/builder.ts`](../../packages/protocol/src/query/builder.ts)
  (`PredicateBuilder<T>`),
  [`packages/server/src/query-planner-implies.ts`](../../packages/server/src/query-planner-implies.ts)
  (`predicateImplies`).
- Tests:
  [`packages/server/src/query-planner.test.ts`](../../packages/server/src/query-planner.test.ts),
  [`packages/server/src/query.test.ts`](../../packages/server/src/query.test.ts)
  (the `describe("auto-planner index routing")` block),
  [`tests/integration/collection-api.test.ts`](../../tests/integration/collection-api.test.ts),
  [`tests/integration/randomized.test.ts`](../../tests/integration/randomized.test.ts).
- Docs: this section, [`docs/contributing/architecture.md`](./architecture.md)
  §"Lifecycle of `db.collection(...).insert()`",
  [`docs/contributing/extending.md`](./extending.md)
  §1c "Declare an index on a collection".

## SQL export (`baerly export --target=postgres|sqlite|d1`)

One-shot snapshot dump of a baerly-storage collection into a SQL-native
database. Per-column types are inferred from the materialised L9
snapshot (string / number / boolean / nested-object → SQL type per
target dialect); `_id` is always emitted as the primary key.
Implementation lives under `packages/cli/src/export/` as private CLI
modules — exposed only through the `baerly` CLI surface, not as a
publishable package.

- Implementation:
  [`packages/cli/src/export/plan.ts`](../../packages/cli/src/export/plan.ts)
  (`inferPlanForCollection`, `loadMaterialisedView`),
  [`packages/cli/src/export/ddl.ts`](../../packages/cli/src/export/ddl.ts)
  (`emitCreateTable`),
  [`packages/cli/src/export/rows.ts`](../../packages/cli/src/export/rows.ts)
  (`emitInsertStatements`),
  [`packages/cli/src/export/sql-escape.ts`](../../packages/cli/src/export/sql-escape.ts)
  (`quoteIdentifier`, `quoteValue`)
- Tests:
  [`packages/cli/src/export/plan.test.ts`](../../packages/cli/src/export/plan.test.ts),
  [`packages/cli/src/export/ddl.test.ts`](../../packages/cli/src/export/ddl.test.ts),
  [`packages/cli/src/export/rows.test.ts`](../../packages/cli/src/export/rows.test.ts),
  [`packages/cli/src/export/sql-escape.test.ts`](../../packages/cli/src/export/sql-escape.test.ts)

## Export round-trip (`pnpm test:export-round-trip`)

Phase 9 gate; ensures byte-equal preservation across `export →
SQLite → restore`. Seeds a `LocalFsStorage`-backed baerly-storage bucket,
runs the `packages/cli/src/export/` pipeline against the `sqlite3` CLI binary
(auto-skips when absent), re-imports the SQL dump through `baerly
admin restore`, and asserts byte-equal `baerly admin dump` between
the source and restored buckets. Uses
[`serializeExportPlan` / `deserializeExportPlan`](../../packages/cli/src/export/plan-sidecar.ts)
to coerce SQLite values back to their original JS types.

- Tests:
  [`tests/integration/export-round-trip.test.ts`](../../tests/integration/export-round-trip.test.ts),
  [`packages/cli/src/export/plan-sidecar.test.ts`](../../packages/cli/src/export/plan-sidecar.test.ts)

## Observability

Canonical one-line-per-unit-of-work log plus a pluggable
`MetricsRecorder` (counter / gauge / histogram). The canonical line's
`class_a_ops_total` is asserted equal to the physical bucket op count
by the cost-model gate test — the line is a faithful source of truth
for per-request S3 spend.

- Implementation:
  [`packages/server/src/observability/`](../../packages/server/src/observability/)
- Tests:
  [`tests/integration/observability.test.ts`](../../tests/integration/observability.test.ts)
- Docs: [`docs/guide/observability.md`](../guide/observability.md),
  [`docs/contributing/conventions/observability.md`](./conventions/observability.md)
  (includes metric-name conventions, rejected alternatives, and
  prohibited patterns)

## Optional collection schemas (`CollectionDefinition.schema`)

Apps may attach a StandardSchemaV1-compatible validator (Zod 3.24+,
Valibot 0.36+, ArkType 2.0+, or any future library implementing the
spec) to each collection in `baerly.config.ts`. The server runs the
validator on every `insert` / `update` / `replace` post-image and
throws `BaerlyError{code:"SchemaError"}` carrying a structured
`issues: [{path, message}]` array on failure. No schema declared =
zero overhead.

- Implementation:
  [`packages/server/src/schema.ts`](../../packages/server/src/schema.ts)
  (`SchemaValidator`, `SchemaIssue`, `validateOrThrow`),
  [`packages/server/src/config.ts`](../../packages/server/src/config.ts)
  (`CollectionDefinition.schema`),
  [`packages/server/src/query.ts`](../../packages/server/src/query.ts)
  (validation hooks in `runInsert` / `runUpdate` / `runReplaceById`)
- Tests:
  [`packages/server/src/schema.test.ts`](../../packages/server/src/schema.test.ts),
  [`tests/integration/collection-api.test.ts`](../../tests/integration/collection-api.test.ts)
  (schema-validation block in the cascade)
- Docs: [`docs/extending.md`](./extending.md) §"Declare a schema for a collection"

## Operator CLI — `baerly inspect`

Reads `current.json` + snapshot + live log tail and prints a
read-only summary of one collection (tail_hint, log_seq_start,
writer_fence, materialised row count, per-index key counts).

Bolt-on (adding baerly-storage to an existing Cloudflare Worker project) lives
in `@gusto/create-baerly-storage`: `pnpm create @gusto/baerly-storage@latest .` detects `wrangler.jsonc` and
dispatches to the bolt-on flow. See
[`docs/guide/add-to-existing-cf-worker.md`](../guide/add-to-existing-cf-worker.md).

- Implementation:
  [`packages/cli/src/inspect.ts`](../../packages/cli/src/inspect.ts)
- Tests:
  [`packages/cli/src/inspect.test.ts`](../../packages/cli/src/inspect.test.ts)

## Operator CLI — `baerly admin dump` / `baerly admin restore`

Canonical NDJSON serialisation of one collection's materialised
view (`dump`) and its inverse (`restore`). `dump` emits
`{"_id":"...",...}` per line with recursively sorted keys, ASCII-
lex row order, and no BOM — a byte-stable format the export
round-trip test (`pnpm test:export-round-trip`) gates against.
`restore` streams NDJSON from stdin and commits one `op:"I"` per
row through `Writer`; refuses an existing `current.json`
unless `--force` truncates first.

- Implementation:
  [`packages/cli/src/admin/dump.ts`](../../packages/cli/src/admin/dump.ts),
  [`packages/cli/src/admin/restore.ts`](../../packages/cli/src/admin/restore.ts)
- Tests:
  [`packages/cli/src/admin/dump.test.ts`](../../packages/cli/src/admin/dump.test.ts),
  [`packages/cli/src/admin/restore.test.ts`](../../packages/cli/src/admin/restore.test.ts)

## Operator CLI — `baerly admin fsck`

Read-only consistency walk for one collection. Verifies
`current.json` parses, the snapshot body's content hash matches
its filename hash, the trusted log range `[log_seq_start, tail_hint)`
has no holes, and (with `--rebuild-indexes` + `--config=`) reports
orphan index keys without rebuilding. Exit 4 on any finding —
distinguished from exit 2 ("command itself failed") so CI can
wire `fsck` as a regression gate.

- Implementation:
  [`packages/cli/src/admin/fsck.ts`](../../packages/cli/src/admin/fsck.ts)
- Tests:
  [`packages/cli/src/admin/fsck.test.ts`](../../packages/cli/src/admin/fsck.test.ts)
