---
title: How it works
audience: integrator
summary: The plain-language mental model — a bucket of files plus a library that commits by creating the next numbered log entry with a conditional write, and the typed layers from protocol to React.
last-reviewed: 2026-06-22
tags: [concepts, mental-model, protocol]
related: [thesis.md, "../spec/sync-protocol.md", "../contributing/architecture.md"]
---

# How it works

This page bridges the [product thesis](thesis.md) (the _why_) and the formal
[protocol spec](../spec/sync-protocol.md) (the precise _what_). It
explains the one trick the rest of the system follows from: a bucket
cannot run a database server, but it can atomically create one object.

## The one idea to anchor on

**There is no database server coordinating state.** The "database" is a
pile of files (objects) in an S3 bucket. `baerly-storage` is a
_library_: a set of rules for how to lay out those files and how to
change them safely. When your code "talks to the database," it is doing
`GET` and `PUT` on objects in a bucket and nothing more.

baerly-storage runs wherever the bucket credentials safely live, usually
a Worker, Node server, or server function. That handler is trusted app
code: it checks auth, validates writes, and applies the baerly-storage
rules to the bucket. The bucket is the durable state. When the request
ends, baerly-storage is gone. The bucket remains.

So the real question is: _how do you get database behavior out of
object storage?_ The answer is to make the commit path's coordination
feature, atomic create-if-absent, carry the commit.

## What's in the bucket

A bucket cannot answer "what rows exist?" by itself. It can only store
objects. baerly-storage gets database behavior by making some objects
immutable evidence, then replaying that evidence in order.

A collection is the table-like unit you query. Its prefix is that
collection's key namespace in the bucket. The prefix contains these
objects:

- **A content object** — the actual row data (`{ body: "buy milk" }`),
  stored under a content-addressed key (a hash of its bytes).
- **Numbered log entries** — tiny append-only records: "at this point,
  this row was inserted." The log uses `log/0`, `log/1`, and so on. The
  _tail_ is the first missing number after the committed entries.
- **A snapshot object** — a rolled-up copy of older history, created by
  maintenance so reads do not have to replay the whole log forever.
- **Index objects** — small marker files that make lookups fast, so a
  read doesn't have to scan everything.
- **`current.json`** — a per-collection _compaction bookmark_. It is
  **not** the authority on the collection's state. It names the current
  snapshot, records how far the log has been folded into that snapshot
  (`log_seq_start`), and carries a `tail_hint`: a lower-bound starting
  point for finding the log's live tail.

Only one of those objects decides history: the append-only **log is the
source of truth.** Every collection has its own `current.json`, its own
numbered log entries, and its own place where competing writes
coordinate: the tail of that log. To know what a collection _is_ right
now, you read that collection's `current.json`, load the snapshot it
names, then replay the log entries after it. If `tail_hint` is behind,
the reader probes forward until it finds the first missing log entry.
Index objects can narrow the read, but the snapshot plus log decide the
visible rows.

That per-collection log has a corollary worth stating plainly: a write
commits to exactly one collection's log. Writes to two different
collections are independent: neither ordered nor atomic with respect to
each other. Each collection has its own single total order; there is no
cross-collection transaction. Needing two collections to commit together
is a signal you've outgrown the model (the formal statement is in
[`spec/sync-protocol.md`](../spec/sync-protocol.md)).

## What a write does

A write has three phases: prepare the objects readers will need, commit
with one conditional log create, then clean up old lookup markers. Say
you insert or update a row. The library does this, in order:

1. **PUT the content** — write the row's bytes as a new object.
2. **PUT the new index markers** — write the lookup markers that point
   at this row, _before_ committing, so a committed row is always
   findable.
3. **Create the next numbered log entry** — `PUT log/<seq>` with a
   conditional _"only if it doesn't exist yet."_ **This create is the
   commit.** The instant it wins, the row is part of the database.
4. **Delete now-stale index markers, if any** — for an update, remove
   the markers for the value this write superseded, _after_ committing,
   so a crash can never de-index a committed row.

