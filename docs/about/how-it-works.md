---
title: How it works
audience: integrator
summary: The plain-language mental model for a bucket of objects plus a library that commits by creating the next numbered log entry with a conditional write, then exposes typed layers from protocol to React.
last-reviewed: 2026-06-26
tags: [concepts, mental-model, protocol]
related: [thesis.md, "../spec/sync-protocol.md", "../contributing/architecture.md"]
---

# How it works

This page bridges the [product thesis](thesis.md) (the _why_) and the formal
[protocol spec](../spec/sync-protocol.md) (the precise _what_). It
explains the one idea the rest of the system follows from: a bucket
cannot run a database server, but a bucket with the required
conditional-write behavior can atomically create one object.

## The one idea to anchor on

**A write commits by creating one numbered log object.** There is no
database server coordinating state. The "database" is a set of named
objects in an AWS S3 or Cloudflare R2 bucket; other S3-compatible
endpoints require the live conditional-write probe first.
`baerly-storage` is the library that knows how to lay out and change
those objects.

baerly-storage runs wherever the bucket credentials safely live. The
shipped targets today are Cloudflare Workers and Node servers; future
server-function adapters use the same bucket protocol. That handler is
trusted app code: it checks auth, validates writes, and applies the
protocol rules. The bucket is the durable state. When the request ends,
the in-memory library state is gone. The bucket remains.

The bucket feature that makes this possible is **create-if-absent**:
"write this object only if no object with this name exists yet" (S3's
`If-None-Match: "*"`). The commit point is that conditional create on
the next log entry, not a lock, server process, or `current.json`
pointer update.

## What's in the bucket

A bucket stores named objects; it does not answer "what rows exist?" by
itself. baerly-storage gets database behavior by making some objects
durable evidence, then replaying that evidence in order.

A collection is the table-like unit you query. Its prefix is that
collection's key namespace in the bucket. The prefix contains these
objects:

| Object | Role |
| --- | --- |
| Content objects | Row bytes, such as `{ body: "buy milk" }`, stored under a content-addressed key (a hash of the bytes). |
| Numbered log entries | Append-only records: "at this sequence, this row was inserted." The log uses `log/0.json`, `log/1.json`, and so on. The _tail_ is the first missing number after the committed entries. |
| Snapshot objects | Rolled-up older history, created by maintenance so reads do not replay the whole log forever. |
| Index objects | Small marker files that make lookups fast, so a read does not have to scan everything. |
| `current.json` | A per-collection _compaction bookmark_. It is **not** the authority on the collection's state. It names the current snapshot, records how far the log has been folded into that snapshot (`log_seq_start`), and carries `tail_hint`, a lower-bound starting point for finding the log's live tail. |

The numbered log decides commit order. A snapshot is a cached fold of old
log entries, and `current.json` says which snapshot to use and where the
reader can start looking for newer log entries. If `tail_hint` is behind,
the reader probes forward until it finds the first missing log entry.
Index objects can narrow the read, but the snapshot plus log decide the
visible rows.

Each collection has its own `current.json`, numbered log, and tail. A
write commits to exactly one collection's log. Writes to two collections
are independent: neither ordered nor atomic with respect to each other.
There is no cross-collection transaction; needing two collections to
commit together means this model is the wrong transaction boundary. The
formal statement is in [`spec/sync-protocol.md`](../spec/sync-protocol.md).

## What a write does

A write has three phases: prepare the objects readers will need, commit
with one conditional log create, then clean up old lookup markers. For
an insert or update, the library does this:

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

Steps 1 and 2 do not change the visible database state; they are
preparation. The database changes at step 3, the instant the log-entry
create wins. There is no later `current.json` pointer swap that makes
the write real. Step 4 is cleanup for the old value's markers.

## The part that makes it safe

The hard part is choosing the next number when two writers race for the
same collection. The bucket arbitrates that race with a **conditional
PUT**. Here it is used as create-if-absent: write `log/<seq>.json`
_only if_ that sequence number is not already taken.

So the commit really means:

> "Create the log entry at sequence N, **but only if** sequence N
> doesn't exist yet."

- The slot is free: the create succeeds, and that is the commit.
- Someone already claimed sequence N: the conditional PUT is
  **rejected**. The library reads that entry back. If it is this
  writer's own commit whose success response was lost, it adopts it as
  already committed. If it belongs to another writer, the loser runs a
  bounded forward-probe from N + 1, mints a log entry for the next empty
  slot, and tries there.

