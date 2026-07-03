---
title: Protocol & contracts index
audience: meta
doc_type: index
summary: "Stable specs and protocol-adjacent analyses: sync protocol, causal-consistency checking, merge patch, log shape, S3 surface, fencing, and prior art."
last-reviewed: 2026-06-27
tags: [index, protocol, spec]
related: [sync-protocol.md, log-entry-shape.md]
---

# `docs/spec/` — protocol & contracts

Stable specs and protocol-adjacent analyses. The "what" lives here;
implementation lives in `packages/`. Entries are grouped by role; the
same grouping is recorded per file as the `doc_type:` frontmatter field.

## Current contracts

Binding descriptions of how the live protocol behaves today.

- [sync-protocol.md](sync-protocol.md) — atomic document writes over
  object storage via single-write commit: the numbered `log/<seq>`
  create is the commit, `current.json` is compaction state, and readers
  discover the tail by forward-probe. Decision record:
  [ADR-004](../adr/004-single-write-commit.md).
- [storage-compatibility.md](storage-compatibility.md) — the minimal S3 API
  surface the protocol depends on.
- [capabilities.md](capabilities.md) — required-vs-optional storage
  capability split (CAS mandatory; supportsAbort optional; ReaderStorage
  tier planned).
- [log-entry-shape.md](log-entry-shape.md) — the `LogEntry` wire
  contract. Debezium-style CDC envelope; versionless/additive-only
  `0.3.0` public early-access baseline, with pre-1.0 breaks following
  the compatibility policy recorded there.

## Semantic references

- [json-merge-patch.md](json-merge-patch.md) — RFC 7396 plus the
  algebraic properties and boundaries for safe sparse-patch handling.
  API updates accept merge patches; committed `U` log entries are full
  post-images, not coalesced patches.

## Verification

- [causal-consistency-checking.md](causal-consistency-checking.md)
  — the low-complexity property-checking technique used to verify
  the sync protocol stays causally consistent under fault injection.

## Adapter edge cases

- [s3-xml-escaping-cases.md](s3-xml-escaping-cases.md) — edge cases
  for `ListObjectsV2` XML responses; companion to
  `manual-e2e/fixtures/s3-key-escaping/`.

## Historical, rationale & evidence

- [writer-fence-adversarial-model.md](writer-fence-adversarial-model.md)
  — adversarial model for the **dormant** fence-claim primitive
  (retained for admin/testing and as the patent-C1 provenance record;
  not on the commit path under
  [ADR-004](../adr/004-single-write-commit.md)).
- [prior-art.md](prior-art.md) — comparison against object-storage
  databases and adjacent coordination systems.
- [attachments/](attachments/) — regenerated benchmark baselines and
  rendering evidence referenced by the specs above; treated as
  unformatted data, not prose.