Steps 1 and 2 do not change the visible database state; they are
preparation. The database changes at step 3, the instant the log-entry
create wins. There is no later `current.json` pointer swap that makes
the write real. Step 4 is cleanup for the old value's markers.

## The part that makes it safe

The hard part is choosing the next number when two writers race for the
same collection. S3 has one feature that saves us: a **conditional
PUT**. Here it is used as
_create-if-absent_: "write `log/<seq>` _only if_ that sequence number
isn't already taken."

So the commit really means:

> "Create the log entry at sequence N, **but only if** sequence N
> doesn't exist yet."

- The slot is free → the create succeeds, and that is the commit. Done.
- Someone already claimed sequence N → the conditional PUT is
  **rejected**. The library reads that entry back. If it is this
  writer's own commit whose success response was lost, it adopts it as
  already committed. That adoption requires the same session, the same
  sequence number, and matching entry intent. If the entry belongs to
  another writer, the loser runs a bounded forward-probe from N + 1,
  mints a log entry for the next empty slot, and tries there.

That retry loop is the entire concurrency story. No locks, no
coordinator, no server holding state: S3's atomic conditional-write is
the coordination.

**Retries can't duplicate committed rows.** Content keys are hashes, so
re-writing the same final row bytes is a harmless no-op. Log entries are
created with "only if absent"; if a writer retries after it already won
its log create but lost the acknowledgement, the read-back step
recognizes that entry by the unique session carried in that commit and
by the matching sequence and intent, then adopts it as already
committed. A _different_ writer's entry at that sequence is a conflict,
not a duplicate: the loser probes forward.

The same structure handles stale writers. A writer that paused for a
long time either finds its target sequence already taken and probes
forward, or appends at the true current tail. It can never overwrite a
committed entry, because log entries are immutable, append-only, and
create-if-absent. The formal version of all of this — the write and read
algorithms, the dormant `writer_fence`, and the causal-consistency
guarantees — lives in
[`spec/sync-protocol.md`](../spec/sync-protocol.md), with the
adversarial fencing model in
[`spec/writer-fence-adversarial-model.md`](../spec/writer-fence-adversarial-model.md).

## What a read does

On the server side, a read does not consult any resident database
process for the current state. The trusted handler rebuilds that state
from committed bucket objects:

1. Read `current.json` (the snapshot pointer plus `tail_hint`).
2. Load the _snapshot_ it names: a single object holding the rolled-up
   state before `log_seq_start`.
3. Replay the log entries added since, folding inserts, updates, and
   deletes on top. The reader runs a bounded forward-probe from
   `tail_hint`, reading `log/<seq>`, `log/<seq+1>`, … and **stops at the
   first sequence that's missing**. That gap is the true tail.
4. Hand back the data.

Each log entry is immutable and exists only once it has committed, so a
reader always sees a consistent committed _prefix_ of the history — never
a half-finished write. A write that's still in flight is not visible
yet; it becomes visible the moment its log-entry create wins.

## What about the ever-growing log?

Two questions fall out of the model so far: if the log is append-only,
doesn't it grow without bound? And what happens to the objects a writer
already PUT when it crashes _before_ its log-entry create commits?

Both are handled by **maintenance**, which is two jobs:

- **Compaction** folds a run of log entries into a fresh snapshot and
  advances `current.json` to point at it — so a read replays a short
  tail instead of the entire history. The old log entries become
  unreferenced.
- **Garbage collection** sweeps objects nothing points to anymore:
  superseded snapshots, compacted-away log entries, and orphaned
  content from a crashed write. GC deletes wait through a grace window
  so a retrying writer can still recognize its earlier attempt. Orphaned
  index markers are different: they are tolerated false positives during
  reads and can be repaired by `rebuildIndex`.

