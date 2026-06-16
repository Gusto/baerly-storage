---
title: How it works
audience: integrator
summary: The plain-language mental model — a bucket of files plus a library that commits by creating the next numbered log entry with a conditional write, and the typed layers from protocol to React.
last-reviewed: 2026-06-15
tags: [concepts, mental-model, protocol]
related: [thesis.md, "../spec/sync-protocol.md", "../contributing/architecture.md"]
---

# How it works

The whole thing in plain language. This is the bridge between the
[product thesis](thesis.md) (the _why_) and the formal
[protocol spec](../spec/sync-protocol.md) (the precise _what_). If
you can explain this page to someone, you understand Baerly.

## The one idea to anchor on

**There is no database server.** The "database" is just a pile of
files (objects) in an S3 bucket. `baerly-storage` is a _library_ — a
set of rules for how to lay out those files and how to change them
safely. Nobody is running a daemon in the middle. When your code
"talks to the database," it is doing `GET` and `PUT` on objects in a
bucket and nothing more.

So the real question is: _how do you get database behavior out of a
dumb bucket?_ That is the entire trick.

## What's in the bucket

When you insert a row, the library does not overwrite one big "table"
file. It writes a few small, separate, immutable objects:

- **A content object** — the actual row data (`{ body: "buy milk" }`),
  stored under a content-addressed key (a hash of its bytes).
- **A log entry** — a tiny append-only record: "at this point, this
  row was inserted." The history.
- **Index objects** — small marker files that make lookups fast, so a
  read doesn't have to scan everything.
- **`current.json`** — a per-collection _compaction bookmark_. It is
  **not** the authority on the collection's state. It names the current
  snapshot, records how far the log has been folded into that snapshot
  (`log_seq_start`), and carries a `tail_hint` — a lower-bound starting
  point for finding the log's live tail.

The append-only **log is the source of truth.** Every collection has its
own `current.json`, its own integer log, and its own commit hotspot — the
tail of its log. To know what a collection _is_ right now, you read that
collection's `current.json`, load the snapshot it names, then replay the
log entries after it — probing forward from `tail_hint` to the live tail.
Index objects can help narrow the read, but the snapshot plus log are the
source of truth.

That per-collection log has a corollary worth stating plainly: a write
commits to exactly one collection's log, so writes that span two different
collections are independent — neither ordered nor atomic with respect to
each other. Each collection linearizes on its own; there is no
cross-collection transaction. Needing two collections to commit together
is a signal you've outgrown the model (the formal statement is in
[`spec/sync-protocol.md`](../spec/sync-protocol.md)).

## What a write does

Say you insert a row. The library does this, in order:

1. **PUT the content** — write the row's bytes as a new object.
2. **PUT the new index markers** — write the lookup markers that point
   at this row, _before_ committing, so a committed row is always
   findable.
3. **Create the next numbered log entry** — `PUT log/<seq>` with a
   conditional _"only if it doesn't exist yet."_ **This create is the
   commit.** The instant it wins, the row is part of the database.
4. **Delete the now-stale index markers** — remove the markers for the
   value this write superseded, _after_ committing, so a crash can never
   de-index a committed row.

Steps 1 and 2 do not change the visible database state; they are
invisible scaffolding until the commit. The database "changes" at step
3, the instant the log-entry create wins — there is no separate pointer
swap. Step 4 just tidies up the old value's markers.

## The part that makes it safe

Step 3 is where two writers at once could clobber each other. S3 has
one feature that saves us: a **conditional PUT** — here, _create-if-absent_:
"write `log/<seq>` _only if_ that sequence number isn't already taken."

So the commit really means:

> "Create the log entry at sequence N, **but only if** sequence N
> doesn't exist yet."

- The slot is free → the create succeeds, and that is the commit. Done.
- Someone already claimed sequence N → the conditional PUT is
  **rejected**. The library notices, re-reads the tail to find the next
  free slot, redoes its work on top of the latest state, and tries to
  create the entry at the next sequence (a forward probe).

That retry loop is the entire concurrency story. No locks, no
coordinator, no server holding state — S3's atomic conditional-write
_is_ the coordination. That is why the pitch is "Just a Bucket."

**Retries can't duplicate committed rows.** Content keys are hashes,
so re-writing the same post-image is a harmless no-op. Log entries are
created with "only if absent"; if a writer retries after it already won
its log create but lost the acknowledgement of it, it recognizes that
entry by its random per-commit session and adopts it as already
committed. A _different_ writer's entry at that sequence is a conflict,
not a duplicate — the loser just probes forward to the next free slot.

There used to be a subtler case to worry about: a _zombie_ writer — one
that paused for a long time (a slow VM, a suspended laptop) and wakes up
holding a stale view of the world. Under single-write commit it can't do
any damage, and the reason is structural: the log is **immutable,
append-only, and create-if-absent.** There is no shared mutable pointer
left to overwrite. A stale writer either finds its target sequence
already taken — and loses cleanly, probing forward — or appends at the
true current tail. It can never overwrite a committed entry. (The old
`current.json` carried an ever-increasing _epoch_ to fence such writers;
that `writer_fence` field still exists but is now **dormant** — the
immutable append-only log makes active fencing unnecessary.) The formal
version of all of this — the write and read algorithms, the dormant
fence, the causal-consistency guarantees — lives in
[`spec/sync-protocol.md`](../spec/sync-protocol.md), with the
adversarial fencing model in
[`spec/writer-fence-adversarial-model.md`](../spec/writer-fence-adversarial-model.md).

