---
title: Glossary
audience: integrator
summary: One-line definitions of the load-bearing terms used across the docs — commit, log, seq, tail, snapshot, compaction, GC, LSN, session, and the rest.
last-reviewed: 2026-06-28
tags: [reference, glossary, terms]
related: ["about/how-it-works.md", "spec/sync-protocol.md", "contributing/architecture.md"]
---

# Glossary

Quick definitions for the terms the rest of the docs lean on. Each term
is defined once here; the mental model that ties them together is
[`about/how-it-works.md`](about/how-it-works.md), and the precise
contract is [`spec/sync-protocol.md`](spec/sync-protocol.md).

## The commit

| Term | Meaning |
| --- | --- |
| **Commit** | The moment a change becomes durable and visible. It is the successful create-if-absent PUT of `log/<seq>.json` — that one object creation is the commit. There is no separate `current.json` write on the commit path. |
| **Create-if-absent** | A conditional write that succeeds only if no object with that name exists yet (S3's `If-None-Match: "*"`). When many writers race to create the same fresh key, exactly one wins. |
| **Update-if-unchanged** | A conditional write that overwrites an object only if it still matches the version the writer last read (S3's `If-Match`). Used by compaction to advance `current.json`. |
| **Session** | A one-time, in-memory value placed in a single in-flight log entry so a writer can recognize its own earlier attempt on retry. Not a login, lock, lease, or persistent writer identity. |
| **Adoption** | On a conflicting log create, the writer reads the occupant and treats it as its own already-durable commit only if it has the same `session`, same `seq`, and full-entry equality. Otherwise the occupant is a foreign write and the writer probes the next slot. |

## The log

| Term | Meaning |
| --- | --- |
| **Collection** | The table-like unit you query. Each collection has its own numbered log, `current.json`, and tail; a write commits to exactly one collection. |
| **Log** | The append-only, numbered sequence of committed changes: `log/0.json`, `log/1.json`, and so on. The log decides commit order. |
| **Sequence number (`seq`)** | The integer position of one log entry. The kernel orders strictly by `seq`. |
| **Tail** | The first empty sequence, immediately after the highest committed entry. |
| **Dense log** | The live log has no intended holes: writers fill the first empty sequence and never skip a number. |
| **Forward-probe** | Reading `log/<seq>` upward from `max(log_seq_start, tail_hint)` until the first 404. That gap is the true tail. |
| **`tail_hint`** | A non-authoritative lower-bound starting point for the forward-probe, stored in `current.json`. It only ever moves forward; it is not the authoritative tail. |
| **Content object** | The object holding a document's row bytes, stored under a content-addressed key (a hash of the bytes), separate from the log entry and index markers. |
| **Index marker** | A small (zero-byte) object whose existence records one secondary-index fact. Used to narrow a read to candidate doc ids; never the row truth. |
| **LSN** | An opaque external cursor shaped `<base32-time>_<session>_<seq>`. Downstream change-feed consumers sort by the integer `seq`, never by the timestamp prefix. |

## Maintenance

| Term | Meaning |
| --- | --- |
| **`current.json`** | A per-collection compaction bookmark: the snapshot pointer, `log_seq_start`, exact counters, and the `tail_hint`. It is **not** the latest-commit record. |
| **Snapshot** | A single object holding the rolled-up state of many older log entries, so reads replay a short tail instead of the whole history. Content-hashed and verified by readers. |
| **`log_seq_start`** | The first log sequence not yet folded into the current snapshot. |
| **Compaction** | Folding a prefix of the dense log into a fresh snapshot and advancing `current.json` to point at it. |
| **Garbage collection (GC)** | Sweeping objects no live snapshot or log entry still references — superseded snapshots, compacted-away log entries, orphaned content from a crashed write — after a grace window. |
| **Maintenance** | Compaction plus GC. It is triggered by successful writes in bounded slices; reads never run it. No daemon, timer, or operator scheduler is required. |
