---
title: How it works
audience: integrator
summary: The plain-language mental model — a bucket of files plus a library that flips one pointer atomically, and the typed layers from protocol to React.
last-reviewed: 2026-06-13
tags: [concepts, mental-model, protocol]
related: [thesis.md, "../spec/sync-protocol.md", "../contributing/architecture.md"]
---

# How it works

The whole thing in plain language. This is the bridge between the
[product thesis](thesis.md) (the *why*) and the formal
[protocol spec](../spec/sync-protocol.md) (the precise *what*). If
you can explain this page to someone, you understand Baerly.

## The one idea to anchor on

**There is no database server.** The "database" is just a pile of
files (objects) in an S3 bucket. `baerly-storage` is a *library* — a
set of rules for how to lay out those files and how to change them
safely. Nobody is running a daemon in the middle. When your code
"talks to the database," it is doing `GET` and `PUT` on objects in a
bucket and nothing more.

So the real question is: *how do you get database behavior out of a
dumb bucket?* That is the entire trick.

## What's in the bucket

When you insert a row, the library does not overwrite one big "table"
file. It writes a few small, separate, immutable objects:

- **A content object** — the actual row data (`{ body: "buy milk" }`),
  stored under a content-addressed key (a hash of its bytes).
- **A log entry** — a tiny append-only record: "at this point, this
  row was inserted." The history.
- **Index objects** — small marker files that make lookups fast, so a
  read doesn't have to scan everything.
- **`current.json`** — the single most important object. It is a
  per-collection pointer that says *"the current state of this
  collection is described by these objects."* The table of contents.

Every collection has its own `current.json`, its own integer log, and
its own CAS hotspot. To know what a collection *is* right now, you read
that collection's `current.json`, then follow the snapshot and integer
log range it names. Index objects can help narrow the read, but the
snapshot plus log are the source of truth.

## What a write does

Say you insert a row. The library does this, in order:

1. **PUT the content** — write the row's bytes as a new object.
2. **PUT/DELETE the index entries** — update the lookup markers.
3. **PUT the log entry** — append "inserted row X" to the history.
4. **Swap the pointer** — update `current.json` to point at the new
   state.

Steps 1–3 do not change the visible database state, because
`current.json` does not point at the new log range yet. The database
only "changes" at step 4, the instant `current.json` flips. Until
then the artifacts are invisible scaffolding.

## The part that makes it safe

Step 4 is where two writers at once could clobber each other. S3 has
one feature that saves us: a **conditional PUT** — "write this object
*only if* it hasn't changed since I last read it." Compare-and-swap.

So the swap really means:

> "Set `current.json` to my new version, **but only if** it is still
> the exact version I read a moment ago."

- Nobody else wrote in the meantime → the swap succeeds. Done.
- Someone slipped a write in first → the conditional PUT is
  **rejected**. The library notices, re-reads the now-newer
  `current.json`, redoes its work on top of the latest state, and
  tries the swap again.

That retry loop is the entire concurrency story. No locks, no
coordinator, no server holding state — S3's atomic conditional-write
*is* the coordination. That is why the pitch is "Just a Bucket."

**Retries can't duplicate committed rows.** Content keys are hashes,
so re-writing the same post-image is a harmless no-op. Log entries are
created with "only if absent"; if the writer retries after it already
wrote its own single-entry log but lost the `current.json` swap, it can
recognize that log by its random per-commit session and adopt it. A
different writer's log at the same sequence is a conflict, not a
duplicate.

One subtler case the CAS doesn't cover on its own: a *zombie* writer
— one that paused for a long time (a slow VM, a suspended laptop) and
wakes up holding a stale view of the world. To stop it from quietly
clobbering newer state, `current.json` also carries an ever-increasing
*epoch*; a writer that finds the epoch has moved past its own is
*fenced* — it aborts instead of retrying. The formal version of all of
this — fencing, the write and read algorithms, the causal-consistency
guarantees — lives in
[`spec/sync-protocol.md`](../spec/sync-protocol.md), with the
adversarial fencing model in
[`spec/writer-fence-adversarial-model.md`](../spec/writer-fence-adversarial-model.md).

## What a read does

Much simpler:

1. Read `current.json` (the pointer).
2. Load the *snapshot* it names (a single object holding the rolled-up
   state up to some point), then replay the handful of log entries
   added since — folding inserts, updates, and deletes on top.