## What a read does

Much simpler:

1. Read `current.json` (the snapshot pointer plus `tail_hint`).
2. Load the _snapshot_ it names (a single object holding the rolled-up
   state up to some point), then replay the log entries added since —
   folding inserts, updates, and deletes on top. The reader probes
   forward from `tail_hint`, reading `log/<seq>`, `log/<seq+1>`, … and
   **stops at the first sequence that's missing** — that gap is the true
   tail.
3. Hand back the data.

Each log entry is immutable and exists only once it has committed, so a
reader always sees a consistent committed _prefix_ of the history — never
a half-finished write. A write that's still in flight simply isn't there
yet; it becomes visible the moment its log-entry create wins.

## What about the ever-growing log?

Two questions fall out of the model so far: if the log is
append-only, doesn't it grow without bound? And what happens to the
content/index objects a writer already PUT when it crashes _before_ its
log-entry create commits?

Both are handled by **maintenance**, which is two jobs:

- **Compaction** folds a run of log entries into a fresh snapshot and
  advances `current.json` to point at it — so a read replays a short
  tail instead of the entire history. The old log entries become
  unreferenced.
- **Garbage collection** sweeps objects nothing points to anymore:
  superseded snapshots, compacted-away log entries, and the orphaned
  content from a crashed write. Most crash residue is invisible because
  no committed log entry ever referenced it, so no reader ever saw it; GC
  tidies it up later. Deletes go through a grace window, so a slow
  in-flight reader is never pulled out from under.

There used to be a liveness edge case here, and it is **gone by
construction**: because the numbered `log/<seq>` create _is_ the commit,
there is no separate `current.json` swap to crash between. A writer can
never leave a committed log entry unacknowledged, so the old
orphan-at-the-tail wedge — where a crashed write could block all future
writes to the collection — cannot happen anymore. The entire
orphan-wedge class is eliminated. The formal version lives in
[`spec/sync-protocol.md`](../spec/sync-protocol.md#crash-safety).

Here is the part that matters for the mental model: **maintenance is
not a daemon.** There is no cron job, no sidecar, no background
process. It runs opportunistically from ordinary writes — a cheap
size-ratio check on the write path, and when it trips, a bounded chunk
of compaction or GC piggybacks on that write. Cloudflare can finish that
chunk after the response with `ctx.waitUntil`; Node runs it inline.
**Reads are pure: they never run maintenance.** An idle bucket does
nothing and pays nothing. This is what makes the project's _"There is no
runtime. None."_ literally true: no resident Baerly process exists
between requests. (Teams that _want_ batched maintenance windows can
call `runScheduledMaintenance` from their own scheduler, but it's an
opt-in convenience, never a requirement.) The design precedent is
PostgreSQL's HOT pruning / autovacuum; the full rationale is in
[`thesis.md`](thesis.md) → "Runtime model: nothing resident between
requests."

## Where the types and schema fit

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

The "actions" you call — `collection("notes").insert(...)`,
`.where(...).all()` — are defined _once_ as a typed interface, then
fulfilled by different layers depending on where the code runs.

```
       collection("notes").insert({ body })
                       │
   ┌───────────────────┴───────────────────┐
   │ CLIENT implements the interface       │  encode
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
- **The server _implements_ that menu against S3.** This is the write
  dance above: it turns `insert(...)` into the
  PUT-then-create-the-log-entry sequence (the create-if-absent commit).
- **The HTTP router translates the wire.** It receives a request,
  un-does what the client encoded, and calls the genuine server
  action — then serializes the result back. It holds no logic of its
  own.
- **The client _re-implements the same menu_ over HTTP.** Each method,
  instead of touching the bucket, encodes a request to the server.
  Same interface, different backend: the server's backend is the
  bucket; the client's backend is the server. That is why the same
  line of code type-checks on both sides.
- **The React bindings add reactivity, not new actions.** `useQuery`
  / `useMutation` / `BaerlyProvider` _call_ the client and wrap those
  calls in React's render model — live subscriptions that re-render
  when the data changes, plus loading/error state. They add _when it
  runs and how the result reaches the screen_, never new database
  semantics.

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
> writers can't claim the same slot; a loser just retries at the next
> slot. Reading means following `current.json` to the snapshot and log.
> The schema in your config validates every write and gives you your
> types. The protocol defines the actions once; the server fulfills them
> against the bucket, and the client fulfills the same actions over
> HTTP. No server is coordinating any of it — the bucket's atomic
> conditional-write is the coordination.

## Next

- **Build something** — the [cheat sheet](../guide/cheatsheet.md) is the
  one-screen API; the full surface is `dist/API.md`.
- **Run it in production** — the
  [operations runbook](../guide/operations.md).
- **Know when to leave** — [graduation](graduation.md): the bounds that
  tell you a collection has outgrown this tier.
