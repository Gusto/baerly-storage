---
title: Prior-art differentiation
audience: spec
summary: IDS-shaped consolidated differentiation against known prior art for the C1, C2, and C3 mechanisms.
last-reviewed: 2026-06-14
tags: [protocol, patent, prior-art]
related: [sync-protocol.md, writer-fence-adversarial-model.md]
---

# Prior-art differentiation

## 1. Scope

This document enumerates known prior art the maintainers consider
relevant to the differentiation of mechanisms described in
`docs/spec/sync-protocol.md`,
`docs/spec/writer-fence-adversarial-model.md`, and the source modules
cross-referenced therein. It is intended as a reference for patent
prosecution and is the IDS-shaped artifact for any subsequent USPTO
filing.

The three mechanisms differentiated below are labelled C1, C2, and
C3:

- **C1** — Two-phase fence-claim with server-`Date`-header
  extraction. Implemented in
  `packages/protocol/src/coordination/current-json.ts`
  (`claimWriter`). The adversarial model lives in
  `docs/spec/writer-fence-adversarial-model.md`.
- **C2** — In-flight log-entry self-adoption after a recoverable
  crash. Implemented in
  `packages/server/src/log-conflict-adoption.ts`
  (`tryAdoptOwnSessionLogEntry`).
- **C3** — Reverse-LIST encoding of log sequence numbers using a
  descending base-32 alphabet so that the storage layer's native
  ascending `LIST` is a cheap descending tail-walk. Implemented in
  `packages/protocol/src/types.ts`; benchmark evidence in
  `bench/lsn-reverse-walk.ts` with the baseline at
  `docs/spec/attachments/lsn-reverse-walk-baseline.json`.

## 2. Apache Iceberg & Delta Lake (manifest-CAS commit family)

Both systems implement a commit protocol in which a writer attempts
to advance a manifest pointer via conditional write; concurrent
losers retry against the new manifest. The pre-existing Iceberg
mention in `docs/spec/sync-protocol.md#prior-art` is the protocol
anchor for this comparison.

Two deltas matter for differentiation:

- **Cost-bound shape.** Iceberg and Delta Lake commit costs are
  O(seconds) and the commit retries tolerate this latency via
  `CommitFailedException` (Iceberg) or analogous conflict exception
  paths (Delta). Baerly's per-collection commit scope targets a much
  smaller per-document key-value workload and publishes a documented
  _"< 1 Class A op / writer / hour"_ cost bound for idle readers (see
  `docs/about/cost-model.md#cost-ceiling` and the end-to-end
  durability gate in `tests/integration/phase5-end-to-end.test.ts`).
- **No server-`Date` capture.** Neither Iceberg nor Delta stamps the
  storage server's HTTP `Date` response header into the commit
  record. Their commit logs carry application-supplied timestamps
  (or no timestamp), and neither protocol issues a _second_
  conditional PUT to durably back-stamp a server-extracted clock.
  This is the distinguishing axis for C1.
