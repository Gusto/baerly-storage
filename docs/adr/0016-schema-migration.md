# 0016 — Forward-only schema migration via `schema_version`

## Status

Accepted.

## Context

Document databases need to evolve their document shapes. The naive
approach — rewrite documents in place when the schema changes —
defeats the export contract ([ADR-0013](./0013-export-contract.md)):
past log entries no longer reflect what the writer actually wrote,
and a Debezium-style consumer that replays the log produces a state
that disagrees with the one the application sees.

The right shape is a monotonic version stamp on every log entry so a
consumer can match the document body to the schema it was written
against. Two alternatives considered:

- **Inline schema in every entry.** Carries the full schema
  definition alongside the document body. Huge bloat for a field
  that changes rarely, and forces the protocol to define a
  schema-description language.
- **Out-of-band schema announcements.** A monotonic version field on
  each entry indexes into a separate stream of `M` (MESSAGE) opcode
  entries that announce schemas. The bulk of the log carries only
  the integer; the announcement opcode already exists on
  `LogEntry`.

## Decision

Every `LogEntry` carries an integer `schema_version` field. Readers
match each entry to the schema in effect at write time, and the
field advances forward only — renaming or removing it is a
major-version migration.

The field is defined at
[`packages/protocol/src/log.ts:55-63`](../../packages/protocol/src/log.ts)
with JSDoc spelling out the semantics: "Monotonic per collection.
Schema for the doc body is announced out-of-band; this field lets
the consumer match a log entry to the schema in effect at write
time. Always `0` until Phase 4 lands the table API." The writer
emits `schema_version: 0` on every log entry today (see
[`packages/server/src/server-writer.ts:287`](../../packages/server/src/server-writer.ts)
and line 482). The smoke test's local copy of `LogEntry` at
[`tests/integration/export-smoke.test.ts:37-51`](../../tests/integration/export-smoke.test.ts)
carries `schema_version: number`, enforcing the field's existence at
the type level.

A second, separate version stamp lives on the coordination object at
[`packages/protocol/src/coordination/current-json.ts:56-62`](../../packages/protocol/src/coordination/current-json.ts):
`CurrentJson.schema_version: 1`, with JSDoc instructing readers to
reject unknown major versions with `BaerlyError{code:"InvalidResponse"}`.
That stamp tracks the `current.json` schema, not the document
schema; both use the same forward-only pattern.

## Consequences

- Schema migrations are forward-only. The `M` (MESSAGE) opcode on
  `LogEntry` is reserved for out-of-band schema announcements;
  consumers maintain a `schema_version → schema` table indexed by
  the announcement stream.
- The `schema_version` field is required on every entry (typed
  `number`, not optional). Writers emit `0` until the table API
  formalizes per-collection schemas; the wire shape is forward-
  compatible with future non-zero values.
- Renaming or removing `schema_version` from `LogEntry` is a
  major-version migration. Adding a new optional field alongside it
  is non-breaking and carries no version-bump cost.
- The `CurrentJson.schema_version` stamp is independent of the
  per-entry stamp. They evolve on their own cadences and a
  major-version bump on one does not force a bump on the other.
- Document-level migration tooling — rewriting documents to a new
  schema — is application-layer work. The protocol supplies the
  version stamp and the announcement opcode; the rewrite logic is
  out of scope.
- Snapshot bodies ([ADR-0017](./0017-snapshot-levels.md)) carry
  their own `schema_version: 1` independent of the per-entry stamp,
  for the same forward-only reason.
