---
title: Single-write commit — the numbered log append is the commit
audience: adr
doc_type: adr
summary: ADR 004 — a commit is one linearizable `If-None-Match:"*"` create on `log/<seq>`; `current.json` is not commit authority. The full algorithm lives in sync-protocol.md; this record keeps the commit-authority guardrail and the rejected two-write / reverse-LIST paths.
last-reviewed: 2026-06-28
tags: [decision, adr, sync-protocol, runtime-model]
related:
  [
    README.md,
    "../spec/sync-protocol.md",
    001-tenant-cas-isolation.md,
    002-ephemeral-coordination.md,
    003-layout-versioning-cordon.md,
  ]
---

# 004 — Single-write commit: the numbered log append is the commit

## Status

Accepted (2026-06-15). Implemented. Supersedes the two-write commit
described by earlier revisions of
[sync-protocol.md](../spec/sync-protocol.md). Before the 0.3.0 public
baseline, the v2→v3 `current.json` schema break shipped with **no
migration path** — a v2 bucket had to be dumped with v2 tooling and
restored into a fresh v3 bucket.

## Decision

A commit is **one** linearizable `If-None-Match:"*"` create on
`log/<seq>.json` — winning (`200`) is the commit; `412` means a peer (or a
lost-ack self-retry, resolved by the same-session adoption check) took
that seq. `current.json` **leaves the commit path**: it is compactor-owned
compaction state plus a *non-authoritative* `tail_hint` lower bound, not
the authoritative head. Readers discover the tail by **bounded forward
probe** (GET until the first 404), never a reverse-LIST.

**The full algorithm — write path, read path, tail discovery, hybrid
index emission, and the v3 schema — lives in
[sync-protocol.md](../spec/sync-protocol.md)
([§Write algorithm](../spec/sync-protocol.md#write-algorithm),
[§Storage layout](../spec/sync-protocol.md#storage-layout),
[§Protocol invariants](../spec/sync-protocol.md#protocol-invariants)).**
This ADR is the decision record; the spec is the live contract.

The one load-bearing prerequisite the spec states: correctness rests
entirely on the backend's `If-None-Match:"*"` create-if-absent being
**linearizable under concurrency** — N concurrent creates of a fresh seq
yield **exactly one** winner. A backend that admits two winners produces a
split-brain commit, so the log/CAS path must hit the object store
directly, never through a negative-caching CDN or proxy (a cached `404` on
a newly created `log/<seq>` would corrupt the forward-probe's "first 404 =
tail" signal). See [ADR-002](002-ephemeral-coordination.md) for the backend
gate.

## Closed paths

These remain closed unless a future post-0.3.0 ADR supersedes this one.

- **Two-write commit** (`log/<seq>` create *then* a `current.json`
  CAS-advance), and any recovery tooling (`dead_seqs`, K-detector,
  recovery CAS) to police it. The second write let a crash orphan a
  committed entry at `next_seq` and **wedge the collection** permanently;
  stale `current.json.next_seq` can make future writers retry the already
  occupied slot forever. The single write removes the pointer there is to
  crash between, so there is no hole to recover.
- **`current.json` as commit authority.** It is compaction state; the
  commit path does not write it. Restoring it to the commit path
  reintroduces the two-write wedge.
- **Reverse-LIST for tail discovery.** Not implementable as the log is
  keyed (raw-decimal keys do not sort numerically), would re-key the log
  (a wire break across read path / compactor / GC / `/v1/since`), would pay
  a Class-A LIST per commit on the hot path, and would expose discovery to
  LIST-after-write visibility lag. The forward probe avoids all four.
- **Mandatory writer hint refresh** after the commit. A stale hint only
  lengthens the next probe (never a correctness hazard); making a refresh
  mandatory reintroduces the second `current.json` write.
- **Emit all index keys *after* the commit.** Would leave a committed doc
  transiently unindexed. Index emission is hybrid — new keys PUT *before*
  the commit, stale keys DELETE'd *after* — so a crash can never de-index a
  committed doc.