- **Delta on S3 is now engine-split.** The _Spark/JVM_ path still
  documents a DynamoDB commit coordinator (or, in Delta 4.x,
  catalog-managed commits; https://delta.io/blog/delta-lake-s3/). The
  _delta-rs_ (Rust) path's **code default switched to lock-free
  conditional PUT** since S3 `If-None-Match` GA (Aug 2024), falling back
  to DynamoDB only when `AWS_S3_LOCKING_PROVIDER=dynamodb` or
  `allow_unsafe_rename` is set (the code is authoritative here — the
  delta-rs published docs still lag and say DynamoDB-by-default). The
  code carries the comment _"Nearly all S3 Object stores support
  conditional put, so we change the default…"_
  (`crates/aws/src/storage.rs`); `crates/core/src/logstore/default_logstore.rs`
  uses `PutMode::Create`. So "Delta needs a DynamoDB lock" is a
  2023-era claim for the OSS Rust path.

CAS-on-a-control-object is therefore now industry consensus, not a
baerly invention. What baerly owns is the _instance_: the
document-shaped, catalog-free, killable-compute application of it — a
per-document KV HEAD with a CDC `seq` log and a _"< 1 Class A op /
writer / hour"_ idle bound, advanced with no external coordination
service and a server-`Date` provenance back-stamp (C1) that no surveyed
system captures.

### Nearest neighbors

- **Boring Catalog** (single-JSON-file Iceberg catalog coordinated
  purely by S3 conditional writes — the _nearest neighbor_ to
  `current.json` itself:
  https://dataengineeringcentral.substack.com/p/what-an-iceberg-catalog-that-works).
  Differentiator: its unit is a table snapshot of Parquet manifests for
  analytic scans, not a per-document KV HEAD with a CDC log.
- **DuckLake** (v1.0, Apr 2026 — SQL database _as_ the lakehouse
  catalog; https://ducklake.select/2026/04/13/ducklake-10/). The
  opposite choice to baerly's "no catalog, the bucket is the catalog" —
  a direct foil that sharpens the no-external-dependency thesis.

## 3. SlateDB (slatedb.io, RFC-0001)

SlateDB is a recent LSM-tree-over-object-storage design. The
RFC-0001 writer protocol uses `PutMode::Create` (semantically
equivalent to S3 `If-None-Match: *`) on per-LSN-shaped SST objects
and a manifest CAS over numbered manifest slots. The writer
protocol enumerates four cases when discovering an SST it did not
expect.

**C2 differentiation.** Scenario 3 of the RFC's four-case writer
protocol — "the conflicting SST has the same `writer_epoch` as
mine" — is explicitly classified as an **illegal state that should
panic**. SlateDB's reasoning is that within a single epoch only one
writer is permitted to allocate that LSN, so observing such a
collision implies an invariant break.

Baerly's `tryAdoptOwnSessionLogEntry`
(`packages/server/src/log-conflict-adoption.ts`) recognises this
exact case as the writer's _own_ prior in-flight commit attempt —
e.g. after a process crash between PUT-log-entry and CAS-current —
and **adopts** the existing entry rather than panicking. The
adoption gate is constrained by the per-commit session identifier,
the matching seq, and the single-input commit shape, so it does not blur
into accepting a foreign writer's entry. This is the citable C2
gap: a system that would panic where baerly recovers.

**C1 differentiation.** SlateDB fences via a `writer_epoch` field
bumped in a single CAS. There is no harvesting of the storage
server's HTTP `Date` header and no second conditional PUT to back-
stamp a server-extracted timestamp.

## 4. mps3 (endpointservices/mps3, MIT, third-party prior art)

mps3 (`docs/sync_protocol.md` in that repository) describes a
two-step write — content + manifest, with a touched change-marker
follow-up — and explicitly uses HTTP `Date` for **client clock
correction**: _"clients use the `Date` header to continuously
correct their clocks"_. Sync-side comparison uses the server-
provided `LastModified` field.

mps3 does **not** issue a second CAS to atomically back-stamp the
storage server's `Date` value into the manifest record. The
`Date` header is consumed transiently on the client to bound clock
skew, not durably captured as a per-claim provenance field via a
second conditional PUT. This is the citable C1 gap.

**Provenance and disclosure note.** mps3 is **third-party MIT OSS**
authored by Tom Larkworthy and Taktile's automated build account
under the `Endpoint Services` copyright (©2023 Endpoint Services).
Eric Baer is not an mps3 contributor; `baerly-storage` is a fork of
the public mps3 repository taken in May 2026 with no prior
arrangement with the upstream author. Under 35 U.S.C. § 102(b)
(AIA), mps3 has been publicly available since **2023-08-20** —
well past the one-year bar — and is listed in this IDS-shaped
catalogue on prior-art grounds regardless of authorship.

## 5. Adjacent S3-leader-election literature

Three further reference points sit adjacent to C1's claim
mechanism:

- **Morling, "Leader Election With S3 Conditional Writes"**
  (`morling.dev/blog/leader-election-with-s3-conditional-writes/`)
  — single-CAS epoch advance on `lock_NNNNN.json`. No server
  timestamp; no second-phase back-stamp.
- **AWS S3 Conditional Writes launch announcement** (Nov 2024) —
  the underlying platform primitive (`If-None-Match: *` and
  `If-Match` on PUT). This is the substrate C1 builds on, not a
  fencing protocol in its own right.
- **RFC 3161 Time-Stamp Protocol** and **draft-thomson-httpapi-
  date-requests** — both treat HTTP `Date` as untrusted by default.
  The Date Requests draft is explicit: _"Clients MUST NOT accept
  the time provided by an arbitrary HTTP server as the basis for
  system-wide time."_

The last point cuts _for_ C1 novelty, not against it. The standard
posture in the literature is to warn against trusting an arbitrary
HTTP server's `Date`. C1's inverse position is narrower and
specific: trust your _own bucket's_ `Date` header — under a
controlled trust relationship the writer already has with that
bucket — as a _provenance_ field, and durably capture it via a
second conditional PUT whose precondition is the etag of the first
PUT. The distinguishing inventive step sits in this two-phase
durable capture, not in any general claim about HTTP-server time.

## 6. Reverse-LIST encoding folklore (C3 acknowledgment)

The descending-key trick for cheap reverse iteration on a
lexicographically-ordered storage layer is folklore that predates
this project:

- **Microsoft Azure Table Storage "Log tail pattern"** — see
  `learn.microsoft.com/en-us/azure/storage/tables/table-storage-design-patterns`.
  Canonical recipe: store `DateTime.MaxValue.Ticks
  - DateTime.UtcNow.Ticks`zero-padded as the`RowKey` so that the
    natural ascending scan yields most-recent-first.
- **HBase folklore** — the `Long.MAX_VALUE - timestamp` row-key
  trick documented across numerous HBase tutorials and operator
  guides for the same purpose.
- **ULID issue #44 (2017)** — feature request for a "descending
  ULID" variant on the upstream ULID spec repository.
- **RocksDB reverse-comparator convention** — the standard
  technique of supplying a reverse comparator to a column family
  rather than re-encoding keys.

This body of folklore **anticipates the C3 encoding** at the
general level of "encode keys so an ascending native LIST is a
descending logical walk." It is acknowledged here in writing.

Any future defensive publication draft should not claim more than the
_residual narrow composition_: the specific combination of descending
base-32 LSN encoding with the per-collection-CAS commit protocol and
the two-phase fence-claim, measured against
`bench/lsn-reverse-walk.ts` and the checked-in baseline under the
baerly-storage cost model. The raw encoding trick is not the claim; the
composition with C1 and the publishable cost bound is.
