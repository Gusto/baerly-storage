---
title: Prior-art differentiation
audience: spec
summary: Technical differentiation against known prior art for baerly-storage's live object-store protocol mechanisms.
last-reviewed: 2026-06-17
tags: [protocol, patent, prior-art]
related:
  [
    sync-protocol.md,
    storage-compatibility.md,
    causal-consistency-checking.md,
    ../adr/004-ephemeral-coordination.md,
    ../adr/008-single-write-commit.md,
  ]
---

# Prior-art differentiation

## Scope

This is a technical reference for maintainers and counsel. It is not a
legal opinion. Its job is to keep the engineering facts straight: what
baerly-storage currently does, what earlier systems already do, what came
from mps3, and where the live protocol is narrower than broad
"database-on-object-storage" language.

The current protocol should be analyzed around the live mechanisms below,
not the older provisional `C1` / `C2` / `C3` bundle as originally worded.

| Label  | Plain-English mechanism                                                                                                                                                                                                                                                                                   | Where to read more                                                                                                                                      |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | A write commits by creating the next numbered `log/<seq>.json` object with `If-None-Match: "*"`; `current.json` is not the commit head. If the acknowledgement is lost, the same in-flight writer can adopt the already-written log entry after a strict same-session / same-sequence / same-entry check. | [ADR-008](../adr/008-single-write-commit.md), [`log-conflict-adoption.ts`](../../packages/server/src/log-conflict-adoption.ts)                          |
| **P2** | New index markers are written before the commit and stale markers are deleted after it, so crashes can leave extra candidates but not missing committed rows.                                                                                                                                             | [sync-protocol.md](sync-protocol.md#crash-safety)                                                                                                       |
| **P3** | Compaction and GC run as bounded write-tick slices; reads never perform maintenance. The honest bound is per configured slice, not a fixed operation count for every bucket state.                                                                                                                        | [ADR-004](../adr/004-ephemeral-coordination.md), [sync-protocol.md](sync-protocol.md#maintenance-runtime-model)                                         |
| **S1** | A bucket can be probed for stale-`If-Match` rejection, existing-key `If-None-Match` rejection, and exactly-one-winner concurrent create-if-absent before the protocol relies on it.                                                                                                                       | [storage-compatibility.md](storage-compatibility.md), [ADR-008](../adr/008-single-write-commit.md#7-the-load-bearing-prerequisite--deploy-time-probing) |
| **S2** | Writers target the first empty log sequence and readers stop at the first missing sequence. This dense forward-probe rule lets `current.json` leave the commit path.                                                                                                                                      | [sync-protocol.md](sync-protocol.md#protocol-invariants)                                                                                                |
| **S3** | The public `/v1/since` cursor is opaque to clients but carries an embedded integer `seq` that the server recovers before resuming by numbered log GETs.                                                                                                                                                   | [sync-protocol.md](sync-protocol.md#lsns-wall-clocks-and-downstream-consumers)                                                                          |

The older two-phase server-`Date` writer fence remains in source history
and in the previous provisional disclosure, but it is not the live
production commit mechanism. The `writer_fence` field is still present as
schema shape and is written inert at bootstrap and on `admin restore
--force`; no production commit path relies on its value.

## Google Form Alignment

This section maps the current engineering record onto the prompts from the
legal intake form. It is a fact source, not the final legal answer.

### Summary

baerly-storage is a document database that runs directly on an
S3-compatible bucket. There is no database server. A write commits by
creating the next numbered log object with a conditional create; that one
object create is the commit. The surrounding mechanisms handle retries,
indexes, cursors, snapshots, compaction, garbage collection, and backend
safety while keeping the bucket as the only persistent component.

### Title of Idea

Document database that commits directly to object storage without a
database server.

### What Problem(s) Are You Solving For?

- A logical document write spans multiple objects, but the object store
  only makes one object write atomic at a time.
- Many stateless writers need one per-collection commit order without a
  mutable head pointer on every commit.
- A lost success response can look like a write conflict.
- Secondary indexes must not hide committed rows after a mid-write crash.
- Compaction and garbage collection must fit request-bounded compute.
- Reads should not become hidden maintenance workers.
- The system must verify that an arbitrary S3-compatible backend honors the
  conditional-write behavior the protocol depends on.

### What Is Your Proposed Solution?

The proposed solution is the composition of P1, P2, P3, and the supporting
mechanisms S1-S3:

- **P1:** commit by creating `log/<seq>.json` with `If-None-Match: "*"`;
  adopt a same-writer lost-ack entry only when it passes the strict
  same-session / same-sequence / same-entry check.
- **P2:** write additive index markers before the commit and delete stale
  markers after the commit, so crash residue is an extra candidate rather
  than a missing committed row.
- **P3:** run compaction and garbage collection as bounded write-triggered
  slices; reads never run maintenance.
- **S1:** probe the backend for the required conditional-write behavior.
- **S2:** find the log tail by the dense forward-probe rule.
- **S3:** treat the public change-feed cursor as opaque to clients, but
  recover the embedded integer `seq` at `/v1/since`.

### What Are the Distinctive Features That Make This Idea Inventive?

The distinctive features are narrow:

- The numbered log create is the commit; `current.json` is compaction
  state, not the ordinary commit head.
- Lost acknowledgement is resolved by same-session / same-sequence /
  same-entry adoption, not by a persistent writer identity or lock service.
- Index emission is ordered so crashes create false positives, not false
  negatives.
- Maintenance rides writes in bounded slices while reads stay pure.
- Backend conditional-write conformance is probed before the bucket is
  trusted.
- The dense forward-probe rule replaces a mutable authoritative tail on the
  commit path.
- The `/v1/since` cursor contract resumes by integer `seq`; the inherited
  descending encoding is not the point.

### Who Helped Conceptualize This Invention?

The repository evidence identifies Eric Baer as the author of the
post-fork mechanisms listed here. Final inventor and contributor
identification should be confirmed outside this technical doc.

### When Did You First Come Up With This Invention?

The mps3 import commit is `4fa31c93` on 2026-05-08. The relevant
baerly-storage mechanisms appeared after that:

- index module: `94f18d5f` on 2026-05-12;
- lost-ack adoption concept: `5e6da244` on 2026-05-20;
- write-tick maintenance dispatch: `4ea87a22` on 2026-05-30;
- backend CAS probe: `577ecd46` on 2026-05-31; and
- live single-create commit plus before/after-commit index polarity:
  2026-06-15 (`5e540b24` / `e9614355`).

### Has the Invention Been Publicly Disclosed, or Are There Plans to Do So?

The project is open source and published publicly as `@gusto/baerly-storage`
and `@gusto/create-baerly-storage`. The repo also carries public technical
docs. Exact disclosure dates should be confirmed from release and repository
history before counsel relies on them.

### Has a Product Resulting From the Invention Been Used or Sold Anywhere?

The repository establishes public source and package publication. It does
not by itself establish customer use, commercial sale, or deployment
history. Confirm those facts separately.

### Component/s

The main components are:

- `packages/server/src/writer.ts` for the commit path and index emission;
- `packages/server/src/log-conflict-adoption.ts` for same-writer lost-ack
  adoption;
- `packages/server/src/log-tail.ts` and `log-walk.ts` for dense tail
  discovery and reads;
- `packages/server/src/maintenance.ts`, `compactor.ts`, and `gc.ts` for
  write-triggered maintenance;
- `packages/protocol/src/storage/probe-cas.ts` and CLI doctor wiring for
  backend conditional-write probing; and
- `docs/spec/sync-protocol.md` / ADR-008 for the protocol statement.

## Platform Primitives Are Background

Modern object storage is the platform, not the differentiator by itself.
S3 strong consistency and S3 conditional writes make this design class
possible, and many systems now use immutable artifacts plus a small
conditional-write coordination point.

Important timeline:

- **December 2020:** Amazon S3 announced strong read-after-write and list
  consistency. Before this, many object-store database designs needed a
  separate linearizable metadata service to answer "what exists." See
  [storage-compatibility.md](storage-compatibility.md#s3-strong-consistency-guarantees).
- **August 2024:** S3 announced conditional create via `If-None-Match`.
- **November 2024:** S3 announced conditional update via `If-Match` over
  ETags.

Avoid broad framing around the primitives. `If-None-Match`
create-if-absent, `If-Match` CAS, append-only logs, content-addressed
bodies, and optimistic concurrency are known tools. The narrower
baerly-storage mechanism is the composition: a small document database
whose commit, index safety, cursor, snapshot, compaction, and garbage
collection run from request-bounded compute while the bucket is the only
persistent component.

## mps3: Closest Fork Ancestor

mps3 is the closest baseline because baerly-storage is derived from it. The
repository's [NOTICE](../../NOTICE) retains the MIT notice for mps3,
Copyright (c) 2023 Endpoint Services.

Relevant facts:

- mps3 is public MIT open source from 2023 and predates baerly-storage.
- It uses object storage directly and is prior art for broad "bucket as
  datastore" positioning.
- It uses HTTP `Date` for client-side clock correction, but not as a
  durable server-timestamp fence in the current baerly-storage sense.
- It does not use the current single-create numbered-log commit where
  `log/<seq>.json` is the commit and `current.json` leaves the ordinary
  commit path.
- It does not contain baerly-storage's current same-session / same-entry
  adoption guard for a numbered-log conflict.
- It does not contain baerly-storage's server package, secondary-index
  module, or write-triggered maintenance loop as shipped here.

The safe differentiation is narrow: baerly-storage's live protocol uses
conditional create/CAS, dense numbered log ordering, lost-ack adoption,
hybrid index emission, and bounded write-triggered maintenance in ways mps3
did not. Do not imply that mps3 failed to use object storage as a datastore.

## Iceberg, Delta Lake, and Table-Format Commit Families

Apache Iceberg and Delta Lake are close background for manifest-CAS and
optimistic-concurrency patterns. They commonly write immutable artifacts
and then publish by advancing table metadata or log state.

Iceberg writers prepare new metadata and attempt to atomically swap the
table's current metadata pointer, with validation and retry semantics
around concurrent writes. That is close background for "write artifacts,
then atomically publish a new head." baerly-storage differs in product
shape and commit point: it is a document datastore whose ordinary write
commits by creating one numbered log object, not by CAS-advancing a table
metadata pointer.

Delta Lake needs careful wording because the S3 story is split by engine
and backend. The official Spark S3 path still distinguishes single-cluster
writes from multi-cluster writes through a DynamoDB-backed log store.
delta-rs can use conditional puts on some S3-compatible stores such as R2
and MinIO, while AWS S3 proper documentation still describes a locking
provider for safe concurrent writes. The accurate fact is "engine- and
backend-split," not "Delta simply requires DynamoDB" or "Delta has moved
entirely to lock-free S3."

Useful differentiation:

- baerly-storage does not use a table catalog as the authoritative commit
  head;
- the commit point is `log/<seq>.json` create-if-absent, not a manifest
  pointer swap;
- `current.json` is compaction state and a lower-bound hint, not the
  ordinary commit head; and
- maintenance is sized for request-bounded compute rather than delegated to
  table-service jobs or long-lived engines.

## SlateDB and Object-Store LSM Designs

SlateDB is close prior art in spirit: an LSM tree over object storage with
conditional object creation and manifest coordination. Its RFC-0001 writer
protocol uses writer epochs and treats a conflict at the same writer epoch
as an illegal state. The key contrast is short: SlateDB says a same-epoch
collision "should panic"; baerly-storage treats the analogous same-writer
collision as a possible lost acknowledgement and adopts only when the entry
matches the writer's in-flight attempt.

baerly-storage's adoption check is intentionally narrow. It recognizes an
existing entry as the writer's own prior successful attempt only if all
current guards pass:

1. same per-commit session,
2. same sequence,
3. full entry equality, and
4. current single-input commit shape.

Do not frame this as arbitrary crash recovery. The session is an in-memory
per-commit nonce, not a cryptographic secret. A restarted process that lost
the session cannot prove ownership of the old attempt. The accurate framing
is "lost acknowledgement / transient retry of the same logical commit
attempt."

SlateDB also weakens broad "object-store database without a traditional DB
server" language. Keep the baerly-storage distinction tied to the document
database shape, single-create numbered log, pure reads, request-bounded
maintenance, and no resident coordinator or compactor requirement.

## Durable Objects, Actors, and Stateful Coordinators

Cloudflare Durable Objects and similar actor systems solve multi-writer
coordination by introducing a stateful single-threaded object with attached
durable state. That is a valid serverless coordination design, but it is
the opposite trade-off from baerly-storage's bucket-only persistence model.

Differentiation:

- Durable Objects provide a resident coordination identity and private
  durable storage for that object.
- baerly-storage avoids a resident actor and treats the object store as the
  durable coordination point.
- Removing process memory between requests must not break correctness.

The product distinction is not "serverless" in the broad sense. It is "no
resident runtime required for correctness."

## Other Object-Store Database and Log Families

The following families should stay in the background set even when not
analyzed deeply here:

- Litestream / LiteFS / mvSQLite-style SQLite replication and object-store
  durability designs.
- DuckDB/DuckLake and related "catalog or table state in object storage"
  designs.
- Kafka-on-S3 / WarpStream-style systems where object storage holds log
  segments or immutable artifacts and the append position is the logical
  commit.
- Turbopuffer-style systems that use object storage heavily but ship
  long-lived query/indexer fleets.

These systems make broad "S3-backed datastore" framing crowded. The
defensible baerly-storage framing is narrower:

> baerly-storage is a small document datastore whose commit, query,
> cursor, index, compaction, and garbage-collection lifecycle runs directly
> against an S3-compatible bucket from request-bounded compute, without a
> resident coordinator, lock table, catalog service, daemon, or privileged
> scheduler.

## Descending LSN Encoding and Reverse-LIST Background

Keep two encodings separate:

| Encoding                                            | Current status        | Notes                                                                                                                             |
| --------------------------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `log/<seq>.json` raw decimal object keys            | Reverse-LIST rejected | ADR-008 rejects reverse-LIST for log-tail discovery. The live log tail is discovered by dense forward-probe.                      |
| LSN string `<base32-time>_<session>_<seq-fragment>` | Live cursor mechanism | Minted on every commit, parsed at `/v1/since`, tested in `lsn-reverse-list.test.ts`, and benchmarked in `bench:lsn-reverse-walk`. |

Descending-key tricks are background practice. Examples include Azure
Table Storage log-tail keys, HBase `Long.MAX_VALUE - timestamp` row-key
patterns, descending ULID discussions, and reverse-comparator storage
conventions.

The narrow baerly-storage point is not "descending keys." It is the cursor
contract: each committed log entry carries an opaque cursor, `/v1/since`
recovers the embedded integer `seq`, and kernel reads resume by numbered
log GETs. The inherited descending base-32 encoding is not claimed as
baerly-specific.

One accuracy caveat matters: the tuple is
`<base32-time>_<session>_<seq-fragment>`, so `session` is in the middle.
Lexicographic newest-first ordering is strict only within a single session
or when timestamps do not tie. Cross-session same-millisecond order is
session-lexical, not causal. Kernel correctness is anchored on integer
`seq`, not LSN or wall-clock order.

## Causal-Consistency Checking

[causal-consistency-checking.md](causal-consistency-checking.md) describes
a randomized property-checking method that uses a known global timeline to
verify causal observations without full model checking. It is useful
engineering evidence, but it is not the same kind of runtime protocol
mechanism as P1-P3.

Current framing:

- baerly-storage's live contract is per-document and per-collection
  linearizability, with `log/<seq>` create as the commit point;
- cross-collection ordering and multi-collection atomicity are not part of
  the protocol; and
- the causal checker is a verification technique inherited from mps3, not
  a primary live protocol mechanism claimed here.

## Historical Mechanism: Two-Phase Server-`Date` Fence

The previous provisional disclosure emphasized a two-phase fence: first
CAS a writer epoch, harvest the storage server's `Date` response, then CAS
the record again to back-stamp that server-derived timestamp.

That is not the live production commit path. ADR-008 removed the
post-commit fence verify. `writer_fence` remains in the `current.json`
schema and is written inert at bootstrap and on `admin restore --force`,
but no production commit path acts on its value.

Use the source and adversarial-model docs as historical context. Do not
present the fence as current production correctness unless separately
analyzing the earlier provisional disclosure.

## Practical Framing

Lead with the live, narrow mechanisms:

1. **Single-create numbered-log commit with same-writer lost-ack adoption.**
   The `log/<seq>.json` create is the commit; `current.json` is off the
   ordinary commit path; adoption is allowed only for the same session,
   same sequence, and same full entry.
2. **Crash-safe index emission around the commit.** Additive markers before
   commit, stale deletes after commit, read-path refiltering. Crashes may
   leave false positives, not missing committed rows.
3. **Write-triggered bounded maintenance with pure reads.** Compaction and
   GC run from writes under host profiles. Reads do not perform
   maintenance. GC cost can scale with live log length, so do not describe
   it as a universal fixed-operation bound.
4. **Backend conditional-write probing.** The bucket can be tested for the
   exact conditional-write behavior the commit protocol needs.
5. **Dense forward-probe tail discovery.** Writers fill the first empty
   sequence and readers stop at the first missing sequence.
6. **Opaque `/v1/since` cursor with integer-`seq` recovery.** Keep this
   focused on the cursor contract, not on broad descending-key encoding.

Avoid broad claims around:

- S3 conditional writes as platform primitives;
- "S3-backed datastore" as a category;
- content-addressed bodies alone;
- descending-key encodings generally or the inherited mps3 encoding
  primitives specifically;
- the inherited causal-consistency checker as a primary runtime mechanism;
- the idle-reader Class-A cost bound as a standalone method; and
- the dormant server-`Date` writer fence as current production behavior.
