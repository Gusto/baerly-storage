---
title: Schema-validator function shape
audience: adr
summary: ADR 009 — the collection schema validator runs against the post-image (document after merge-patch), requires `_id`, and accepts any StandardSchemaV1-compatible library; rejects on failure with BaerlyError{code:"SchemaError"}.
last-reviewed: 2026-06-22
tags: [decision, adr, schema, validation]
related:
  [
    README.md,
    005-verifier-function-shape.md,
    002-api-surface-lock.md,
  ]
---

# ADR-009: Schema-validator function shape

## Status

Accepted (2026-06-22). Implemented and shipped; this record documents a
decision that was already in the codebase but never written down.

## Context

`CollectionDefinition.schema` validates documents on write. This is a
distinct seam from the auth `Verifier` of ADR-005 — that one authorizes a
_request_; this one validates a _document_. The decision was made and
shipped but never recorded; its rationale lived only in `query.ts` comments.

Two design questions needed answers before the seam could be considered
stable enough to lock:

1. **When does the validator run — against the incoming patch or against
   the resulting document?** Writes are RFC 7386 merge-patches: a partial
   update merges onto the existing document. Validating the incoming patch
   would reject any schema that declares required fields the patch doesn't
   restate, making partial updates useless with schemas.

2. **Which interface?** A baerly-proprietary validator signature would
   require adapters for every schema library; the ecosystem's Standard
   Schema initiative (`StandardSchemaV1`) already solves this.

## Decision

1. **Validate the post-image, not the patch.** Writes are merge-patches; the
   validator runs against the document _after_ the patch is folded onto the
   prior state, so a partial update is checked as the resulting whole. A patch
   that omits a required field is valid iff the merged document still has it.
2. **`_id` is part of the validated shape and is required.** The post-image
   always carries `_id`, so the schema must assert it (e.g.
   `_id: z.string()`). This is consistent with the canonical example in
   `packages/server/src/schema.ts`.
3. **The accepted type is `SchemaValidator` (from `@baerly/protocol`), which
   is structurally compatible with the StandardSchemaV1 contract.** The interface
   inlines the `~standard.validate` shape with no runtime dependency on the spec
   package. Any Standard-Schema-compatible library (Zod, Valibot, ArkType, …)
   works without a baerly-specific adapter. Unlike the auth `Verifier` (whose
   result is deliberately opaque — ADR-005), the schema validator is
   introspectable through the Standard Schema contract.

## Consequences

- **Validation cost sits on the write path, before the commit fires.**
  `validateOrThrow` is called in `runInsert`, `runUpdate`, and
  `runReplaceById` (`packages/server/src/query.ts:374–378`, `:463–466`,
  `:518–521`) before `Writer.commit()`. A schema rejection is cheap: it
  aborts before any storage round-trip.
- **Partial updates are safe with strict schemas.** Because validation runs
  on the _merged_ post-image (`:447–464`), a patch that only touches `status`
  passes a schema that also requires `title` — as long as the merged document
  carries `title`. Validating the patch instead would have made `update()` and
  strict schemas mutually exclusive.
- **On failure an app receives `BaerlyError{code:"SchemaError"}` with a
  structured `.issues` array** (`packages/protocol/src/errors.ts:18–27`,
  `packages/server/src/schema.ts:69–74`). The HTTP layer maps this to 400.
  The issues carry `(string | number)[]` paths and human-readable messages,
  normalised from the raw `StandardSchemaV1` issue segments.
- **The validator does not run on reads or during export/replay.** The log
  stores post-images produced at write time; replay folds them directly
  without re-validating. This means a schema change does not retroactively
  reject existing documents — existing rows remain readable regardless.
- **`update()` atomicity is per-row.** If a multi-row update fails schema
  validation on row N, rows 0..N-1 are already committed (`:457–466`). The
  per-row atomicity contract is locked; the schema seam inherits it.

## Alternatives considered

- **Validate the incoming patch.** Rejected: a valid partial update would fail
  any schema with required fields the patch doesn't restate.
- **A baerly-proprietary validator signature.** Rejected: Standard Schema is
  the ecosystem-neutral contract; no reason to fork it.
