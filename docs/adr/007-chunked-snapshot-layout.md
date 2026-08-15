---
title: Incarnation-scoped chunked snapshot layout
audience: adr
doc_type: adr
summary: ADR 007 — the next snapshot layout is one strict manifest over immutable, incarnation-scoped, content-authenticated chunks, activated through one pre-1.0 atomic format cut.
last-reviewed: 2026-08-14
tags: [decision, adr, snapshot, storage-layout, versioning]
related:
  [
    README.md,
    002-ephemeral-coordination.md,
    003-layout-versioning-cordon.md,
    "../contributing/conventions/versioning.md",
    "../spec/sync-protocol.md",
  ]
---

# 007 — Incarnation-scoped chunked snapshot layout

## Status

Accepted (2026-08-14); activation is deferred to the atomic format cut. The
live version matrix and production layout remain unchanged until that cut.

## Context

The current snapshot is one content-addressed JSON object containing every
document. A fold must load, sort, and encode the complete collection even when
its selected log prefix changes one narrow ID range. That whole-collection work
sets the present maintenance ceiling on request-bounded runtimes. Splitting the
body can make work local, but only if ordering, publication, reuse, integrity,
and garbage collection compose without a coordinator, a second reader, or an
orphan key that can later become live again.

The change is also a real bucket-layout break under
[ADR-003](003-layout-versioning-cordon.md), not an additive field on the old
snapshot. Pre-1.0 versioning permits the break in a minor release, but the
runtime still needs one unambiguous layout and one supported upgrade boundary.

## Decision

Adopt one strict, incarnation-scoped, content-authenticated chunked snapshot
layout and activate it through one pre-1.0 minor format cut. The exact decision
is fixed below so it remains durable before the field-level contract becomes a
shipped protocol spec.

### Wire, ordering, and canonical bytes

The manifest and descriptor wire is:

```ts
interface SnapshotManifest {
  readonly schema_version: number;
  readonly collection: string;
  readonly log_seq_start: number;
  readonly incarnation: string;
  readonly collation: "utf8-scalar-v1";
  readonly chunks: readonly SnapshotChunkDescriptor[];
}

interface SnapshotChunkDescriptor {
  readonly first_id: string;
  readonly last_id: string;
  readonly key: string;
  readonly byte_length: number;
  readonly row_count: number;
}
```

The chunk wire is:

```ts
interface SnapshotChunk {
  readonly schema_version: number;
  readonly collection: string;
  readonly incarnation: string;
  readonly first_id: string;
  readonly last_id: string;
  readonly docs: readonly DocumentData[];
}
```

Both bodies use `schema_version: 2`. Manifest `log_seq_start` is a non-negative
safe integer equal to the published `current.json.log_seq_start`.
`incarnation` is 32 lowercase hex characters, and `collation` is exactly
`utf8-scalar-v1`. Manifests contain at most 32 descriptors and encode to at
most 64 KiB. Descriptors have positive safe-integer byte and row counts bounded
respectively by 1 MiB and 4,096 rows, strictly increasing non-overlapping
ranges, and unique valid chunk keys; gaps are valid. An empty collection has no
descriptors. A chunk is never empty, has at most 4,096 rows and 1 MiB of
canonical bytes, and exactly matches its descriptor's range, count, and byte
length.

Document IDs are Unicode scalar-value strings satisfying the current path
rules. `utf8-scalar-v1` compares their UTF-8 bytes lexicographically, with a
proper prefix first. NFC and NFD remain distinct. Descriptors and documents are
strictly increasing under that one comparator. Each document is an object
whose own top-level `_id` is its sole identity; an insert/update post-image
requires `after._id === doc_id`. Stored `DocumentData` follows the existing
`DocumentValue` domain: nested values may be objects, arrays, strings, finite
numbers, or booleans, but not `null`. Caller document values containing
`null` fail with `InvalidConfig`; stored document values containing `null` fail
with `InvalidResponse`. JSON Merge Patch `null` remains deletion syntax and is
removed while constructing a post-image; it is never a stored document value.

Canonical bytes are compact `encodeJsonBytes` UTF-8 with the envelope fields in
the declared order and recursively deterministic document-member order. A
strict decoder validates the complete structure, canonicalizes and re-encodes
it, and requires byte equality. Malformed UTF-8, JSON, escapes, scalars,
integers, fields, duplicates, order, ranges, counts, lengths, truncation, or
hashes fail closed before returning data. Stored-data failures, including a
missing referenced artifact, use `InvalidResponse`; equivalent caller-ingress
failures use `InvalidConfig`.