That retry loop is the commit-path concurrency story. No locks, no
coordinator, no server process holding state: the bucket's atomic
conditional write is the coordination.

**A retry of the same commit attempt can't create a duplicate commit.**
Content keys are hashes, so re-writing the same final row bytes is a
harmless no-op. Log entries are created with "only if absent"; if a
writer retries after it already won its log create but lost the
acknowledgement, the read-back step adopts the occupant only when it has
the same per-commit `session`, the same `seq`, and the same full entry
(currently a byte-for-byte `LogEntry` text comparison). Here, `session`
means one in-memory value for one commit attempt, not a login, lock,
lease, or persistent writer identity. A different writer's entry at that
sequence is a conflict, so the loser probes forward.

The same structure handles stale writers. A writer that paused for a
long time either finds its target sequence taken and probes forward, or
appends at the true current tail. It can never overwrite a committed
entry, because log entries are immutable and create-if-absent.

The formal write and read algorithms, the dormant `writer_fence`, and the
causal-consistency guarantees live in
[`spec/sync-protocol.md`](../spec/sync-protocol.md), with the
adversarial fencing model in
[`spec/writer-fence-adversarial-model.md`](../spec/writer-fence-adversarial-model.md).

## What a read does

A read does not consult any resident database process. The trusted
handler rebuilds current state from committed bucket objects:

1. Read `current.json` (the snapshot pointer plus `tail_hint`).
2. Load the _snapshot_ it names: a single object holding the rolled-up
   state before `log_seq_start`.
3. Replay log entries from `log_seq_start` onward, folding inserts,
   updates, and deletes on top. The reader folds the trusted range up to
   `tail_hint`, then forward-probes from
   `max(log_seq_start, tail_hint)`, reading `log/<seq>.json`,
   `log/<seq+1>.json`, and so on until it reaches the first missing
   sequence. That gap is the true tail for this read.
4. Hand back the data.

Each log entry is immutable and exists only once it has committed, so a
reader always sees a consistent committed _prefix_ of the history, never
a half-finished write. A write that's still in flight is not visible
yet; it becomes visible the moment its log-entry create wins.

## What about the ever-growing log?

Two questions fall out of the model: if the log is append-only, doesn't
it grow without bound? And what happens to objects written by a handler
that crashes _before_ its log-entry create commits?

Both are handled by **maintenance**, which is two jobs:

- **Compaction** folds a run of log entries into a fresh snapshot and
  advances `current.json` to point at it, so a read replays a short
  tail instead of the entire history. The old log entries become
  unreferenced.
- **Garbage collection** sweeps objects nothing points to anymore:
  superseded snapshots, compacted-away log entries, and orphaned
  content from a crashed write. GC deletes wait through a grace window
  so a retrying writer can still find its earlier attempt. Orphaned
  index markers are different: they are tolerated false positives during
  reads and can be repaired by `rebuildIndex`.

Crashes fall on one side of the commit line. A crash before the log
create leaves ignored objects for GC. A crash after the log create
leaves a committed entry that future writers can pass. Because there is
no separate `current.json` swap to crash between, a write cannot wedge
the tail and block all future writes to the collection. The formal
version lives in
[`spec/sync-protocol.md`](../spec/sync-protocol.md#crash-safety).

Maintenance is not a required daemon or scheduler. After a successful
write, the handler may run a bounded compaction or GC slice when the live
log ratio or GC cadence says work is due. Cloudflare can finish the slice
after the response with `ctx.waitUntil`; Node runs it inline and may run
both phases in one tick. **Reads are pure: they never run maintenance.**
An idle bucket does nothing and pays nothing. Teams that want batched
maintenance windows can call `runScheduledMaintenance` from their own
scheduler, but it is an opt-in convenience, never a requirement. The
thesis compares this to PostgreSQL HOT pruning / autovacuum; the
rationale is in [`thesis.md`](thesis.md) under "Runtime model: nothing
resident between requests."

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
[`contributing/architecture.md`](../contributing/architecture.md). A
runnable end-to-end example of every layer is
[`examples/react-node`](../../examples/react-node).

## Next

- **Build something:** the [cheat sheet](../guide/cheatsheet.md) is the
  one-screen API; the full surface is `dist/API.md`.
- **Run it in production:** the
  [operations runbook](../guide/operations.md).
- **Know when to leave:** [graduation](graduation.md): the bounds that
  tell you a collection has outgrown this tier.
