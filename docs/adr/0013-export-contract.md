# 0013 — Export contract is Postgres-logical-replication-shaped

## Status

Accepted.

## Context

Part of Baerly's pitch to non-engineers is "your data graduates to
Postgres mechanically." That promise is only credible if every
mutation the protocol writes produces a log record whose shape a
Debezium-style consumer can translate into SQL without bespoke
adapter code.

The three alternatives considered were:

- **Ad-hoc JSON tailored to MPS3's internals.** Cheap to design but
  traps the export tooling inside Baerly: anyone wanting to read the
  log has to learn an MPS3-specific schema with no analog in the
  ecosystem.
- **`pgoutput` shape verbatim.** The Postgres logical-replication
  wire format is the obvious reference. Adopting it byte-for-byte
  would require BEGIN/COMMIT framing, LSN byte structure, TYPE
  messages, streaming-in-progress variants, two-phase commit framing
  — overkill for a document store with no statement-level decoding.
- **Shape borrowed from `pgoutput`, machinery dropped.** Keep the
  message vocabulary (`I`/`U`/`D` for insert/update/delete, with
  relation, key, before/after) and the per-entry opaque `lsn`
  cursor. Drop the framing and protocol machinery that doesn't apply
  to an append-only object-store log.

## Decision

Every successful mutation produces one Postgres-logical-replication-
shaped `LogEntry` JSON object. The shape is frozen at Phase 1 and
documented as such on the `LogEntry` interface at
[`packages/protocol/src/log.ts:1-80`](../../packages/protocol/src/log.ts)
("Shape is fixed at this point and never changes after"). A
hand-rolled translator that converts the log into Postgres SQL
mechanically lives in
[`tests/integration/export-smoke.test.ts:68-137`](../../tests/integration/export-smoke.test.ts):
`I` becomes `INSERT … ON CONFLICT DO UPDATE`, `U` becomes a read-
modify-write via JS-side merge, `D` becomes `DELETE`. The smoke test
keeps its own local copy of the `LogEntry` interface at lines 31–51
deliberately separate from the protocol package so any drift in the
contract shows up as a TypeScript compile error in the test.

## Consequences

- The export tool is a few hundred lines, not a feature team. CDC
  consumers can read the log directly and acknowledge progress on
  the opaque `lsn` string carried by each entry.
- The `LogEntry` JSON keys are public API. Renaming or removing any
  field is a major-version migration; adding a new optional field
  alongside existing ones is non-breaking. Forward-only schema
  evolution rides on the `schema_version` stamp documented in
  [ADR-0016](./0016-schema-migration.md).
- The exporter explicitly does not implement BEGIN/COMMIT framing,
  statement-level decoding, savepoints, TYPE messages, the binary
  frame format, or streaming for in-progress transactions. Anything
  that needs those reaches for Postgres directly rather than
  layering them on top of the log.
- The reference fixtures at
  [`tests/integration/export-smoke.test.ts:139-200`](../../tests/integration/export-smoke.test.ts)
  pin insert / update / delete / null-deletes-nested-field shapes,
  demonstrating idempotent replay against a real Postgres instance.
- The smoke test runs under `pnpm test:export-smoke` and is gated on
  a local Postgres on `127.0.0.1:5433` provisioned by
  `pnpm dev:storage`; CI invokes it explicitly because the default
  test glob excludes it.
- Snapshots ([ADR-0017](./0017-snapshot-levels.md)) are built by
  folding the same `LogEntry` stream forward, so the export tool and
  the compactor share a single source of truth for the log shape.
