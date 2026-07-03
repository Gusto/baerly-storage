---
title: Architecture overview
audience: coder
summary: Module dependency graph and lifecycle of db.collection(...).insert().
last-reviewed: 2026-06-30
tags: [architecture, lifecycle, module-map]
related: ["spec/sync-protocol.md", "contributing/extending.md", "contributing/features.md"]
---

# Architecture

A top-down map of baerly-storage for someone who has never opened the
codebase.

## Core idea

A bucket gives every request the same primitive: bytes stored at a key.
`PUT` writes an object, `If-None-Match: "*"` makes that write
create-if-absent, and a `404` means the key is absent.

The key idea to keep in mind is single-write commit: a mutation commits
by creating one numbered log object, `log/<seq>.json`. There is no
database server deciding the winner. Every writer races for the first
empty log slot; on a supported backend, exactly one create can win. That
winning create is the commit.

Everything before the log create prepares data a future reader will need.
Everything after it is cleanup or maintenance. `current.json` does not
commit writes.

For an insert or update, the writer uploads the content body and new
index markers before it creates the `LogEntry` at `log/<seq>.json` with
`If-None-Match: "*"`. There is no `current.json` write on the commit
path. `current.json` is compactor-owned state: it names the snapshot,
stores `log_seq_start` (the first log seq not covered by that snapshot),
and carries a non-authoritative `tail_hint`.

The live tail is the first missing sequence after the committed log
entries. `tail_hint` is only a monotone lower bound on that tail; it may
lag and only tells readers where to start probing.

Reads use `current.json` as a starting point, not as the tail authority.
They load the snapshot it names, fold the trusted range
`[log_seq_start, tail_hint)`, then forward-probe the log from
`max(log_seq_start, tail_hint)` to the first 404. To fold a range is to
replay its log entries into the in-memory row map. The trusted range must
be dense, so a missing entry inside it is corruption. For example, with
`log_seq_start = 2` and `tail_hint = 5`, the trusted range is `2`, `3`,
`4`; the reader still probes `5`, `6`, ... until it sees a missing key.
Folding those `LogEntry` rows produces the live row set, and query
predicates run against that row set.

Change notifications use the HTTP
`/v1/since?collection=<name>&cursor=<opaque>` long-poll route. The
protocol is specified in
[spec/sync-protocol.md](spec/sync-protocol.md) and proven causally
covered by the randomized checker in
[spec/causal-consistency-checking.md](spec/causal-consistency-checking.md).

The useful git comparison is narrow: content-addressed documents,
immutable numbered log entries, and one conditional log create as the
commit, per collection. The consistency side of this shape depends on
S3's December 2020 strong read/write/list consistency; the commit point
also depends on create-if-absent conditional writes (see
[spec/storage-compatibility.md](spec/storage-compatibility.md)).

