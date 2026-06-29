---
title: How it works
audience: integrator
summary: Plain-language mental model for committing by conditional log create, then exposing typed layers from protocol to React.
last-reviewed: 2026-06-28
tags: [concepts, mental-model, protocol]
related: [thesis.md, "../spec/sync-protocol.md", "../architecture.md"]
---

# How it works

This page bridges the [product thesis](thesis.md) (the _why_) and the
formal [protocol spec](../spec/sync-protocol.md) (the precise _what_).
The threshold concept is small: a bucket cannot run a database server,
but a bucket with the required conditional-write behavior can atomically
create one named object.

## The one idea to anchor on

**A write commits by creating one numbered log object.** If the next
empty slot is `log/17.json`, the writer commits by creating
`log/17.json` with **create-if-absent**: "write this object only if no
object with this name exists yet" (S3's `If-None-Match: "*"`). It does
not make the write official by updating a database row, taking a lock,
asking a catalog service, or publishing a separate "latest log number"
object.

There is no database server coordinating state. The "database" is named
objects in an AWS S3 or Cloudflare R2 bucket; other S3-compatible
endpoints require the live conditional-write probe first.
`baerly-storage` knows the bucket layout and the rules for changing it.

baerly-storage runs wherever the bucket credentials safely live. The
shipped targets today are Cloudflare Workers and Node servers; future
server-function adapters use the same bucket protocol. The trusted
handler checks auth, validates writes, and applies the protocol rules.
The bucket is the durable shared state. When the request ends, in-memory
library state is gone; the bucket remains.

The commit point is that conditional create on the next log entry, not a
lock, server process, or `current.json` pointer update.

## What's in the bucket

A bucket stores named objects, not row sets. baerly-storage gets database
behavior by writing durable evidence and replaying it in order.

A collection is the table-like unit you query. Its prefix is that
collection's key namespace in the bucket. Inside that prefix:

| Object | Role |
| --- | --- |
| Content objects | Row bytes, such as `{ body: "buy milk" }`, stored under a content-addressed key (a hash of the bytes). |
| Numbered log entries | Append-only records: "at this sequence, this row was inserted, updated, or deleted." The log uses `log/0.json`, `log/1.json`, and so on. The _tail_ is the first missing number after committed entries. |
| Snapshot objects | Rolled-up older history, created by maintenance so reads do not replay the whole log forever. |
| Index objects | Small marker files that make lookups fast, so a read does not have to scan everything. |
| `current.json` | A per-collection _compaction bookmark_. It is **not** the authority on the collection's state. It names the current snapshot, records how far the log has been folded into that snapshot (`log_seq_start`), and carries `tail_hint`, a lower-bound starting point for finding the live tail. |

The numbered log decides commit order. A snapshot is a cached fold of old
log entries. `current.json` names the snapshot and gives a probe start;
if `tail_hint` is behind, the reader probes forward to the first missing
log entry. Index objects can narrow the read, but the snapshot plus log
decide the visible rows.

Each collection has its own `current.json`, numbered log, and tail. A
write commits to exactly one collection's log. Writes to two collections
are independent: neither ordered nor atomic with respect to each other.
There is no cross-collection transaction; needing two collections to
commit together means this model is the wrong transaction boundary. The
formal statement is in [`spec/sync-protocol.md`](../spec/sync-protocol.md).

## What a write does

A write prepares the objects readers will need, commits with one
conditional log create, then cleans up old lookup markers. For an insert
or update:

1. **PUT the content**: write the row's bytes as a new object.
2. **PUT the new index markers**: write the lookup markers that point
   at this row, _before_ committing, so a committed row is always
   findable.
3. **Create the next numbered log entry**: `PUT log/<seq>.json` with a
   conditional _"only if it doesn't exist yet."_ **This create is the
   commit.** The instant it wins, the row is part of the database.
4. **Delete now-stale index markers, if any**: for an update, remove
   the markers for the value this write superseded, _after_ committing,
   so a crash can never de-index a committed row.

