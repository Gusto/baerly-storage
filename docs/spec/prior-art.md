---
title: Prior art and lineage
audience: spec
doc_type: rationale
summary: How baerly-storage's object-store protocol relates to mps3, table formats, object-store LSMs, actor coordinators, and other S3-backed systems.
last-reviewed: 2026-11-17
tags: [protocol, prior-art]
related:
  [
    sync-protocol.md,
    storage-compatibility.md,
    causal-consistency-checking.md,
    ../adr/002-ephemeral-coordination.md,
    ../adr/004-single-write-commit.md,
  ]
---

# Prior art and lineage

This doc places baerly-storage's protocol next to the systems it borrows from or resembles: what came from mps3, what earlier systems already do, and where baerly-storage makes a different trade-off.

## What baerly-storage does

| Mechanism | Summary | Where to read more |
| --- | --- | --- |
| Single-create commit | A write commits by creating the next numbered `log/<seq>.json` object with `If-None-Match: "*"`; `current.json` is not the commit head. If the acknowledgement is lost, the same in-flight writer can adopt the already-written log entry after a strict same-session / same-sequence / same-entry check. | [ADR-004](../adr/004-single-write-commit.md), [`log-conflict-adoption.ts`](../../packages/server/src/log-conflict-adoption.ts) |
| Write-tick maintenance | Compaction and GC run as bounded slices triggered by writes; reads never perform maintenance. The bound is per configured slice, not a fixed operation count for every bucket state. | [ADR-002](../adr/002-ephemeral-coordination.md), [sync-protocol.md](sync-protocol.md#maintenance-runtime-model) |
| Backend probing | A bucket can be probed for stale-`If-Match` rejection, existing-key `If-None-Match` rejection, and exactly-one-winner concurrent create-if-absent before the protocol relies on it. | [storage-compatibility.md](storage-compatibility.md), [ADR-004](../adr/004-single-write-commit.md#decision) |
| Dense forward-probe tail | Writers target the first empty log sequence and readers stop at the first missing sequence, which keeps `current.json` off the commit path. | [sync-protocol.md](sync-protocol.md#protocol-invariants) |
| `/v1/since` cursor | The public cursor is opaque to clients but carries an embedded integer `seq` that the server recovers before resuming by numbered log GETs. | [sync-protocol.md](sync-protocol.md#lsns-wall-clocks-and-downstream-consumers) |

## Platform primitives

S3 strong consistency and S3 conditional writes make this design class possible, and many systems now combine immutable artifacts with a small conditional-write coordination point.

- **December 2020:** Amazon S3 announced strong read-after-write and list consistency. Before this, many object-store database designs needed a separate linearizable metadata service to answer "what exists." See [storage-compatibility.md](storage-compatibility.md#s3-strong-consistency-guarantees).
- **August 2024:** S3 announced conditional create via `If-None-Match`.
- **November 2024:** S3 announced conditional update via `If-Match` over ETags.

`If-None-Match` create-if-absent, `If-Match` CAS, append-only logs, content-addressed bodies, and optimistic concurrency are all well-known tools. What baerly-storage adds is the combination: a small document database whose commit, cursor, snapshot, compaction, and garbage collection run from request-bounded compute, with the bucket as the only persistent component.

## mps3: fork ancestor

baerly-storage is derived from mps3, public MIT open source from 2023. The repository's [NOTICE](../../NOTICE) retains its MIT notice, Copyright (c) 2023 Endpoint Services.

- mps3 already uses object storage directly as a datastore.
- It uses HTTP `Date` for client-side clock correction.
- It does not use a single-create numbered-log commit; `current.json` stays on its commit path.
- It has no same-session adoption for a numbered-log conflict, no server package, and no write-triggered maintenance loop.
- The descending base-32 LSN encoding and the causal-consistency checker ([causal-consistency-checking.md](causal-consistency-checking.md)) are inherited from mps3.

## Iceberg, Delta Lake, and table formats

Apache Iceberg and Delta Lake write immutable artifacts and then publish by advancing table metadata or log state.

Iceberg writers prepare new metadata and atomically swap the table's current metadata pointer, with validation and retry around concurrent writes. baerly-storage's ordinary write instead commits by creating one numbered log object; there is no metadata-pointer swap.

Delta Lake's S3 story is split by engine and backend. The Spark S3 path distinguishes single-cluster writes from multi-cluster writes through a DynamoDB-backed log store. delta-rs can use conditional puts on some S3-compatible stores such as R2 and MinIO, while its AWS S3 documentation still describes a locking provider for safe concurrent writes.

Differences:

- baerly-storage has no table catalog acting as the authoritative commit head;
- the commit point is `log/<seq>.json` create-if-absent, not a manifest pointer swap;
- `current.json` is compaction state and a lower-bound hint, not the commit head; and
- maintenance fits request-bounded compute rather than table-service jobs or long-lived engines.

## SlateDB and object-store LSMs

SlateDB is an LSM tree over object storage with conditional object creation and manifest coordination. Its RFC-0001 writer protocol uses writer epochs and treats a conflict at the same writer epoch as an illegal state that "should panic". baerly-storage treats the analogous same-writer collision as a possible lost acknowledgement and adopts the entry only when it matches the writer's in-flight attempt:

1. same per-commit session,
2. same sequence,
3. full entry equality, and
4. single-input commit shape.

This is not general crash recovery. The session is an in-memory per-commit nonce, not a secret; a restarted process that lost the session cannot claim the old attempt. It covers a lost acknowledgement or transient retry of the same commit attempt.

## Durable Objects, actors, and stateful coordinators

Cloudflare Durable Objects and similar actor systems coordinate writers through a stateful single-threaded object with attached durable state. That is the opposite trade-off from baerly-storage, which has no resident actor and uses the object store itself as the coordination point; losing process memory between requests must not break correctness.

- **Neon** — Postgres with storage disaggregated onto S3-backed pageservers; a managed control plane and always-on pageserver compute own consistency.
- **Cloudflare D1** — SQLite on a Durable Object; single-writer serialization comes from the DO, not object-store CAS, so it depends on DO compute being live.

## Other object-store systems

- Litestream / LiteFS / mvSQLite-style SQLite replication and object-store durability.
- DuckDB/DuckLake and related "catalog or table state in object storage" designs.
- Kafka-on-S3 / WarpStream-style systems where object storage holds log segments and the append position is the logical commit.
- Turbopuffer-style systems that use object storage heavily but run long-lived query and indexer fleets.

Compared with these, baerly-storage is a small document datastore whose whole lifecycle runs directly against an S3-compatible bucket from request-bounded compute, without a resident coordinator, lock table, catalog service, daemon, or privileged scheduler.

## Descending keys and the LSN cursor

| Encoding | Status | Notes |
| --- | --- | --- |
| `log/<seq>.json` raw decimal object keys | Reverse-LIST rejected | ADR-004 rejects reverse-LIST for log-tail discovery; the tail is found by dense forward-probe. |
| LSN string `<base32-time>_<session>_<seq-fragment>` | Live cursor | Minted on every commit, parsed at `/v1/since`, tested in `lsn-reverse-list.test.ts`, benchmarked in `bench:lsn-reverse-walk`. |

Descending-key encodings are common practice: Azure Table Storage log-tail keys, HBase `Long.MAX_VALUE - timestamp` row keys, descending ULIDs, reverse-comparator storage conventions. The baerly-storage-specific part is the cursor contract: `/v1/since` recovers the embedded integer `seq` and resumes by numbered log GETs.

Because `session` sits in the middle of the tuple, lexicographic newest-first ordering is strict only within one session or when timestamps don't tie. Cross-session same-millisecond order is session-lexical, not causal. Kernel correctness rests on integer `seq`, never on LSN or wall-clock order.
