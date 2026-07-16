---
title: LogEntry is versionless and additive-only
audience: adr
doc_type: adr
summary: ADR 005 — LogEntry carries no schema_version; the live wire contract is versionless/additive-only and is owned by spec/log-entry-shape.md.
last-reviewed: 2026-06-29
tags: [decision, adr, log, contract]
related: [README.md, 003-layout-versioning-cordon.md, "../spec/log-entry-shape.md", "../contributing/conventions/versioning.md"]
---

# 005 — LogEntry is versionless and additive-only

## Status

Accepted (2026-06-27).

## Context

`current.json`, `gc/pending.json`, and the snapshot body each carry a
`schema_version` and reject unknown majors. `LogEntry`
(`packages/protocol/src/log.ts`) deliberately does not. The roadmap for
multiple implementations flags this as urgent: once a second
implementation or a checked-in conformance corpus consumes `LogEntry`,
"the shape may still narrow" stops being true, so the policy must be
pinned now — either add a `schema_version` field before freezing
fixtures, or declare the contract versionless with additive-only
evolution.

The live field-level policy belongs in
[`docs/spec/log-entry-shape.md`](../spec/log-entry-shape.md). This ADR
keeps the rationale and the closed path.

## Decision

`LogEntry` is **versionless and additive-only**. No `schema_version`
field is added. Unknown optional fields remain the compatible extension
path, consistent with the additive-optional default in
[ADR-003](003-layout-versioning-cordon.md).

## Closed Paths

The rejected alternative — adding `LogEntry.schema_version` — buys
nothing today (no consumer), costs a write-path field and bundle bytes
on every entry, and is revisitable: if a future breaking change needs a
discriminator, that change is itself the major migration that can
introduce one.

## Consequences

- The conformance corpus may freeze `LogEntry` fixtures under
  the "versionless v1" label without waiting on a field addition.
- `version-matrix.json` records `LogEntry` as
  `{ value: null, policy: "versionless-additive-only" }`; the drift
  gate fails if that sentinel changes without updating this ADR.
- A future need for a real `LogEntry` schema discriminator reopens this
  ADR with a supersession record.

## Live Owner

The wire contract and compatibility details live in
[`docs/spec/log-entry-shape.md`](../spec/log-entry-shape.md#stability).