Steps 1 and 2 are preparation. Step 3 changes the visible database state;
there is no later `current.json` pointer swap. Step 4 cleans up the old
value's markers.

## The part that makes it safe

The hard part is choosing the next number when two writers race for the
same collection. The bucket arbitrates that race with a **conditional
PUT**: create `log/<seq>.json` _only if_ that sequence number is not
already taken.

- The slot is free: the create succeeds, and that is the commit.
- Someone already claimed sequence N: the conditional PUT is
  **rejected**. The library reads that entry back. If it is this
  writer's own commit whose success response was lost, it adopts it as
  already committed. If it belongs to another writer, the loser runs a
  bounded forward-probe from N + 1, mints a log entry for the next empty
  slot, and tries there.

That retry loop is the commit-path concurrency story: no locks, no
coordinator, no server process holding state. The bucket's atomic
conditional write is the coordination.

**A retry of the same commit attempt can't create a duplicate commit.**
Content keys are hashes, so re-writing the same final row bytes is a
harmless no-op. A lost-ack retry adopts the occupied log slot only when
all three checks pass:

- the same per-commit `session`;
- the same `seq`;
- the same full entry (currently a byte-for-byte `LogEntry` text
  comparison).

Here, `session` means one in-memory value for one commit attempt, not a
login, lock, lease, or persistent writer identity. A different writer's
entry at that sequence is a conflict, so the loser probes forward.

The same rule handles stale writers. A writer that paused for a long time
either finds its target sequence taken and probes forward, or appends at
the true current tail. It can never overwrite a committed entry, because
log entries are immutable and create-if-absent.

The formal write and read algorithms, the dormant `writer_fence`, and the
causal-consistency guarantees live in
[`spec/sync-protocol.md`](../spec/sync-protocol.md), with the
adversarial fencing model in
[`spec/writer-fence-adversarial-model.md`](../spec/writer-fence-adversarial-model.md).

## The same playbook as Apache Iceberg

This is not a new trick. Table formats like Apache Iceberg commit by
writing immutable data and then publishing an atomic pointer to it.
baerly-storage uses the same write-immutable-then-publish pattern,
applied to a document database instead of analytics tables — but the
commit point is narrower. Iceberg-style writers prepare new metadata and
atomically swap the table's current-metadata pointer; baerly-storage
commits by creating one numbered log object with create-if-absent, and
there is no metadata pointer to swap (`current.json` is only a
compaction bookmark, not the authority on state). S3's strong
read-after-write consistency and conditional writes (`If-None-Match`
create-if-absent, `If-Match` compare-and-swap) make that publish safe
without a separate coordinator.

Systems like Litestream and Turbopuffer also lean on object storage, but
they ship long-lived replication or query fleets; baerly-storage keeps
the bucket as the only persistent component, with no resident compute
between requests. The full comparison — including where Delta Lake's S3
story splits by engine and backend — is in
[`spec/prior-art.md`](../spec/prior-art.md).

## What a read does

A read does not consult any resident database process. The trusted
handler rebuilds current state from committed bucket objects:

1. Read `current.json` (the snapshot pointer plus `tail_hint`).
2. Load the _snapshot_ it names: a single object holding the rolled-up
   state before `log_seq_start`.
3. Replay log entries from `log_seq_start` onward. To fold a log entry is
   to apply it to the in-memory row map. The reader folds the trusted
   range up to `tail_hint`, then forward-probes from
   `max(log_seq_start, tail_hint)`, reading `log/<seq>.json`,
   `log/<seq+1>.json`, and so on until it reaches the first missing
   sequence. That gap is the true tail for this read.
4. Hand back the data.

Each log entry is immutable and exists only once it has committed, so a
reader always sees a consistent committed _prefix_ of the history, never
a half-finished write. A write that's still in flight is not visible
yet; it becomes visible the moment its log-entry create wins.

## What about the ever-growing log?

