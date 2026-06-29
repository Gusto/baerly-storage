---
title: Protocol & contracts index
audience: meta
summary: "Stable specs and protocol-adjacent analyses: sync protocol, causal-consistency checking, merge patch, log shape, S3 surface, fencing, and prior art."
last-reviewed: 2026-06-23
tags: [index, protocol, spec]
related: [sync-protocol.md, log-entry-shape.md]
---

# `docs/spec/` — protocol & contracts

Stable specs and protocol-adjacent analyses. The "what" lives here;
implementation lives in `packages/`.

- [sync-protocol.md](sync-protocol.md) — atomic document writes over
  object storage via single-write commit: the numbered `log/<seq>`
  create is the commit, `current.json` is compaction state, and readers
  discover the tail by forward-probe. Decision record:
  [ADR-008](../adr/008-single-write-commit.md).
- [causal-consistency-checking.md](causal-consistency-checking.md)
  — the low-complexity property-checking technique used to verify
  the sync protocol stays causally consistent under fault injection.
- [json-merge-patch.md](json-merge-patch.md) — RFC 7396 plus the
  algebraic properties and boundaries for safe sparse-patch handling.
  API updates accept merge patches; committed `U` log entries are full
  post-images, not coalesced patches.
- [log-entry-shape.md](log-entry-shape.md) — the `LogEntry` wire
  contract. Debezium-style CDC envelope; pre-launch it may still
  narrow. After the first production consumer, removing, renaming, or
  repurposing fields is a major-version migration.
- [storage-compatibility.md](storage-compatibility.md) — the minimal S3 API
  surface the protocol depends on.
- [s3-xml-escaping-cases.md](s3-xml-escaping-cases.md) — edge cases
  for `ListObjectsV2` XML responses; companion to
  `manual-e2e/fixtures/s3-key-escaping/`.
- [writer-fence-adversarial-model.md](writer-fence-adversarial-model.md)
  — adversarial model for the **dormant** fence-claim primitive
  (retained for admin/testing and as the patent-C1 provenance record;
  not on the commit path under
  [ADR-008](../adr/008-single-write-commit.md)).
- [prior-art.md](prior-art.md) — comparison against object-storage
  databases and adjacent coordination systems.