Bundle-size budgets set the scope: the full Cloudflare Workers bundle
(`cloudflare.js`) is capped at 122 KiB gzipped; the Node HTTP closure
(`http.js`) at 101 KiB; the browser client (`client.js`) at 6 KiB. The
whole public API surface fits in a single ~12k-token `dist/API.md`, so
an LLM can use it from `.d.ts` alone (see the
[API surface lock](contributing/conventions/change-discipline.md#api-surface-lock)).

## Runtime model

**There is no separate database server.** The bucket is durable shared
state. The Worker or Node handler is stateless per-request app code with
bucket credentials, and correctness must survive losing the process.

A request constructs a `Db` with
`Db.create({ storage, app, tenant, config? })`. `app` and `tenant` become
bucket-prefix namespace segments such as
`app/tickets/tenant/acme/...`. The `Db` reads a fresh `current.json`,
does the work — query evaluation, conflict resolution, or the committing
`log/<seq>` create — and returns. Reads do not rely on a warm cache:
each request fetches `current.json` and discovers the live tail from
storage.

Cloudflare can finish a write-triggered maintenance tick after the
response with `ctx.waitUntil`; Node runs it inline unless the host wraps
dispatch differently. No background thread runs between requests, and no
in-memory state from one request is load-bearing for the next.

Maintenance is **triggered in-band on the write path**, not by a
scheduler. After a successful commit, the writer may dispatch one
bounded `runBoundedMaintenance` pass if the ratio or GC-boundary gate is
due; otherwise leftover work waits for later writes. See
[the maintenance subsection](#after-the-write--the-in-band-maintenance-tick)
below. The default profile fits the tightest platform target,
Cloudflare Workers' 50-subrequest limit, so larger backlogs drain across
many write-ticks instead of a long-lived process. The opt-in
[`runScheduledMaintenance`](../packages/server/src/maintenance.ts)
SDK can still be driven from a cron trigger; it is not the default or
required. The rationale is in
[ADR-002](adr/002-ephemeral-coordination.md).

## Module dependency graph

The first diagram shows request flow. The second zooms into the
read/write engine — the part you touch when changing `writer.ts` or the
query path.

Solid arrows are a direct dependency or call path. Dashed arrows are a
looser relationship: **uses** a pure contract, **implements** an
interface, or triggers work **post-commit**.

### Layers at a glance

```mermaid
flowchart TD
    hosts["Host adapters<br/>Worker · Node · Vite"]
    http["HTTP surface<br/>CRUD router · /v1/since long-poll"]
    api["Application API<br/>Db · Collection"]
    engine["Read / write engine<br/>query · writer · log/snapshot fold"]
    storage["Storage<br/>R2 · S3 · memory · local-fs"]
    protocol["Protocol contracts<br/>pure, no I/O"]
    maintenance["Maintenance<br/>compact · gc, post-commit"]

    hosts --> http
    hosts --> api
    http --> api
    api --> engine
    engine --> storage
    engine -. uses .-> protocol
    storage -. implements .-> protocol
    engine -. post-commit .-> maintenance
```

A write flows host → API → engine → storage; a read folds storage back
up through the engine. `Protocol` is the pure contract layer: data
shapes and the `Storage` interface. `Maintenance` is post-commit work:
Cloudflare can dispatch it off-response; Node/default dispatch can run
it inline (see
[After the write](#after-the-write--the-in-band-maintenance-tick)).

### The engine, exploded

Here the host adapters, HTTP surface, maintenance loop, and protocol
modules collapse to single boxes. What remains is the application API and
the read/write engine behind `db.collection(...).insert()` and
`.where(...).all()`.

```mermaid
flowchart TD
    subgraph api["Application API · @baerly/server"]
        db["db.ts<br/>Db.create"]
        collection["collection.ts<br/>Collection&lt;T&gt; verbs"]
    end

    subgraph engine["Read / write engine · @baerly/server"]
        query["query.ts<br/>Query reader + mutation terminals"]
        planner["query-planner.ts<br/>planQuery"]
        writer["writer.ts<br/>single-write commit"]
        indexhelpers["indexes.ts<br/>validate · encode · project"]
        logio["log-tail · log-walk · snapshot<br/>tail probe + fold"]
    end

    protocol["Protocol contracts<br/>json · log · current.json ·<br/>Storage · collection-api · indexes"]
    storage["Storage impls<br/>R2 · S3 · memory · local-fs"]
    maint["Maintenance<br/>see §After the write"]

    db --> collection
    collection --> query
    query --> planner
    query --> writer
    query --> logio
    query -. uses .-> protocol
    writer --> indexhelpers
    writer --> logio
    writer --> storage
    writer -. uses .-> protocol
    writer -. post-commit .-> maint
    planner -. uses .-> protocol
    indexhelpers -. uses .-> protocol
    logio --> storage
    logio -. uses .-> protocol
    storage -. implements .-> protocol
```

## Package layers

The `@baerly/*` packages obey a separate import invariant that keeps the
kernel portable:

- **`@baerly/protocol` is pure: no I/O, no `node:` builtins.** It is the
  universal leaf and imports nothing, so the kernel can run unchanged on
  Workerd, in Node, and in the browser where applicable.
- **`@baerly/server` imports nothing below `@baerly/protocol`** — in
  particular it never reaches sideways into a storage adapter. Workerd
  compatibility is defined as "everything reachable from
  `@baerly/server`'s entry points runs under Workerd"; that holds because
  `server` depends only on `protocol`.
- **Workerd-incompatible `node:` builtins are blocked in `protocol` and
  `server`.** `server` allowlists `node:async_hooks` only (Workerd
  supports it under `nodejs_compat`); `protocol` allows none. Packages
  above this line are Node-only by design and may import any builtin.

The production import graph (`*.test.ts` / `*.test-d.ts` excluded) is a
hand-maintained allow list — each row names the packages that owner may
import; anything not listed is forbidden, and self-imports are allowed:

| Owner package | May import |
|---|---|
| `protocol` | (nothing — protocol must remain pure) |
| `server` | `protocol` |
| `dev` | `protocol`, `server`, `adapter-node` |
| `adapter-node` | `protocol`, `server`, `dev` |
| `adapter-cloudflare` | `protocol`, `server`, `dev` |
| `client` | `protocol`, `server` |
| `cli` | `protocol`, `server`, `dev`, `adapter-node`, `adapter-cloudflare`, `client` |
| `create-baerly-storage` | `protocol`, `server`, `cli` |

```mermaid
flowchart TD
    client["client"]
    adapterCf["adapter-cloudflare"]
    adapterNode["adapter-node"]
    dev["dev"]
    server["server"]
    protocol["protocol"]

    client --> server
    client --> protocol

    adapterCf --> dev
    adapterCf --> server
    adapterCf --> protocol

    adapterNode --> server
    adapterNode --> protocol

    dev --> server
    dev --> protocol

    server --> protocol

    dev -->|vite-plugin| adapterNode
    adapterNode -->|dev-landing| dev

    linkStyle 10,11 stroke:#d33,stroke-width:2px
```

The diagram shows the portability core — the layering down to the pure
`protocol` leaf and the cordoned `dev ↔ adapter-node` cycle. The two
top-of-stack consumers, `cli` and `create-baerly-storage`, are omitted:
they import broadly almost by definition and add edges without changing
the shape. The table above remains the complete, enforced edge set.

The two red edges are an accepted Node-only `dev ↔ adapter-node` cycle:
`@baerly/dev`'s Vite plugin imports `baerlyNode` as the in-process dev
listener, and `@baerly/adapter-node`'s `dev-landing` middleware imports
`renderDevLanding` as a runtime value. The cycle sits above the
`server`/`protocol` line, cannot pull anything into the kernel, and will
never reach Workerd; breaking it is a separate refactor.

The allow list is enforced at edit time by
[`scripts/lint-package-layers.mjs`](../scripts/lint-package-layers.mjs),
which runs in `pnpm verify` / `pnpm verify:agent`. It walks
`packages/*/src/**`, matches bare, subpath, dynamic, and relative
cross-package specifiers, forbids the disallowed `node:` builtins, and
exits non-zero with a remediation hint. **This table is the source of
truth; the script's `RULES` table is its executable mirror — a new
`@baerly/*` package must add its row to both in the same PR.**

The list is hand-maintained so each new edge gets deliberate review. A
graph-based dependency tool (`dependency-cruiser`, Nx,
`eslint-plugin-boundaries`) would resolve dynamic and relative edges
natively and is in-policy, but config-as-data is heavier than the
~120-line script for an 8-node graph with a unit-test harness. Revisit
at N>12 packages, or when dynamic and relative imports outgrow the
script.

## CLI surfaces

Two CLIs ship from this repo:

| CLI | Package | Role |
| --- | --- | --- |
| `@gusto/create-baerly-storage` | `packages/create-baerly-storage/` | Puts baerly-storage into a project by scaffolding from `examples/` or bolting onto an existing Cloudflare Worker (`pnpm create @gusto/baerly-storage@latest .`). It is the only npm-published CLI besides `baerly-storage` itself. |
| `baerly` | `packages/cli/` | Operates on a project that already has baerly-storage: `deploy`, `doctor`, `inspect`, `export`, `cost`, and the `admin` subgroup. Workspace-internal; bundled to `dist/baerly.js` inside the `baerly-storage` tarball. |

They share one helper module — `@baerly/cli/wrangler-patch` — because
both `baerly deploy --target=cloudflare` and
`@gusto/create-baerly-storage`'s bolt-on flow merge into the same
`wrangler.jsonc`. Everything else stays in its package. See
`packages/cli/AGENTS.md` and
`packages/create-baerly-storage/AGENTS.md` for the per-package quickrefs.

## Lifecycle of `db.collection("X").insert(doc)`

Write ordering is asymmetric: content bodies and new index markers are
visible before the `log/<seq>` create; stale index markers are deleted
after commit. A row becomes visible only when a committed log entry is
replayed; content and index objects alone are ignored as rows. Index
markers are zero-byte objects used to find candidate doc ids.

1. **`Collection.insert(doc)`** (`packages/server/src/collection.ts`):
   normalises the document, generates a UUIDv7 `_id` if absent,
   constructs a `CommitInput{ op: "I", collection, docId, body }`,
   and calls `Writer.commit(...)`.

2. **`Writer.commit(req)`** (`packages/server/src/writer.ts`):
   - reads `current.json` fresh for its snapshot pointer and `tail_hint`;
   - forward-probes from `max(log_seq_start, tail_hint)` to find the
     first empty log slot and mint `seq`;
   - PUTs the content body under
     `app/<app>/tenant/<tenant>/manifests/<collection>/content/<sha>.json`
     and additive (new) index artifacts under
     `app/<app>/tenant/<tenant>/manifests/<collection>/index/...`
     **before** the commit;
   - creates the log entry under
     `app/<app>/tenant/<tenant>/manifests/<collection>/log/<seq>.json`
     with `If-None-Match: "*"` — **that create is the commit** (no
     `current.json` write on the commit path);
   - DELETEs stale index keys after the commit.

   A `412` on the log create means the key already exists. The writer
   reads the existing `LogEntry` and adopts it only when it has the same
   `session`, same `seq`, and full-entry equality with the attempted
   entry. Any failed adoption check treats the occupant as a conflicting
   committed entry, so the writer re-probes until it finds the next empty
   slot. A malformed log entry surfaces as corrupt storage state, not as
   an ordinary conflict. That re-probe is bounded by
   `LOG_FORWARD_PROBE_CAP`; exhausting it surfaces
   `BaerlyError{code:"Internal"}`. There is no post-commit fence verify;
   `writer_fence` is dormant.

   The ordering, and the read-back branch that distinguishes a lost
   acknowledgement from a foreign write:

   ```mermaid
   sequenceDiagram
       participant W as Writer (request handler)
       participant B as Bucket (S3 / R2)

       W->>B: GET current.json (snapshot ptr and tail_hint)
       W->>B: GET log/N onward (forward-probe)
       B-->>W: first 404 fixes seq = N
       W->>B: PUT content/sha (create-if-absent)
       W->>B: PUT new index markers (create-if-absent)
       W->>B: PUT log/N (create-if-absent)
       alt slot was free
           B-->>W: 200 — COMMIT
           W->>B: DELETE stale index markers (after commit)
       else slot taken
           B-->>W: 412 Precondition Failed
           W->>B: GET log/N (read the occupant)
           Note over W: adopt only if same session, same seq,<br/>and full-entry equality — otherwise re-probe the next slot
       end
   ```

3. **Read path: `Collection.where(p).all()`**
   (`packages/server/src/query.ts`): reads `current.json`, loads the
   snapshot it names, folds the trusted range `[log_seq_start,
   tail_hint)` from object storage and then forward-probes
   `[max(log_seq_start, tail_hint), true tail)` to the first 404, folds
   the `LogEntry` stream into the live row set
   (`I` / `U` apply the doc body; `D` removes the doc), evaluates the
   predicate AST from `where()` / `order()` / `limit()`, and returns the
   filtered rows.

#### Planner step (between the predicate and the log fold)

The committed log, folded over the snapshot, is the row truth. Indexes
only choose candidate doc ids. Extra stale markers add work; missing
markers can hide rows from an index-routed query.

When `Collection.where(p).all()` has a predicate AND the
collection has declared `indexes`, the reader calls
`planQuery(predicate, indexes)` (in
`packages/server/src/query-planner.ts`) after the `current.json` read
and before the log fold. The planner returns either
`IndexWalkPlan{indexName, equalityKeys, rangeOn?, inOn?}`
— which routes the reader through `runIndexWalkPlan` to LIST under the
encoded index prefix and resolve only the matching doc ids — or
`FullScanPlan{reason}` — which falls through to the snapshot+log fold.
Every fetched row passes through a post-fetch `matchesWire(...)`
re-check; it drops stale extra index entries and consumes predicate
clauses the index did not cover. Run `rebuildIndex` before treating a
newly declared or suspect index as complete. For filtered indexes, marker
completeness is sound only when the query implies the index filter. The
plan shape, diagnostic `reason` values, and filtered-index caveat are in
[features.md](contributing/features.md) §"Secondary indexes".

The HTTP `/v1/since?collection=<name>&cursor=<opaque>` route in
`packages/server/src/http/since.ts` walks the log from a caller-supplied
cursor, then returns new entries immediately or holds the request until
entries arrive (or the long-poll deadline elapses). The protocol-level
theory lives in
[spec/sync-protocol.md](spec/sync-protocol.md).

### After the write — the in-band maintenance tick

Compaction keeps reads from replaying old log entries; GC removes
orphaned objects. The writer's post-commit dispatch point
(`packages/server/src/writer.ts`) is the single default in-band trigger
site for this work.

After the commit lands, the writer reads a per-request
`MaintenanceDispatch` off the observability context
(`getCurrentContext()?.maintenance`, set by the adapter) and calls
`runBoundedMaintenance` (`packages/server/src/maintenance.ts`) when the
write-tick gate is due. **Reads are pure — they never tick.** A bare
`Db.create(...)` dispatches inline with the default profile sized for
Cloudflare Workers' free-tier subrequest budget once enough writes
accrue; no `setInterval`, cron, or operator scheduler is required.

The bounded pass splits that work across two existing primitives:

- `runGc()` (`packages/server/src/gc.ts`) deletes content bodies, stale
  log entries, and orphan snapshots no longer reachable from
  `current.json` after the grace window. It uses the two-phase
  mark/sweep ledger at `gc/pending.json`, is bounded by the maintenance
  profile's `gcMaxMarks` / `gcMaxSweeps`, and is due on `gcInterval`
  write-count boundary crossings. In `"single"` phase mode, a fold can
  take the tick when both are due; the hard-GC guard prevents indefinite
  starvation.
- `compact()` (`packages/server/src/compactor.ts`) folds a **sliced**
  tail into a new snapshot and advances `log_seq_start` so future reads
  replay less log. The slice size is `maxFoldEntriesPerPass`, passed to
  `compact()` as `maxEntriesPerRun`. The unsliceable snapshot rebuild is
  gated by a **static two-way ceiling** (`snapshot_bytes <= C` AND
  `snapshot_rows + maxFoldEntriesPerPass <= E`). The byte ceiling is
  overridable by `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`; the row ceiling is
  a kernel constant.

Snapshot pointer advancement: a fold writes a new snapshot, then
advances `current.json` with a **full-fence CAS** — a conditional update
that succeeds only if the previously read state still matches. A lost
fold is abandoned (**no lease**; no lock object is taken); its orphan
snapshot is reclaimed by `runGc` past the grace window. **Dispatch is by
capability:** Cloudflare relocates the maintenance pass past the
response via `ctx.waitUntil`; everywhere else it runs inline
(`dispatchInlineAwaited`). See
[graduation.md](about/graduation.md) for the per-tier envelope
and ceiling math, and "Storage layout in the bucket" below for
the on-disk shape these passes produce.

## Storage seam

The kernel's portability comes from a small boundary: it knows object
operations, not providers. It reads and writes through the four
`Storage` methods only (`get`/`put`/`delete`/`list`). `Storage` is
injected at `Db.create({ storage, app, tenant })` time; the kernel
never picks an impl itself.

- `S3HttpStorage` (`packages/adapter-node/src/s3-http.ts`) for any
  HTTP endpoint from a Node host. Authentication plugs in via an
  injected `sign(req)` callback — `S3HttpStorage` imports no signer
  itself; the `s3Storage` / `r2Storage` / `minioStorage` /
  `gcsStorage` factories exported from `@gusto/baerly-storage/node`
  wire `aws4fetch`'s SigV4 in for you. Production callers should use
  AWS S3 or Cloudflare R2; MinIO is the local conformance target, and
  GCS S3-interop is unsupported for database use today.
- `MemoryStorage` (`packages/protocol/src/storage/memory.ts`) for
  the `memory:` endpoint, partitioned per bucket via a
  process-singleton map so multiple `Db` instances share state by
  bucket name.
- `LocalFsStorage` (`packages/dev/src/local-fs.ts`, ships in the
  Node-only `@baerly/dev` package — not part of the runtime bundle
  since the kernel can't depend on `node:fs`) backs the `baerlyDev()`
  Vite plugin (which the `examples/minimal-node/` and
  `examples/react-node/` scaffolds use as `pnpm dev`) against a fixture
  directory. Content-addressed `"<sha-256-hex>"` ETags so identical
  bodies match across runs; atomic writes via `write-temp + rename`.
  Callers construct it directly and inject it where a `Storage` is
  required.
- `r2BindingStorage` (`packages/adapter-cloudflare/src/r2-binding-storage.ts`)
  for Cloudflare Workers. Wraps an R2 bucket binding, no HTTP hop.

Cloudflare Workers and Node are supported today; AWS Lambda requires an
adapter package. Platform-specific code belongs in adapters.

## Where invariants live

- **Causal consistency:** `packages/server/src/writer.ts` and
  `packages/server/src/query.ts` — the writer mints `LogEntry.seq`
  as the first empty log slot found by the forward-probe from
  `max(log_seq_start, tail_hint)`, and the winning `log/<seq>`
  `If-None-Match: "*"` create is the commit; the reader folds
  `[log_seq_start, tail_hint)` from a single read of `current.json` and
  forward-probes from `max(log_seq_start, tail_hint)`.
  A reader's observed sequence is a prefix of the collection log.
  Randomized checker:
  [spec/causal-consistency-checking.md](spec/causal-consistency-checking.md).
- **Split-brain fencing:** `writer_fence.epoch` inside `current.json`
  is **dormant** under single-write commit — the post-commit fence
  verify was removed (the winning `log/<seq>` create is itself the
  proof of commit), and no prod path reads or writes the field. Its
  drop is deferred (see [ADR-004](adr/004-single-write-commit.md)).
- **JSON Merge Patch semantics:** `packages/protocol/src/json.ts` —
  RFC 7386 with the array-replacement convention; see
  [spec/json-merge-patch.md](spec/json-merge-patch.md).
- **Log entry shape:** `packages/protocol/src/log.ts` — the on-the-wire
  `LogEntry` interface and its versionless/additive-only 0.3.0
  public-baseline / 0.x stability rules. See
  [spec/log-entry-shape.md](spec/log-entry-shape.md).

## Key types (where the contracts live)

- `Db` (`packages/server/src/db.ts`): public read/write surface.
  `Db.create({ storage, app, tenant })` returns a tenant-scoped
  handle; `db.collection<T>(name)` returns a `Collection<T>`.
- `Collection<T>` / `Query<T>` (`@baerly/protocol`,
  consumed by `packages/server/src/collection.ts` and
  `packages/server/src/query.ts`): the locked SQL-shape API.
  Mutations (`insert` / `update` / `replace` / `delete`) plus the
  predicate AST (`where` / `order` / `limit` /
  `first` / `all` / `count`).
- `CommitInput` / `CommitResult`
  (`packages/server/src/writer.ts`): the
  `Writer.commit` request/response shapes.
- `LogEntry` (`packages/protocol/src/log.ts`): the per-mutation log
  entry. Field set is fixed at major versions; consumers ack on
  `lsn`. Full contract in [spec/log-entry-shape.md](spec/log-entry-shape.md).
- `Branded<T, B>` (`packages/protocol/src/types.ts`): nominal-type
  pattern. `UUID` and `ContentVersionId` are both `string`s but not
  assignable to each other.
- `BaerlyError` / `BaerlyErrorCode` (`packages/protocol/src/errors.ts`):
  discriminated-union error type. Branch on `error.code`.
- `loadSnapshotAsMap(storage, key, expectedCollection, signal?)`
  (`packages/server/src/snapshot.ts`): `@public` shared utility —
  fetches a snapshot from object storage, verifies the SHA-256
  baked into the filename, and returns a `Map<_id, body>`. Internal
  callers: the compactor's fold-base load, the reader
  (`Query.runRead`), `runGc`, `rebuildIndex`. See
  [extending.md §5](contributing/extending.md#5-shared-utilities-on-the-public-surface).

## Storage layout in the bucket

Every object for one collection lives under one prefix: `log/` holds
commits; `content/`, `index/`, `snapshot/`, and `gc/` support reads and
maintenance. For a `Db` constructed with `app="tickets"` and
`tenant="acme"`, that prefix is the tree root below — shown once here,
then omitted from the table that follows:

```
app/tickets/tenant/acme/manifests/<collection>/
├── current.json                   ← compaction state (compactor-owned)
├── log/
│   └── <seq>.json                 ← one LogEntry; THIS create is the commit
├── content/
│   └── <content-version>.json     ← post-image body (insert / update)
├── index/
│   └── <name>/…                   ← advisory marker (zero-byte)
├── snapshot/
│   └── L9/<min>-<max>-<sha>.json  ← materialized snapshot
└── gc/
    └── pending.json               ← GC candidate ledger
```

| Object                               | Key encodes                          | Holds / role                                                                                                                                                                     |
| ------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current.json`                       | — (one per collection)               | Snapshot pointer, `log_seq_start`, the non-authoritative `tail_hint`, and the dormant `writer_fence`. **Not** the commit-path linearization point.                               |
| `log/<seq>.json`                     | `seq` — monotonic integer            | One `LogEntry`. The `If-None-Match: "*"` create on this key **is the commit**. Readers scan the trusted range `[log_seq_start, tail_hint)`, then forward-probe to the true tail. |
| `content/<content-version>.json`     | `ContentVersionId` — SHA-256, 32 hex | Content-addressed post-image body for `I` / `U`.                                                                                                                                 |
| `index/<name>/…`                     | index name + encoded key             | Zero-byte advisory index marker.                                                                                                                                                 |
| `snapshot/L9/<min>-<max>-<sha>.json` | `seq` range + content hash           | Content-hashed materialized snapshot.                                                                                                                                            |
| `gc/pending.json`                    | — (one per collection)               | Two-phase GC candidate ledger.                                                                                                                                                   |

Compaction (`packages/server/src/compactor.ts`) folds adjacent log
entries into checkpoints and advances `log_seq_start`. GC
(`packages/server/src/gc.ts`) deletes content bodies, stale log entries,
and orphan snapshots no longer reachable from `current.json`. Both are
driven in-band on the write path by `runBoundedMaintenance`
(`packages/server/src/maintenance.ts`); `runScheduledMaintenance` is the
opt-in alternative trigger. See
[After the write — the in-band maintenance tick](#after-the-write--the-in-band-maintenance-tick).