The append-only log and pre-commit objects create two cleanup problems:
old history should not make every read longer, and objects from a
pre-commit crash should not live forever. Both are handled by
**maintenance**:

- **Compaction** folds a run of log entries into a fresh snapshot and
  advances `current.json` to point at it, so a read replays a short
  tail instead of the entire history. The old log entries become
  unreferenced.
- **Garbage collection** sweeps objects no live snapshot or log entry
  still references: superseded snapshots, compacted-away log entries, and
  orphaned content from a crashed write. GC deletes wait through a grace
  window so a retrying writer can still find its earlier attempt.
  Orphaned index markers are different: they are tolerated false
  positives during reads and can be repaired by `rebuildIndex`.

Crashes fall on one side of the commit line. A crash before the log
create leaves uncommitted residue: content for GC and index markers that
readers treat as false positives. A crash after the log create leaves a
committed entry that future writers can pass. Because there is no
separate `current.json` swap to crash between, a write cannot wedge the
tail and block all future writes to the collection. The formal version
lives in
[`spec/sync-protocol.md`](../spec/sync-protocol.md#crash-safety).

Maintenance is not a required daemon or scheduler. After a successful
write, the handler may run a bounded compaction or GC slice when the live
log ratio or GC cadence says work is due. Cloudflare can finish the slice
after the response with `ctx.waitUntil`; Node runs it inline and may run
both phases in one tick. **Reads are pure: they never run maintenance.**
An idle bucket runs no handlers, sends no requests, and schedules no
maintenance. Teams that want batched maintenance windows can call
`runScheduledMaintenance` from their own scheduler, but it is an opt-in
convenience, never a requirement. The product boundary is named in
[`thesis.md`](thesis.md); the rationale is in
[ADR-002](../adr/002-ephemeral-coordination.md).

## Where the types and schema fit

The storage protocol decides when bytes become committed. The schema
decides which bytes are allowed to get that far.

Your `baerly.config.ts` declares the collections and, optionally, a
Standard Schema v1 validator for each. The scaffolds use Zod, but the
API accepts any Standard Schema v1 implementation. That one file does
two jobs from a single definition:

- **At write time**, the server runs the schema as a validator: bad
  data is rejected before any object is written.
- **At compile time**, your code derives its row type from the same
  schema (`type Note = z.infer<typeof NoteSchema>`), so the editor
  knows the shape.

Add a field to the schema and it lands in both places at once: the
runtime gate and the static type. Ordinary schema shape changes do not
need DDL or generated SQL migrations; data migrations are still explicit
versioned scripts.

## The typed layers, top to bottom

The actions you call, such as `collection("notes").insert(...)` and
`.where(...).all()`, start from typed protocol shapes. Each runtime
then exposes the part it can safely execute.

| Layer | Role |
| --- | --- |
| Protocol | Defines the typed menu: `insert`, `update`, `where`, `order`, `first`, `all`, and related shapes. It has no implementation. |
| Server | Implements that menu against the bucket: PUT content and index objects, then create `log/<seq>.json` as the commit. |
| HTTP router | Decodes the request, calls the server action, and serializes the result. It holds no storage-protocol decision logic of its own. |
| Client | Exposes the client-safe API over HTTP with the same row types and query vocabulary. It does not touch the bucket and is not the full server protocol surface. |
| React bindings | Add reactivity, loading state, and error state with `useQuery`, `useMutation`, and `BaerlyProvider`. Database semantics stay in the client/server protocol. |

For the precise module graph and the full line-by-line lifecycle of
`db.collection(...).insert()`, see
[`architecture.md`](../architecture.md). A
runnable end-to-end example of every layer is
[`examples/react-node`](../../examples/react-node).

## Next

- **Build something:** the [cheat sheet](../guide/cheatsheet.md) is the
  one-screen API; the full surface is `dist/API.md`.
- **Run it in production:** the
  [operations runbook](../guide/operations.md).
- **Know when to leave:** [graduation](graduation.md): the bounds that
  tell you a collection has outgrown this tier.
