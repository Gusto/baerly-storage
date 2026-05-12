---
title: Protocol & contracts index
audience: meta
summary: "Six stable specs: sync protocol, causal-consistency checking, merge patch, log shape, S3 surface."
last-reviewed: 2026-05-12
tags: [index, protocol, spec]
related: [sync-protocol.md, log-entry-shape.md]
---

# `docs/spec/` — protocol & contracts

Stable specs. The "what" — implementation lives in `packages/`.

- [sync-protocol.md](sync-protocol.md) — atomic multi-key writes
  over S3 via manifest indirection; time-ordered log; reconciliation
  algorithm.
- [causal-consistency-checking.md](causal-consistency-checking.md)
  — the low-complexity property-checking technique used to verify
  the sync protocol stays causally consistent under fault injection.
- [json-merge-patch.md](json-merge-patch.md) — RFC 7386 plus the
  algebraic properties (associativity, idempotence) the system
  relies on for log coalescing and network optimization.
- [log-entry-shape.md](log-entry-shape.md) — the `LogEntry` wire
  contract. Postgres-logical-replication-shaped; frozen and stable.
- [s3-features-used.md](s3-features-used.md) — the minimal S3 API
  surface the protocol depends on.
- [s3-xml-escaping-cases.md](s3-xml-escaping-cases.md) — edge cases
  for `ListObjectsV2` XML responses; companion to
  `fixtures/s3-key-escaping/`.