3. Hand back the data.

Because a collection's `current.json` only ever flips atomically to a
fully-consistent state, a reader never sees a half-finished write. It
sees the state from *before* the swap or *after* it — never the
middle.

## What about the ever-growing log?

Two questions fall out of the model so far: if the log is
append-only, doesn't it grow without bound? And what happens to the
content/log objects a writer already PUT when it crashes *before* the
pointer swap?

Both are handled by **maintenance**, which is two jobs:

- **Compaction** folds a run of log entries into a fresh snapshot and
  advances `current.json` to point at it — so a read replays a short
  tail instead of the entire history. The old log entries become
  unreferenced.
- **Garbage collection** sweeps objects nothing points to anymore:
  superseded snapshots, compacted-away log entries, and the orphaned
  content from a crashed write. Most crash residue is invisible because
  `current.json` never referenced it, so no reader ever saw it; GC
  tidies it up later. Deletes go through a grace window, so a slow
  in-flight reader is never pulled out from under.

There is one current liveness edge case worth naming even in the
mental model: if a writer crashes after PUTting `log/<next_seq>.json`
but before the `current.json` swap, the next writer can find a foreign
log entry exactly where it needs to write and retry to exhaustion. That
wedges future writes for the collection until the pending atomic-commit
object fix lands. It is not data loss — readers still stop at the
unchanged `current.json.next_seq` — but it is a real current limit. The
formal version lives in
[`spec/sync-protocol.md`](../spec/sync-protocol.md#crash-safety).

Here is the part that matters for the mental model: **maintenance is
not a daemon.** There is no cron job, no sidecar, no background
process. It runs opportunistically from ordinary writes — a cheap
size-ratio check on the write path, and when it trips, a bounded chunk
of compaction or GC piggybacks on that write. Cloudflare can finish that
chunk after the response with `ctx.waitUntil`; Node runs it inline.
**Reads are pure: they never run maintenance.** An idle bucket does
nothing and pays nothing. This is what makes the project's *"There is no
runtime. None."* literally true: no resident Baerly process exists
between requests. (Teams that *want* batched maintenance windows can
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
`.where(...).all()` — are defined *once* as a typed interface, then
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
   │   → CAS-swap current.json            │
   └──────────────────┬───────────────────┘
                      ▼
                  S3 bucket
```

Reading that chain top to bottom:

- **The protocol defines the actions as types.** A typed menu —
  `insert`, `update`, `where`, `order`, `first`, `all` — with no
  implementation. Just the shapes.
- **The server *implements* that menu against S3.** This is the write
  dance above: it turns `insert(...)` into the PUT-then-CAS sequence.
- **The HTTP router translates the wire.** It receives a request,
  un-does what the client encoded, and calls the genuine server
  action — then serializes the result back. It holds no logic of its
  own.
- **The client *re-implements the same menu* over HTTP.** Each method,
  instead of touching the bucket, encodes a request to the server.
  Same interface, different backend: the server's backend is the
  bucket; the client's backend is the server. That is why the same
  line of code type-checks on both sides.
- **The React bindings add reactivity, not new actions.** `useQuery`
  / `useMutation` / `BaerlyProvider` *call* the client and wrap those
  calls in React's render model — live subscriptions that re-render
  when the data changes, plus loading/error state. They add *when it
  runs and how the result reaches the screen*, never new database
  semantics.

For the precise module graph and the full line-by-line lifecycle of
`db.collection(...).insert()`, see
[`contributing/architecture.md`](../contributing/architecture.md). A
runnable end-to-end example of every layer is
[`examples/react-node`](../../examples/react-node).

## Say it in one breath

> It's not a database server — it's a bucket of files plus a library
> that knows how to arrange them. Writing means dropping new immutable
> objects in the bucket and then atomically flipping one pointer file
> for that collection, `current.json`, to point at them — using S3's
> compare-and-swap so simultaneous writers can't corrupt each other; a
> loser just retries on top of the winner's state. Reading means
> following that pointer. The schema in your config validates every
> write and gives you your types. The protocol defines the actions
> once; the server fulfills them against the bucket, and the client
> fulfills the same actions over HTTP. No server is coordinating any of
> it — the bucket's atomic conditional-write is the coordination.
