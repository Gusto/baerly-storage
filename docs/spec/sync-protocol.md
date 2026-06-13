---
title: Sync protocol
audience: spec
summary: Atomic document writes over object storage via per-collection current.json CAS, monotonic seq log, and snapshot folds.
last-reviewed: 2026-06-12
tags: [protocol, sync, current-json, causal-consistency]
related: [causal-consistency-checking.md, log-entry-shape.md, json-merge-patch.md, writer-fence-adversarial-model.md, prior-art.md, "../adr/004-ephemeral-coordination.md"]
---

# Sync protocol

Baerly turns an S3-compatible bucket into a document database by
making one small object authoritative: each `(app, tenant,
collection)` has a `current.json` file. Writers build immutable
artifacts first, then CAS-advance `current.json`. Readers read
`current.json`, load the snapshot it names, and fold the integer log
range it exposes.

The atomic moment is the conditional write on `current.json`. The
current kernel does not replay committed rows by wall-clock time and
does not use a reader-side list-and-repair lag window.

## Storage layout

For collection `tickets` under `app/helpdesk/tenant/acme`, the
collection prefix is:

```text
app/helpdesk/tenant/acme/manifests/tickets
```

The `manifests/` segment is the historical name for a collection's
control tree; the live control object inside it is `current.json`
(there is no separate "manifest" object today).

The kernel writes these objects below that prefix:

| Key | Role |
|---|---|
| `current.json` | CAS-protected control object and linearization point. |
| `log/<seq>.json` | One `LogEntry` per mutation, keyed by monotonic integer `seq`. |
| `content/<sha>.json` | Content-addressed post-image bodies for `I` / `U`. |
| `index/<name>/...` | Zero-byte advisory index markers. |
| `snapshot/L9/<000000000000>-<max>-<sha>.json` | Content-hashed materialized snapshot covering `[0, max)`. `min` and `max` are fixed-width 12-digit zero-padded; `min` is always `0`. |
| `gc/pending.json` | Two-phase GC candidate ledger. |

`current.json` carries the reader-visible head:

```ts
interface CurrentJson {
  schema_version: 2;
  snapshot: string | null;
  next_seq: number;
  log_seq_start: number;
  writer_fence: {
    epoch: number;
    owner: string;
    claimed_at: string;
    lease_until?: string;
  };
  tail_bytes: number;
  snapshot_bytes: number;
  snapshot_rows: number;
  last_warned_seq?: number;
}
```

Readers fold the live range `[log_seq_start, next_seq)`. Entries
below `log_seq_start` have already been folded into `snapshot`.
Entries at or above `next_seq` are not committed, even if an orphaned
object exists in the bucket.

## Required storage semantics

The `Storage` backend must provide three behaviors:

1. **Read-after-write on the same key.** A successful PUT is visible
   to a later GET of that key.
2. **Create-if-absent.** `If-None-Match: "*"` rejects when the key
   already exists.
3. **Compare-and-swap.** `If-Match: <etag>` rejects when the key no
   longer has the ETag the writer read.

S3 exposes this as conditional writes with `If-None-Match` and
`If-Match`; the conformance suite requires the same semantics for
every shipped adapter. A backend that silently ignores `If-Match` is
not a Baerly backend: it can lose updates without a visible error.

`baerly doctor --bucket <uri>` runs a live CAS probe against an
arbitrary bucket before deploy. The probe writes a throwaway sentinel
and asserts stale `If-Match` and colliding `If-None-Match: "*"`
requests fail loudly.

## Write algorithm

`Writer.commit` is per collection. It holds no process state that is
required for correctness; each commit reads `current.json` fresh.

For a single-document mutation:

1. **Read `current.json`.** If the collection is new, create a zero
   state `current.json` with `If-None-Match: "*"`, then read the
   winner if a peer raced the create.
2. **Mint `seq`.** The next log entry uses
   `seq = current.next_seq`. A batch uses the contiguous range
   `[current.next_seq, current.next_seq + inputs.length)`.
3. **PUT content and index artifacts.** `I` / `U` post-images are
   written under `content/<sha>.json`; index markers are PUT or
   DELETE'd inside the same attempt. These artifacts are invisible
   until the log and `current.json` advance.
4. **PUT log entries.** Each entry is written to `log/<seq>.json`
   with `If-None-Match: "*"`.
5. **CAS-advance `current.json`.** The writer sets
   `next_seq += entries.length`, adds the exact log bytes to
   `tail_bytes`, and PUTs the new `current.json` with
   `If-Match: <etag from step 1>`.
6. **Verify the writer fence.** If `writer_fence.epoch` changed
   during the attempt, the writer aborts with `Conflict` rather than
   continuing under stale authority.

