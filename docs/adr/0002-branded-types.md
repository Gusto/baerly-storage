---
title: Branded types over plain strings
audience: adr
summary: ADR 0002 — Branded types over plain strings.
last-reviewed: 2026-05-12
tags: [decision, adr]
related: [README.md]
---

# 0002 — Branded types over plain strings

## Context

The sync protocol traffics in several string-shaped values that are not
interchangeable:

- `ManifestKey` — an S3 object key for a manifest log entry, shape
  `<base32-time>_<session>_<seq>`. Order-sensitive.
- `UUID` — a v4 UUID, used as session IDs and synthetic content IDs.
- `VersionId` — an S3 object version identifier, externally assigned by
  the bucket.
- `Ref.key` — the application-level document key.

Mixing these is the kind of bug that compiles and only surfaces at
runtime when a manifest fails to parse, a subscriber misses a notify,
or — worst — a write lands at the wrong S3 key and corrupts the log.

## Decision

Use TypeScript's nominal-typing pattern (declared `unique symbol` brand)
for the four types listed above. The brand has no runtime cost and
TypeScript rejects implicit widening between branded strings.

The `Branded<T, B>` helper and the boundary constructors (`uuid()`,
`versionFromUuid()`, etc.) all live in
[`packages/protocol/src/types.ts`](../../packages/protocol/src/types.ts). New strings introduced at
protocol boundaries should pick up a brand if the kind of string would
be confusable with another.

## Consequences

- The compiler catches mixups statically.
- Casting (`as ManifestKey`) is allowed but should appear *only at the
  one boundary where a string becomes a branded value*, with a comment
  if the source isn't obvious.
- `CLAUDE.md`'s "Branded types are load-bearing" anti-pattern enforces
  the rule for agents: don't widen with `as string`.
- IDE hover on a branded type shows the brand label, which doubles as
  documentation.
- Cost: serializing/deserializing across worker boundaries needs the
  brand re-applied (a one-line cast). Tests that construct values
  directly need the same.