Manifest validation is deliberately separate from chunk-body validation. The
manifest key, hash, canonical bytes, exact fields, descriptor ordering, and all
manifest ceilings are validated before any descriptor is trusted. After that
authentication, descriptor ranges, counts, byte lengths, and keys are
authoritative for routing, gap detection, snapshot totals, and fan-out. A body
is fetched only when selected by that metadata. Each fetched body must then
pass its own key, hash, canonical, collection, incarnation, row-order, and
ceiling checks and agree exactly with its descriptor's first ID, last ID, row
count, and canonical byte length. Publisher and pure-builder tests prove that
every emitted descriptor agrees with its body. A miss need not fetch an
unrelated body, so corruption in an unfetched body is found on its first fetch,
a complete scan, or `fsck`, not before descriptor routing.

### Keys, reuse, and publication

Given collection prefix `P`, the only artifact keys are:

```text
P/_v2/snapshot/chunks/<incarnation>/sha256/<digest>.json
P/_v2/snapshot/manifests/<incarnation>/sha256/<digest>.json
```

The digest is 64 lowercase hex characters and is the full SHA-256 of the exact
body. Each attempt mints a fresh 128-bit incarnation after capturing and
strictly validating its head and manifest. Concurrent attempts, process
restarts, new invocations, and retries after a head conflict mint different
incarnations; a retry within one in-memory storage call retains its key and
bytes.

Chunk and manifest PUTs are immutable create-only writes. A create conflict is
adopted only after the exact key returns byte-identical content. A new manifest
may reuse only a byte-identical descriptor reachable from the captured
manifest; LIST results, older manifests, cached descriptors, and matching
hashes confer no reuse authority. Fresh chunks use the new incarnation.
Consequently, an unreachable artifact key can never be published again.

The durable journal is exactly:

```text
PUT changed immutable chunks
PUT immutable manifest
validate the complete current.json transition
PUT current.json with If-Match
```

Reused descriptors cause no chunk PUT. Every referenced chunk exists before
the manifest PUT, no referenced object is written after the head CAS, and a CAS
loser leaves only authenticated unreachable objects.

Artifact GC retains the existing seven-day minimum grace
(`604_800_000` milliseconds), while one publication attempt has a static
one-hour maximum lifetime (`3_600_000` milliseconds) measured from before its
first artifact PUT (the first changed chunk, or the manifest when no chunk is
written). The publisher checks the deadline before and after every artifact PUT
and again before the head CAS. If the deadline expires before the manifest or
head is published, the attempt abandons its unreachable artifacts, rereads the
head, and restarts with a new incarnation. It never resumes the old
incarnation. A storage call that crosses the deadline may finish, but no later
publication phase may begin.

This proof depends only on a monotonic elapsed-time source that covers awaits
within the attempt. Tests inject that clock. A host that resumes execution
without being able to prove both monotonic continuity and an age below one hour
must treat the attempt as expired and restart; wall-clock adjustment or host
suspension cannot extend the proof window. This is an integration assumption,
not a new durable object: the four-phase journal above is unchanged, and the
one-hour limit remains strictly shorter than artifact grace on every host.

### Deterministic chunk policy and work bounds

The finite benchmark-only candidates are:

| Candidate | Target bytes | Target rows |
| --- | ---: | ---: |
| `c128-r512` | 128 KiB | 512 |
| `c512-r2048` | 512 KiB | 2,048 |
| `c1024-r4096` | 1 MiB | 4,096 |

All share the 1 MiB / 4,096-row hard maximum. The deployed study selects one
production pair before activation and reruns without a selector; no runtime,
environment, adapter, collection, or host-specific policy knob exists.

The pure builder/evaluator is defined before prefix selection and performs no
storage I/O. Given captured descriptors, an already loaded bounded chunk set,
a collapsed mutation prefix, an injected incarnation, and the selected policy,
it produces exact encoded chunks, a complete descriptor array, exact work
accounting, and no publication. Final mutations are sorted by
`utf8-scalar-v1` and assigned to containing descriptors. A gap insert uses the
predecessor, or the first successor when no predecessor exists; a gap delete is
a no-op. Each directly touched chunk is rebuilt independently.

A changed group splits greedily at the longest non-empty prefix within both
target thresholds. One document over a target becomes a singleton when its
exact chunk fits the hard maximum; otherwise publication fails explicitly as
oversized. An output is underfull only when both bytes and rows are strictly
below half the selected targets. At most once per pass, the leftmost underfull
output may inspect its preselected captured neighbor: the immediate right of
the leftmost directly touched captured descriptor, or its immediate left when
no right descriptor exists. It merges only when the exact result fits both
targets. It does not try the other side, redistribute, recurse, or move later
untouched boundaries.

Prefix planning is an implementable two-phase pure algorithm:

1. The metadata phase walks log entries in sequence. It maintains final
   last-write-wins mutations and stops before the first entry that would exceed
   `max_log_entries`, 1 MiB of final mutation bytes, eight distinct directly
   touched descriptors, or 2 MiB of authenticated declared bytes across the
   union of those descriptors and one optional neighbor. Insert/update bytes
   are the exact canonical bytes of each final post-image; a routed delete is
   the UTF-8 byte length of its ID; replacing an earlier mutation for the same
   ID first removes its contribution. Gap deletes contribute zero and cause no
   touch. Once the first directly touched captured descriptor fixes the
   neighbor slot (immediate right, else left), that index stays fixed. The
   window ends before an entry would introduce an earlier directly touched
   descriptor and thereby change neighbor ownership.
2. The metadata result carries the candidate sequence endpoints, unique direct
   and prefetch chunk indexes, `touched_bytes` as the exact sum of their
   authenticated descriptor byte lengths counted once, and
   `selected_neighbor_chunk_index` or `null`. Integration fetches only that
   bounded set. The prefetch set may include chunks needed only by a later
   candidate endpoint, but may never include another neighbor.
3. The exact phase evaluates candidate endpoints in sequence by dry-running
   the already-defined builder on the loaded subset for that endpoint. A split
   increment is `max(0, output_chunk_count - 1)` for each directly rewritten
   source group, measured after greedy splitting and before the optional merge;
   deleting a group and creating the first chunk in an empty collection each
   count zero. Neighbor use is one only when the builder consumes the selected
   otherwise-untouched neighbor body to inspect or merge it. Selection stops
   before the first endpoint whose exact total exceeds four split increments or
   one neighbor.
4. The returned plan recomputes its mutations, directly touched indexes and
   ranges, exact mutation bytes, split increments, neighbor use, and builder
   output solely from entries through its final `log_seq_end`. Bounded prefetch
   metadata may describe suffix candidates, but those entries cannot influence
   the returned logical or artifact output. Planner properties append arbitrary
   suffixes and prove this non-interference. No phase reads elapsed time.

`ChunkedFoldBudget` therefore includes `max_touched_bytes` in addition to the
entry, mutation, direct-chunk, split-increment, and neighbor caps. The plan's
prefetch state owns `touched_bytes` and the optional selected neighbor index;
the final-prefix state separately owns exact accounted mutation bytes, direct
touched indexes, split increments, and actual neighbor use. Builder/evaluator
tests prove these fields before exact prefix selection is implemented, avoiding
a planner that must perform unbounded or circular reads.

The first individually admissible mutation must fit alone. Publication refuses
more than 32 descriptors. Crossing any static bound is a graduation signal,
not a configuration prompt.

### Totals, reads, and artifact GC

`current.json.snapshot_bytes` is the sum of every live descriptor's
`byte_length`; it excludes the manifest and control/log bytes.
`current.json.snapshot_rows` is the sum of `row_count`. Both are zero for an
empty manifest. These totals use the authenticated manifest descriptors; they
do not force a complete chunk scan. Manifest bytes, descriptors,
touched/rewritten chunks, scanned and encoded bytes, and decoded IDs remain
separate work metrics.

The head-aware caller passes the captured `current.json.log_seq_start` as a
required expected floor when opening a snapshot view. A non-null snapshot
performs one manifest GET and rejects a different manifest floor before
routing. A null manifest pointer represents the empty captured base but still
requires that expected floor, preserving ownership of sequence coverage at the
head/view boundary.

Chunk GET fan-out is at most one for point reads, eight for bounded ranges, 32
for general index-routed reads, and 32 for complete reads. A single-ID index
resolution still fetches at most one chunk. A general existing-index query
first collects candidate IDs, maps them through the authenticated descriptors,
and fetches each distinct candidate chunk at most once; up to the descriptor
ceiling it remains index-routed. A range intersecting more than eight
descriptors is classified as complete. Point and range misses fetch no
unrelated body, empty manifests fetch no chunks, and reads are pure: they never
publish, repair, delete, or tick maintenance.

Artifact GC is admitted only with executable proofs that:

- the one-hour attempt deadline and seven-day minimum grace protect every
  changed-chunk and manifest PUT through its head CAS, and an expired or
  unprovably aged attempt cannot resume its incarnation;
- a CAS loser cannot make a winner-reachable chunk collectible;
- every reused descriptor was reachable from the captured manifest and stays
  reachable through each manifest that reuses it;
- immediately before a bounded DELETE batch, a fresh strict head and manifest
  remove their own keys and every live descriptor key from the batch;
- a key proven unreachable by that fresh view cannot later be republished;
- chunk PUT, concurrent GC work, manifest PUT, and head CAS cannot publish a
  missing chunk;
