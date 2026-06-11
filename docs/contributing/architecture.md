---
title: Architecture overview
audience: coder
summary: Module dependency graph and lifecycle of db.collection(...).insert().
last-reviewed: 2026-06-11
tags: [architecture, lifecycle, module-map]
related: ["../spec/sync-protocol.md", extending.md, features.md]
---

# Architecture

A top-down map of Baerly for someone who has never opened the codebase.

## One-paragraph summary

A client writes by uploading content to S3-compatible storage, then
appending a per-doc `LogEntry` to a time-ordered log (also stored in
the bucket, one object per mutation, sorted by an `lsn` cursor). The
write completes with a CAS-advance of `current.json`, which records
the high-water `next_seq` and the `log_seq_start` invariant used by
readers. Reads explicitly fetch `current.json`, walk
`[log_seq_start, next_seq)`, fold `LogEntry` rows into a live row
set, and evaluate the query predicate. Change notifications are
delivered out-of-band by the HTTP `/v1/since` long-poll route. The
protocol is specified in
[spec/sync-protocol.md](../spec/sync-protocol.md) and proven causally consistent in
[spec/causal-consistency-checking.md](../spec/causal-consistency-checking.md).

Built like git: content-addressed documents, immutable log entries, and a single CAS-advanced pointer to HEAD. This shape is the same recipe Iceberg, Delta
Lake, Turbopuffer, Litestream, and SlateDB converged on after S3
went strongly consistent in December 2020 (see
[spec/s3-features-used.md](../spec/s3-features-used.md)). The novel
part is not the kernel; it is shaping the system so the public API
stays small enough that an LLM can use it from `.d.ts` alone (see
[ADR-002](../adr/002-api-surface-lock.md)).

Bundle sizes set the scope: the full Cloudflare Workers bundle
(`cloudflare.js`) is ~113 KB gzipped; the Node HTTP closure
(`http.js`) is ~94 KB gzipped; the browser client (`client.js`)
is ~5 KB gzipped. The whole public API surface fits in a single
~12k-token `dist/API.md`.

## Runtime model

**There is no runtime. None.** All coordination runs inside a single HTTP request or cron invocation — no daemon, no leader, no coordinator service. A request enters the Worker/Node handler; the handler constructs a
`Db` via `Db.create({ storage, config })`; the `Db` reads a fresh
`current.json` from the bucket (no warm-cache shortcut for
correctness — `consistency: "strong"` does this explicitly); it
does the work — query evaluation, conflict resolution, CAS-advance
of `current.json` — and exits. No background thread runs between
requests, and no in-memory state from one request is load-bearing
for the next: the next request re-reads `current.json` from the
bucket.