Crashes fall on one side of the commit line. A crash before the log
create leaves ignored objects for GC. A crash after the log create
leaves a committed entry that future writers can pass. Because there is
no separate `current.json` swap to crash between, a write cannot wedge
the tail and block all future writes to the collection. The formal
version lives in
[`spec/sync-protocol.md`](../spec/sync-protocol.md#crash-safety).

Here is the consequence for the runtime model: **maintenance is not a
daemon.** There is no cron job, no sidecar, no background process. A
write checks whether the live log ratio or GC cadence says work is due;
when that check trips, bounded compaction or GC piggybacks on that
write. Cloudflare can finish the chunk after the response with
`ctx.waitUntil`; Node runs it inline and may run both phases in one
tick. **Reads are pure: they never run maintenance.** An idle bucket
does nothing and pays nothing. Teams that _want_ batched maintenance
windows can call `runScheduledMaintenance` from their own scheduler, but
it is an opt-in convenience, never a requirement. The design precedent
is PostgreSQL's HOT pruning / autovacuum; the full rationale is in
[`thesis.md`](thesis.md) → "Runtime model: nothing resident between
requests."

## Where the types and schema fit

The storage protocol decides when bytes become committed. The schema
decides which bytes are allowed to get that far.

Your `baerly.config.ts` declares the collections and, optionally, a
Standard Schema v1 validator for each. The scaffolds use Zod, but the
API accepts any Standard Schema v1 implementation. That one file does
two jobs from a single definition:

- **At write time**, the server runs the schema as a validator — bad
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

The roles are: protocol names the actions, server executes them against
the bucket, router translates HTTP, client calls the router, and React
binds the client to rendering.

```
       collection("notes").insert({ body })
                       │
   ┌───────────────────┴───────────────────┐
   │ CLIENT exposes the HTTP API           │  encode
   │   → POST /v1/c/notes  { doc }         │ ─────────►  the wire
   └───────────────────────────────────────┘
                                                  │
   ┌───────────────────────────────────────┐      │ decode
   │ ROUTER reads the request,             │ ◄────┘
   │   calls the real action               │
   └──────────────────┬────────────────────┘
                      │
   ┌──────────────────▼───────────────────┐
   │ SERVER implements the interface      │
   │   → PUT content / log / index        │
   │   → create log/<seq> (the commit)    │
   └──────────────────┬───────────────────┘
                      ▼
                  S3 bucket
```

Reading that chain top to bottom:

- **The protocol defines the actions as types.** A typed menu —
  `insert`, `update`, `where`, `order`, `first`, `all` — with no
  implementation. Just the shapes.
- **The server implements that menu against S3.** This is the write
  dance above: it turns `insert(...)` into the
  PUT-then-create-the-log-entry sequence (the create-if-absent commit).
- **The HTTP router translates the wire.** It decodes the request, calls
  the server action, and serializes the result back. It holds no
  storage-protocol decision logic of its own.
- **The client exposes the client-side API over HTTP.** It keeps the
  same row types and query vocabulary for client-safe operations, but it
  does not touch the bucket and is not the full server protocol surface.
  Its backend is the server.
- **The React bindings add reactivity, not new actions.** `useQuery`
  / `useMutation` / `BaerlyProvider` _call_ the client and wrap those
  calls in React's render model — live subscriptions that re-render
  when the data changes, plus loading/error state. Database semantics
  stay in the client/server protocol.

For the precise module graph and the full line-by-line lifecycle of
`db.collection(...).insert()`, see
[`contributing/architecture.md`](../contributing/architecture.md). A
runnable end-to-end example of every layer is
[`examples/react-node`](../../examples/react-node).

## Say it in one breath

> It's not a database server — it's a bucket of files plus a library
> that knows how to arrange them. Writing means dropping new immutable
> objects in the bucket and then atomically creating the next numbered
> log entry for that collection — using S3's create-if-absent so two
> writers can't claim the same slot; a loser retries at the next slot.
> Reading means following `current.json` to the snapshot and log.
> The schema in your config validates every write and gives you your
> types. The protocol defines the actions once; the server fulfills them
> against the bucket, and the client exposes the HTTP version for app
> code. No server is coordinating any of it — the bucket's atomic
> conditional-write is the coordination.

## Next

- **Build something** — the [cheat sheet](../guide/cheatsheet.md) is the
  one-screen API; the full surface is `dist/API.md`.
- **Run it in production** — the
  [operations runbook](../guide/operations.md).
- **Know when to leave** — [graduation](graduation.md): the bounds that
  tell you a collection has outgrown this tier.