- missing, corrupt, unsupported, stale-pending, or unclassifiable data never
  authorizes deletion of a possibly live key; and
- bounded discovery fairly revisits both artifact prefixes through LIST
  pagination, live windows, and pending backpressure, and converges on repeated
  write ticks without a scheduler.

The exact filename grammar classifies candidates but never establishes
liveness. Only the fresh strict head-and-manifest view establishes liveness.

### Activation, upgrade, and public exports

The atomic pre-1.0 minor cut proposes snapshot schema 2,
`CURRENT_JSON_SCHEMA_VERSION = 4`, and required `layout_version: 2`. It changes
every producer, reader, CLI consumer, restore path, integrity tool, and
artifact-GC path together and intentionally rejects absent/layout-1 state. The
supported upgrade is an old-release logical dump restored by the new release
into an empty layout-2 bucket. Restore validates the scalar-ID, non-null
`DocumentValue`, and document-size domains; a dump containing stored JSON
`null` document values must be remediated first. Merge-patch deletion markers
are operation syntax rather than dump values. The immutable fold-stage0 corpus
and its hashes remain byte-for-byte historical rejection evidence; a separate
old-release dump fixture proves the supported restore path. The live version
matrix does not change until activation.

This ADR explicitly amends item 3 of [ADR-003](003-layout-versioning-cordon.md):
layout 2 activates the formerly deferred axis as a required field in
`current.json` schema 4 instead of an additive-optional field defaulting to 1.
ADR-003's reserved namespace, per-artifact schema rules, no-upcaster rule, and
operator-burden constraint remain in force.

At the cut, remove `SnapshotBody`, `encodeSnapshotBody()`, and `snapshotKey()`
from the public barrel because they can only manufacture the rejected
monolithic format. Keep
`loadSnapshotAsMap(storage, key, expectedCollection, signal?)` with its current
signature as a direct-artifact materializing wrapper over the same strict
manifest/chunk decoders; it never retains a legacy parser. That helper does not
claim that a manifest covers a captured head. Production head-aware callers
use the internal view input with required expected `log_seq_start` ownership.

This ADR is the required supersession record and narrowly overrides the public
API deprecation lifecycle for those three construction symbols: keeping them
working through the cut would retain a public path to artifacts the only
supported runtime must reject, while adapting their signatures would be a
different breaking capability. The ordinary lifecycle remains unchanged for
every other public capability. The removal and wrapper behavior are called out
in the minor changeset and upgrade note.

## Closed Paths

- **Dual readers, dual publication, compatibility wrappers, feature flags, and
  runtime migration modes.** They turn one deliberate pre-1.0 cut into a
  permanent matrix of partially migrated buckets.
- **Online transcoding, auto-migration, and repair-on-read.** Upgrade is a
  logical dump into an empty bucket; reads never publish or maintain data.
- **Read-side maintenance.** Reads remain pure and never publish chunks,
  manifests, repairs, or GC progress.
- **Mutable chunks or manifests.** Every artifact is create-only and content-
  authenticated before the head CAS.
- **Global or historical content deduplication.** Reuse comes only from the
  captured live manifest; content equality alone does not authorize a key.
- **Runtime chunk tuning or host-specific layout.** Benchmark candidates are
  compile-time study subjects, and activation selects one protocol policy for
  every host.
- **Recursive rebalancing or unbounded neighbors.** Local rewrites do not shift
  every later boundary, and one fold inspects at most one deterministic
  neighbor.
- **Orphan republishing.** Fresh incarnations plus captured-live-only reuse make
  once-unreachable keys permanently ineligible for publication.

## Consequences

Fold body work can become proportional to bounded changed ranges rather than
the complete collection, while the numbered-log commit point and request-
bounded coordination model remain unchanged. Point and bounded-range reads can
avoid unrelated chunk bodies; complete reads pay one manifest plus a statically
bounded chunk fan-out.

The cost is a breaking stored layout and three removed public construction
exports. Activation requires coordinated snapshot/current schema changes, a
real layout-axis update, strict consumer integration, artifact-GC crash proofs,
a pre-1.0 minor changeset, and an explicit upgrade note. Collections outside
the scalar-ID, non-null `DocumentValue`, object-size, descriptor, or
bounded-work envelope must be remediated or treated as graduation cases rather
than handled by a runtime knob.

## Live Owner

Until activation, this ADR is the durable owner of the accepted layout
decision; the shipped contract remains
[`docs/spec/sync-protocol.md`](../spec/sync-protocol.md) and the live version
axes remain in
[`docs/contributing/conventions/versioning.md`](../contributing/conventions/versioning.md).
The atomic cut must move the field-level layout contract into those tracked
owners while updating every production consumer and the version matrix
together.