The CAS on step 5 is the linearization point. A reader that sees the
old `current.json` does not see the mutation. A reader that sees the
new `current.json` folds the new log entry by integer `seq`.

### Contention and retries

Two writers racing the same collection read the same `next_seq`.
Exactly one can PUT `log/<seq>.json`; exactly one can CAS-advance the
same `current.json` ETag. A loser gets `BaerlyError{code:"Conflict"}`
from the storage layer and retries from a fresh `current.json` read,
up to the configured retry budget.

Single-entry `Writer.commit` has one extra recovery path:
self-session adoption. If a previous attempt by the same logical
commit wrote `log/<seq>.json` but lost the `current.json` CAS, the
retry may find its own log entry already present. The writer adopts
that entry only when the random per-commit `session`, the `seq`, and
the single-entry shape match. Batch commits do not adopt; they surface
the conflict to `Db.transaction`, which decides whether to re-run the
body.

### Crash safety

The write order is content/index first, log second, `current.json`
last. That order has one important property: a crash before the final
CAS leaves only orphan artifacts.

| Crash point | Bucket residue | Reader behavior |
|---|---|---|
| Before log PUT | Content/index artifacts may exist. | Invisible; no committed `seq` points at them. |
| After log PUT, before CAS | A log object may exist at an unadvanced `seq`. | Invisible; readers stop at `current.next_seq`. |
| During `current.json` PUT | Old or new `current.json` wins atomically. | Reader sees a complete old or complete new head. |

Garbage collection later marks and sweeps orphan content, stale log
objects, and superseded snapshots after a grace window. GC is cleanup,
not correctness.

## Read algorithm

Every read loads `current.json` fresh for its collection. If it is
missing, the collection is empty.

For a full-scan read:

1. Read `current.json`.
2. Load `current.snapshot` if it is non-null, verifying the snapshot
   body's SHA-256 against the hash embedded in its filename.
3. Fetch `log/<seq>.json` for every integer in
   `[log_seq_start, next_seq)`, with bounded parallelism.
4. Fold entries in ascending `seq` order:
   - `I` / `U` with `after` set `doc_id` to that full post-image.
   - `D` deletes `doc_id`.
5. Apply the predicate, order, and limit in memory.

The index path is an optimization of step 3, not a second source of
truth. `planQuery` may choose an index prefix, fetch candidate document
IDs, and fold only the relevant log entries, but it still re-checks
the predicate against materialized rows. Stale index markers can make
the path do extra work; they cannot invent rows.

## Snapshots and compaction

The log is append-only, so maintenance periodically folds a prefix of
the live log into a snapshot:

1. Read `current.json`.
2. Load the prior snapshot named by `current.snapshot`, or start from
   an empty map.
3. Fetch a bounded slice of the live log beginning at
   `log_seq_start`.
4. Fold entries onto the map using the same per-doc replacement rules
   as the read path.
5. Serialize docs sorted by `_id`, hash the bytes, and PUT
   `snapshot/L9/<000000000000>-<max>-<sha>.json` (`min` and `max` are
   fixed-width 12-digit zero-padded; `min` is always `0`).
6. CAS-advance `current.json` so `snapshot` points at the new file,
   `log_seq_start` advances to the folded end, and
   `snapshot_bytes` / `snapshot_rows` / `tail_bytes` are updated.

The snapshot file is content-hashed. If a compactor crashes mid-PUT,
the body will not match its own filename hash and readers reject it.
If a compactor loses the `current.json` CAS, the snapshot is simply an
orphan; the winner's `current.json` remains authoritative.

The shipped snapshot level is `L9`. The key shape reserves room for a
future multi-level scheme, but the current kernel uses one materialized
snapshot per collection head.

## Maintenance runtime model

Compaction and GC are write-triggered and bounded. After a successful
commit, the writer may dispatch `runBoundedMaintenance` with the
post-CAS context:

- Reads never dispatch maintenance.
- The fold handles at most `WRITE_TICK_FOLD_ENTRIES_PER_PASS` entries
  per pass.
- The fold starts only while the snapshot is under both ceilings:
  bytes `C` (`snapshot_bytes <= C`) and rows `E` (checked with a
  look-ahead term, `snapshot_rows + maxFoldEntriesPerPass <= E`).
  Only the byte ceiling is operator-overridable:
  `C` defaults to `MAINTENANCE_MAX_FOLD_BYTES_DEFAULT` and can be
  raised via `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`, whereas `E`
  (`MAINTENANCE_MAX_FOLD_ROWS`) is a hardcoded constant with no env
  override.
- GC marks and sweeps bounded batches from `gc/pending.json`.
- Cloudflare can defer the tick past the response with
  `ctx.waitUntil`; Node runs inline unless the host wraps it
  differently.