Maintenance has the same shape, but it is **triggered in-band on
the write path**, not by a scheduler. After a successful commit
the writer dispatches a bounded maintenance pass (see
[the maintenance subsection](#after-the-write--the-in-band-maintenance-tick)
below). The pass is sized to fit inside the platform's subrequest
budget — Cloudflare Workers' 50-subrequest limit is the tightest
target — so larger backlogs drain across many write-ticks rather
than spilling into a long-lived process. The opt-in
[`runScheduledMaintenance`](../../packages/server/src/maintenance.ts)
SDK can still be driven from a cron trigger, but it is not the
default and not required. The rationale is in
[ADR-004](../adr/004-ephemeral-coordination.md).

## Module dependency graph

```mermaid
graph TD
    db[db.ts<br/>Db: public API]
    collection[collection.ts<br/>Collection&lt;T&gt; verbs]
    query[query.ts<br/>Query&lt;T&gt; predicate AST + reader]
    planner[query-planner.ts<br/>planQuery]
    indexes[indexes.ts<br/>IndexDefinition + key encoding]
    writer[writer.ts<br/>Writer.commit / commitBatch]
    compactor[compactor.ts<br/>compact()]
    gc[gc.ts<br/>runGc()]
    maint[maintenance.ts<br/>runScheduledMaintenance]
    storage[Storage interface<br/>get/put/delete/list]
    s3http[storage/s3-http.ts<br/>S3HttpStorage]
    memstore[storage/memory.ts<br/>MemoryStorage]
    localfs[dev/local-fs.ts<br/>LocalFsStorage]
    json[json.ts<br/>RFC 7386 merge patch]
    log[log.ts<br/>LogEntry shape]

    db --> collection
    db --> writer
    collection --> query
    collection --> writer
    query --> planner
    query --> storage
    planner --> indexes
    writer --> indexes
    writer --> storage
    writer --> log
    compactor --> storage
    gc --> storage
    maint --> compactor
    maint --> gc
    storage --> s3http
    storage --> memstore
    storage --> localfs
    writer --> json
```

## CLI surfaces

Two CLIs ship from this repo, and the split is load-bearing:

- **`@gusto/create-baerly-storage`** (`packages/create-baerly-storage/`) puts baerly into a
  project — either by scaffolding from a template in `examples/` or by
  bolting onto an existing Cloudflare Worker (`pnpm create @gusto/baerly-storage@latest .`).
  It is the only npm-published CLI besides `baerly-storage` itself.
- **`baerly`** (`packages/cli/`) does things to a project that already
  has baerly: `deploy`, `doctor`, `inspect`, `export`, `cost`, and the
  `admin` subgroup. Workspace-internal; bundled to a single-file bin at
  `dist/baerly.js` that the `baerly-storage` tarball ships.

The two share one helper module — `@baerly/cli/wrangler-patch` — because
both `baerly deploy --target=cloudflare` and `@gusto/create-baerly-storage`'s bolt-on
flow merge into the same `wrangler.jsonc`. Everything else stays in its
own package. See `packages/cli/AGENTS.md` and
`packages/create-baerly-storage/AGENTS.md` for the per-package quickrefs.

## Lifecycle of `db.collection("X").insert(doc)`

1. **`Collection.insert(doc)`** (`packages/server/src/collection.ts`):
   normalises the document, generates a UUIDv7 `_id` if absent,
   constructs a `CommitInput{ op: "I", collection, docId, body }`,
   and calls `Writer.commit(...)`.

2. **`Writer.commit(req)`**
   (`packages/server/src/writer.ts`): reads `current.json`
   for the current `next_seq` and the `writer_fence.epoch` it
   operates under, mints a `LogEntry` at `next_seq`, PUTs the
   content body under `tenants/<t>/c/<collection>/<doc_id>`,
   PUTs the log entry under `tenants/<t>/log/<lsn>.json` with
   `If-None-Match: *`, and CAS-advances `current.json` to the
   new `next_seq` (preserving the `log_seq_start` invariant).
   Retries up to `S3_REQUEST_MAX_RETRIES` (default 8) on transient
   CAS conflict; fails fast with `BaerlyError{code:"Conflict"}` on a
   `writer_fence.epoch` bump.

3. **Read path: `Collection.where(p).all()`**
   (`packages/server/src/query.ts`): reads `current.json`, walks
   `[log_seq_start, next_seq)` from object storage, folds the
   `LogEntry` stream into the live row set (`I` / `U` apply the
   doc body; `D` removes the doc), evaluates the predicate AST
   from `where()` / `order()` / `limit()`, and returns the
   filtered rows.

#### Planner step (between the predicate and the log fold)

When `Collection.where(p).all()` has a predicate AND the collection has
declared `indexes`, the reader calls `planQuery(predicate, indexes)`
(in `packages/server/src/query-planner.ts`) after the `current.json`
read and before the log fold. The planner returns either
`IndexWalkPlan{indexName, equalityKeys, rangeOn?, inOn?, postFilter?}`
— which routes the reader through `runIndexWalkPlan(plan, ctx, head)`
to LIST under the encoded index prefix and resolve only the matching
doc ids — or `FullScanPlan{reason}` — which falls through to the
snapshot+log fold. Every fetched row passes through
`matchesWire(wire, doc)` post-fetch; the re-check is load-bearing
(it defends against stale index entries AND consumes the planner's
residue `postFilter`). The plan shape and diagnostic `reason` values
are documented in [features.md](features.md) §"Secondary indexes".

The HTTP `/v1/since?cursor=<lsn>` long-poll route in
`packages/server/src/http/since.ts` is the change-notification
channel: it walks the log from a caller-supplied `lsn` and
either returns the new entries immediately or holds the request
until new entries arrive (or the long-poll deadline elapses).
The protocol-level theory lives in
[spec/sync-protocol.md](../spec/sync-protocol.md).

### After the write — the in-band maintenance tick

Durability + space reclamation happen **in-band on the write
path**, from a **single trigger site**: the writer's post-CAS
commit point (`packages/server/src/writer.ts`). After the commit
lands, the writer reads a per-request `MaintenanceDispatch` off
the observability context (`getCurrentContext()?.maintenance`,
set by the adapter) and calls `runBoundedMaintenance`
(`packages/server/src/maintenance.ts`). **Reads are pure — they
never tick.** A bare `Db.create(...)` maintains out of the box
once enough writes accrue; there is no `setInterval`, no cron, no
operator scheduler.

The bounded pass composes the two existing primitives:

- `runGc()` (`packages/server/src/gc.ts`) — the two-phase
  mark/sweep into `gc/pending.json`, **budgeted** per tier
  (`WRITE_TICK_GC_MAX_MARKS` / `..._SWEEPS`) and run on its
  **own write-count cadence** (`WRITE_TICK_GC_INTERVAL`,
  boundary-crossing) **decoupled from folds**. It deletes content
  bodies and log entries no longer reachable from any live row
  set or fence epoch.
- `compact()` (`packages/server/src/compactor.ts`) — folds a
  **sliced** tail (`maxEntriesPerRun`) into the snapshot and
  advances `log_seq_start`. The unsliceable snapshot rebuild is
  gated by a **static two-way ceiling** (`snapshot_bytes <= C`
  AND `snapshot_rows <= E`), overridable by
  `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`.

The fold's pointer advance is a **full-fence CAS**. A lost fold
is abandoned (**no lease**); its orphan snapshot is reclaimed by
`runGc` past the grace window. **Dispatch is by capability:**
Cloudflare relocates the fold past the response via
`ctx.waitUntil`; everywhere else it runs inline
(`dispatchInlineAwaited`). See
[graduation.md](../about/graduation.md) for the per-tier envelope
and ceiling math, and "Storage layout in the bucket" below for
the on-disk shape these passes produce.

## Storage seam

The kernel reads and writes through the four `Storage` methods only
(`get`/`put`/`delete`/`list`). `Storage` is injected at
`Db.create({ storage, app, tenant })` time; the kernel never
picks an impl itself.

- `S3HttpStorage` (`packages/protocol/src/storage/s3-http.ts`) for
  any HTTP endpoint. Authentication plugs in via a `sign(req)`
  callback — the protocol package itself never imports `aws4fetch`
  or any other signer; consumers choose. Production callers rarely
  construct this directly — the `s3Storage` / `r2Storage` /
  `minioStorage` / `gcsStorage` factories in `@baerly/adapter-node`
  wrap the common shapes.
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

The protocol kernel landing at three independent runtimes
(Cloudflare Workers, Node, AWS Lambda) is a load-bearing design
constraint: anything platform-specific has to live in an adapter.

## Where invariants live

- **Causal consistency:** `packages/server/src/writer.ts` and
  `packages/server/src/query.ts` — the writer mints LSNs against the
  current `next_seq` and CAS-advances `current.json` atomically; the
  reader walks `[log_seq_start, next_seq)` from a single read of
  `current.json`. A reader's observed sequence is a prefix of the
  global log. Proof:
  [spec/causal-consistency-checking.md](../spec/causal-consistency-checking.md).
- **Split-brain fencing:** `writer_fence.epoch` inside `current.json`.
  `claimWriter()` (re-exported from `@baerly/protocol`) bumps the
  epoch; an in-flight commit holding the prior epoch fails fast on
  the post-CAS fence check with `BaerlyError{code:"Conflict"}`.
- **JSON Merge Patch semantics:** `packages/protocol/src/json.ts` —
  RFC 7386 with the array-replacement convention; see
  [spec/json-merge-patch.md](../spec/json-merge-patch.md).
- **Log entry shape:** `packages/protocol/src/log.ts` — the on-the-wire
  `LogEntry` interface, stable at major versions. See
  [spec/log-entry-shape.md](../spec/log-entry-shape.md).

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
- `CommitInput` / `CommitResult` / `CommitBatchResult`
  (`packages/server/src/writer.ts`): the
  `Writer.commit` and `commitBatch` request/response shapes.
- `LogEntry` (`packages/protocol/src/log.ts`): the per-mutation log
  entry. Field set is fixed at major versions; consumers ack on
  `lsn`. Full contract in [spec/log-entry-shape.md](../spec/log-entry-shape.md).
- `Branded<T, B>` (`packages/protocol/src/types.ts`): nominal-type
  pattern. `UUID` and `ContentVersionId` are both `string`s but not
  assignable to each other.
- `BaerlyError` / `BaerlyErrorCode` (`packages/protocol/src/errors.ts`):
  discriminated-union error type. Branch on `error.code`.
- `loadSnapshotAsMap(storage, key, expectedCollection, signal?)`
  (`packages/server/src/compactor.ts`): `@public` shared utility —
  fetches a snapshot from object storage, verifies the SHA-256
  baked into the filename, and returns a `Map<_id, body>`. Internal
  callers: the compactor's fold-base load, the reader
  (`Query.runRead`), `runGc`, `rebuildIndex`, `migrate`. See
  [extending.md §5](extending.md#5-shared-utilities-on-the-public-surface).

## Storage layout in the bucket

For a `Db` constructed with `app="tickets"` and `tenant="acme"`:

- `app/tickets/tenant/acme/manifests/<collection>/current.json` — the CAS
  cursor. Holds `next_seq`, `log_seq_start`, and `writer_fence.epoch`.
- `app/tickets/tenant/acme/manifests/<collection>/log/<lsn>.json` — one
  object per `LogEntry`. Walked by readers in `[log_seq_start,
  next_seq)`.
- `tenants/acme/c/<collection>/<doc_id>` — content body for `I` / `U`.

Compaction (`packages/server/src/compactor.ts`) folds adjacent log
entries into checkpoints and advances `log_seq_start`. GC
(`packages/server/src/gc.ts`) deletes content bodies and log entries
that are no longer reachable from any live row set or fence epoch.
Both are driven in-band on the write path by
`runBoundedMaintenance` (`packages/server/src/maintenance.ts`);
the `runScheduledMaintenance` SDK is an opt-in alternative
trigger. See
[After the write — the in-band maintenance tick](#after-the-write--the-in-band-maintenance-tick).