There is no daemon, lease service, scheduler, or background thread.
`runScheduledMaintenance` is an exported convenience for teams that
want an explicit maintenance window; it is not required for
correctness.

The doctrine and trade-offs live in
[ADR-004](../adr/004-ephemeral-coordination.md). Capacity thresholds
and operator actions live in
[graduation.md](../about/graduation.md).

## Protocol invariants

These are the load-bearing rules.

1. **`current.json` linearizes commits.** A mutation becomes visible
   only when the `current.json` CAS succeeds.
2. **CAS is mandatory.** `If-Match` and `If-None-Match: "*"` must be
   honored by the backend.
3. **`seq` is the causal order.** The kernel reads and folds
   `log/<seq>.json` by integer sequence. The `lsn` timestamp prefix is
   an external cursor hint, not the authority for kernel ordering.
4. **The live log range is contiguous.** A missing or malformed entry
   inside `[log_seq_start, next_seq)` is a protocol violation and
   surfaces as an error.
5. **Snapshots cover a prefix.** If `log_seq_start > 0`,
   `current.snapshot` names a snapshot that covers
   `[0, log_seq_start)`.
6. **Reads are pure.** Reads load state; they never compact, GC, or
   tick maintenance.
7. **Maintenance is bounded.** Write ticks do at most a configured
   slice of compaction or GC work. Over-ceiling folds defer and warn;
   they do not try to outrun the host.
8. **Per-collection isolation.** Each collection has its own
   `current.json`. A write storm on one collection does not serialize
   unrelated collections, and cross-collection atomicity is not part
   of the protocol.

## LSNs, wall clocks, and downstream consumers

Each `LogEntry` carries both:

- `seq`: the integer sequence minted from `current.json.next_seq`.
- `lsn`: an opaque cursor shaped
  `<base32-time>_<session>_<seq-fragment>`.

The timestamp component uses descending base-32 encoding so ordinary
lexicographic listing can find recent LSN-shaped keys efficiently in
contexts that store by LSN. The kernel does not use that ordering for
correctness. It reconstructs `log/<seq>.json` directly from integer
`seq`. This ordering property is verified by
[`packages/protocol/src/lsn-reverse-list.test.ts`](../../packages/protocol/src/lsn-reverse-list.test.ts)
and quantified by [`bench/lsn-reverse-walk.ts`](../../bench/lsn-reverse-walk.ts)
against the pinned baseline at
[`docs/spec/attachments/lsn-reverse-walk-baseline.json`](attachments/lsn-reverse-walk-baseline.json)
(`pnpm bench:lsn-reverse-walk`).

`LAG_WINDOW_MILLIS = 5000` remains the named tolerance for wall-clock
skew in log timestamps consumed outside the kernel. A writer whose
clock regresses can mint an `lsn` whose time prefix sorts before a
causally earlier entry; this cannot reorder kernel reads, because
kernel reads sort by `seq`. Downstream CDC/export consumers must sort
by `seq`, not by the timestamp prefix.

## CAS scope is per collection

Each collection has its own `current.json`, so each collection has its
own CAS hotspot. There is no per-tenant or per-bucket mutex.

That choice buys:

- independent progress across collections;
- one cheap head object per collection for reads and long-poll state;
- a tractable idle-reader cost bound.

It also means:

- hot single-collection workloads eventually hit CAS contention;
- transactions are scoped to one collection;
- cross-collection atomicity requires graduating to a database that
  owns a real transaction coordinator.

The published envelope is roughly 30 sustained logical writes per
minute per collection, 10 GB per tenant, and 100 collections per
tenant. Crossing those is a graduation signal, not a protocol failure.

## Verification

The implementation is pinned by tests at three layers:

- `packages/protocol/src/storage/conformance.ts` requires CAS and
  same-key read-after-write behavior for every adapter.
- `tests/fixtures/randomized-cascade.ts` drives the all-to-all
  causal-consistency cascade across memory, local-fs, Minio, and
  Cloudflare R2 variants.
- `tests/integration/phase5-end-to-end.test.ts` and
  `phase5-crash-fuzz.test.ts` exercise compaction, GC, crash
  injection, read parity, object-count drain, and the idle-reader
  cost bound.

Adding a storage adapter must add a conformance path and a randomized
cascade variant. Touching the write path, log walk, compactor, or GC
requires updating this spec and the relevant property tests.

## Prior art

The protocol uses the same broad move as Git, Iceberg, Delta Lake,
Litestream, and SlateDB: write immutable artifacts, then atomically
advance a small control object. Baerly's constraint is stricter than
most of those systems: the coordinator must fit inside a portable
`(Request) => Response` handler and a bucket. That rules out a
catalog service, lock table, always-on compactor, or operator-installed
scheduler.

See [prior-art.md](prior-art.md) for the detailed comparison.
