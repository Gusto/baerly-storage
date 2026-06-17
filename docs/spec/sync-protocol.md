---
title: Sync protocol
audience: spec
summary: Atomic document writes over object storage via single-write commit — the numbered log append is the commit (one linearizable If-None-Match create); current.json is compactor-owned compaction state with a non-authoritative tail_hint; readers discover the tail by forward-probe.
last-reviewed: 2026-06-15
tags: [protocol, sync, current-json, causal-consistency]
related:
  [
    causal-consistency-checking.md,
    log-entry-shape.md,
    json-merge-patch.md,
    writer-fence-adversarial-model.md,
    prior-art.md,
    "../adr/004-ephemeral-coordination.md",
    "../adr/008-single-write-commit.md",
  ]
---

# Sync protocol

baerly-storage turns an S3-compatible bucket into a document database by
appending to a numbered, per-collection log. Each `(app, tenant,
collection)` has a `log/<seq>.json` series and a `current.json`
control object. A commit is **one** linearizable
`If-None-Match: "*"` create on `log/<seq>.json`: the writer builds its
content body and additive index keys first, then creates the numbered
log entry — and **that create is the commit**. Readers load the
snapshot named by `current.json`, fold the log range below the
non-authoritative `tail_hint`, then forward-probe the log to discover
the true tail.

The atomic moment is the conditional `If-None-Match: "*"` create on
`log/<seq>.json`, **not** a CAS on `current.json`. `current.json` is
read for its snapshot pointer and a tail-discovery floor, not as the
authoritative head. The current kernel does not replay committed rows
by wall-clock time and does not use a reader-side list-and-repair lag
window.

This is the single-write commit design; see
[ADR-008](../adr/008-single-write-commit.md) for the decision record
it supersedes (the earlier two-write commit) and the rationale.

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

| Key                                           | Role                                                                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current.json`                                | Compactor-owned compaction-state object: snapshot pointer, `log_seq_start`, snapshot counters, plus the non-authoritative `tail_hint`. **Not** the linearization point. |
| `log/<seq>.json`                              | One `LogEntry` per mutation, keyed by monotonic integer `seq`. The create-if-absent on this key **is** the linearization point.                                         |
| `content/<sha>.json`                          | Content-addressed post-image bodies for `I` / `U`.                                                                                                                      |
| `index/<name>/...`                            | Zero-byte advisory index markers.                                                                                                                                       |
| `snapshot/L9/<000000000000>-<max>-<sha>.json` | Content-hashed materialized snapshot covering `[0, max)`. `min` and `max` are fixed-width 12-digit zero-padded; `min` is always `0`.                                    |
| `gc/pending.json`                             | Two-phase GC candidate ledger.                                                                                                                                          |

`current.json` carries compaction state plus a tail-discovery hint:

```ts
interface CurrentJson {
  schema_version: 3;
  snapshot: string | null;
  tail_hint: number;
  log_seq_start: number;
  writer_fence: {
    epoch: number;
    owner: string;
    claimed_at: string;
    lease_until?: string;
  };
  mean_entry_bytes?: number;
  snapshot_bytes: number;
  snapshot_rows: number;
  last_warned_seq?: number;
}
```

`tail_hint` is a non-authoritative monotone **lower bound** for the
live tail (it replaces the old authoritative head pointer that carried
the next sequence number), and `mean_entry_bytes` is the optional
compactor-stamped mean folded-entry size that drives the derived
live-tail estimate after the first fold (it replaces the old exact
stored-byte counter, which can no longer be writer-incremented once
commits skip `current.json`). `writer_fence` is **dormant** — no prod
path reads or writes it; its drop is deferred (see
[ADR-008 §1](../adr/008-single-write-commit.md)).

Readers fold the trusted range `[log_seq_start, tail_hint)` and then
**forward-probe** `[tail_hint, true tail)` to discover entries
committed above the hint. Entries below `log_seq_start` have already
been folded into `snapshot`. `tail_hint` is a lower bound, not an
authoritative ceiling: a committed entry may exist at or above it.
Entries at or above the discovered tail (the first 404 the probe hits)
do not exist yet.

## Required storage semantics

The `Storage` backend must provide three behaviors:

1. **Read-after-write on the same key.** A successful PUT is visible
   to a later GET of that key.
2. **Concurrent create-if-absent is exactly-one-winner.** Under N
   concurrent `If-None-Match: "*"` creates of a fresh key, **exactly
   one** succeeds (`200`) and the rest get `412`. This is **the**
   correctness prerequisite for single-write commit: the winning
   create is the commit, so a backend that admits two winners produces
   **split-brain commit** — two distinct committed entries at one
   `seq`. (Promoted from the old _sequential_ "rejects when the key
   exists" property: sequential rejection is necessary but not
   sufficient.)
3. **Compare-and-swap.** `If-Match: <etag>` rejects when the key no
   longer has the ETag the writer read. The commit path no longer uses
   CAS, but the compactor still CAS-advances `current.json`.

S3 exposes these as conditional writes with `If-None-Match` and
`If-Match`; the conformance suite requires the same semantics on each
adapter path where it runs, including the concurrent exactly-one-winner
check (fire K concurrent create-if-absent of a fresh key, assert
exactly one wins). A backend that silently ignores `If-Match` is not a
baerly-storage backend: it can lose updates without a visible error.

`baerly doctor --bucket <uri>` runs a live CAS probe against an
arbitrary bucket before deploy, including the **concurrent**
exactly-one-winner sub-check. The probe writes throwaway sentinels and
asserts stale `If-Match`, colliding `If-None-Match: "*"`, and
concurrent create-if-absent races all behave correctly. Operators
should run this probe before relying on a bucket. Cloudflare deploy can
run the same live probe when passed `--probe-bucket=<uri>` and aborts
before deploying if that opt-in preflight fails; self-hosted Node has
no deploy wrapper, so the doctor command is the manual gate.

**Deployment-topology rule — no negative caching in front of the
log/CAS path.** The log and CAS requests must hit the object-store API
**directly**, never through a negative-caching CDN or proxy. A cached
`404` on a `log/<seq>` that was just created would corrupt the
forward-probe's "first 404 = tail" signal, hiding a committed entry.
Object-store APIs are themselves strongly consistent (post-2020), so
this is a deployment-topology constraint about what sits in front of
them, not a property of the store.

## Write algorithm

`Writer.commit` is per collection. It holds no process state that is
required for correctness; each commit reads `current.json` fresh.

The shipped public writer commits one document mutation at a time and
emits one `LogEntry` per successful call. Some internal helper shapes
still accept arrays, but there is no public multi-entry batch commit
surface today.

For a single-document mutation:

1. **Read `current.json` fresh** for its snapshot pointer and
   `tail_hint`. If the collection is new, create a zero-state
   `current.json` with `If-None-Match: "*"`, then read the winner if a
   peer raced the create. `tail_hint` is used as a probe **floor** (a
   lower bound), **not** as a CAS precondition — the writer never
   CAS-advances `current.json` on the commit path.
2. **Find the true tail and mint `seq`.** Starting from
   `max(log_seq_start, tail_hint)`, run a GET-based galloping search
   (`findLogTail`) to discover the first empty log slot. That slot
   becomes `seq`. The search is Class B only; the `If-None-Match: "*"`
   create happens later, at the discovered first-empty slot.
3. **PUT content and additive (new) index keys — before the commit.**
   `I` / `U` post-images are written under `content/<sha>.json` with
   `If-None-Match: "*"`; because the body is content-addressed, a retry
   is a no-op. Additive **new** index keys are PUT (`If-None-Match:
"*"`) **before** the committing log create, so a committed row is
   _always_ index-findable — there is no window in which a committed
   doc is observed unindexed. (Stale index keys are deleted _after_ the
   commit; see step 5. Index completeness is its own invariant — see
   the index access-path notes under
   "[Read algorithm](#read-algorithm)".)
4. **Create `log/<seq>.json` with `If-None-Match: "*"` — this create
   _is_ the commit.** Winning (`200`) means committed; a `412` means
   the slot is occupied (re-probe the next seq, per the
   [contention rules](#contention-and-retries)).
5. **DELETE stale index keys — after the commit.** A DELETE mutates
   committed-doc-visible state, so it must never land for a write that
   does not commit; deleting only after the winning `log/<seq>` create
   guarantees a crash can never de-index a committed doc.

The `log/<seq>` create on step 4 is the linearization point. A reader
sees the mutation once the log entry exists and the reader's
forward-probe reaches it. There is no `current.json` write on the
commit path and no post-commit fence verify — the create-if-absent is
itself the proof of commit. `writer_fence` is dormant authority
metadata; no prod path reads or writes it.

### Contention and retries

Two writers racing the same collection discover the same first-empty
slot and contend for the `log/<seq>` create — not for a `current.json`
CAS. For any given `seq`, exactly one `If-None-Match: "*"` create wins
(`200`). A loser gets a `412`, reads the occupant back, and either
adopts its own lost-ack entry or re-runs tail discovery from `seq + 1`.
A writer racing peers may "gallop" forward through occupied slots
during tail discovery, but every slot it skips past is occupied by a
_committed_ entry, so it never leaves a hole behind it.

**A bare `412` is never proof a peer won.** Before treating a `412` as
a lost race, the writer **must read the occupant back** and
disambiguate:

- A **same-session / same-seq** occupant is this writer's _own_
  committed write whose ack was lost (a self-retry). The writer
  **adopts** it as already-committed rather than failing.
- A **foreign** occupant means a peer genuinely won that seq. The
  writer re-runs GET-based tail discovery from `seq + 1` and tries the
  new first-empty slot.

The per-commit `session` is minted once, **outside** the retry loop,
and the LSN encodes the `seq`, so a dropped ack is unambiguously
distinguishable from a genuine peer. The foreign-occupant path is
bounded by the forward-probe cap; exhausting that cap is an `Internal`
runaway alarm, not a normal high-contention conflict. Persistent
transport/storage failures still surface to the caller through the
ordinary `BaerlyError` path.

### Crash safety

The write order is content + additive (new) index keys first, the
committing `log/<seq>` create second, stale-key DELETEs last. The
single `log/<seq>` create is the only point at which the mutation
becomes committed, so every crash either leaves the doc fully
committed and index-findable or fully uncommitted.

| Crash point                                           | Bucket residue                                                                                                                        | Reader behavior                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before the log create (during content / new-key PUTs) | Unreferenced content body and orphan additive index keys may exist; the doc is **not** committed (no log entry).                      | Invisible — no committed `seq` points at the content, and an orphan additive key is a benign false-positive dropped by `matchesWire`. GC later sweeps the unreferenced content. |
| After the log create, before the stale-key DELETE     | The doc is **committed** and correctly index-findable (its new keys are already down); it may transiently carry an extra _stale_ key. | Visible and findable. The extra stale key is a benign false-positive that `matchesWire` drops.                                                                                  |

The dangerous failure of the old two-write commit — a _committed_ doc
silently **de-indexed** by a crash, which the read path can never
repair (it filters false-positives but never conjures a missing
candidate) — is **eliminated**: new keys are PUT _before_ the commit,
so a committed doc is always index-findable, and stale-key DELETEs land
only _after_ the commit, so an uncommitted write can never remove a key
a committed value depends on. The only residual is a benign
false-positive (an extra key), and it always self-heals: the doc's next
write re-emits its keys, and `rebuildIndex` is the whole-collection
operator backstop. (A bounded in-tick reconcile slice was considered
and deferred — see [ADR-008 §5](../adr/008-single-write-commit.md).)

The orphan-at-the-tail wedge of the old two-write commit is **gone by
construction**: there is no longer a head pointer to crash _between_, so
a committed log entry can never be left unacknowledged. Garbage
collection later marks and sweeps orphan content, stale log objects
below `log_seq_start`, and superseded snapshots after a grace window.
For artifacts outside the committed range, GC is cleanup, not reader
correctness: readers decide visibility from the snapshot,
`[log_seq_start, tail_hint)`, and the forward-probe.

## Read algorithm

Every read loads `current.json` fresh for its collection. If it is
missing, the collection is empty.

For a full-scan read:

1. Read `current.json`.
2. Load `current.snapshot` if it is non-null, verifying the snapshot
   body's SHA-256 against the hash embedded in its filename.
3. **Fold the trusted range, then forward-probe the tail.** Fetch
   `log/<seq>.json` for every integer in `[log_seq_start, tail_hint)`
   (the trusted, dense range) with bounded parallelism, then
   forward-probe `GET log/<tail_hint>, log/<tail_hint+1>, …` (Class B
   GETs), folding each found entry and **stopping at the first 404** —
   that 404 is the true tail. Because the live range is dense, the
   probe can never stop early inside a hole. A reader that stops at a
   stale-hint+404 still sees a valid committed _prefix_; a
   just-committed entry above a stale hint becomes visible as soon as
   the probe reaches it.
4. Fold entries in ascending `seq` order:
   - `I` / `U` with `after` set `doc_id` to that full post-image.
   - `D` deletes `doc_id`.
5. Apply the predicate, order, and limit in memory.

The index path is a derived access path over the same snapshot + log
truth. `planQuery` may choose an index prefix, fetch candidate document
IDs, and fold only the relevant log entries, then re-check the
predicate against materialized rows. Stale extra index markers can make
the path do extra work and cannot invent rows. Missing index markers can
hide rows from an index-routed query, so index completeness is a real
invariant. Newly declared or suspect indexes must be reconciled with
`rebuildIndex` before operators treat them as complete.

Marker completeness is necessary but not sufficient. For a _filtered_
(partial) index, the route is sound only when the index's filter
predicate is implied by the query predicate — otherwise the index LIST
never yields rows that fall outside the filter, and the post-fetch
predicate re-check cannot resurrect rows the LIST never returned. The
planner prefers an implied-or-unfiltered index and, as a last resort
when it is the only candidate, will still route through a non-implied
filtered index — which is unsound for that query (it can silently drop
matching rows). This last-resort path is a known limitation in
[`packages/server/src/query-planner.ts`](../../packages/server/src/query-planner.ts).

## Snapshots and compaction

The log is append-only, so write-triggered maintenance folds a prefix
of the live log into a snapshot:

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
   `snapshot_bytes` / `snapshot_rows` / `mean_entry_bytes` are updated.
   The compactor also advances `tail_hint` (monotone max). Compaction
   folds are the primary durable advancer of the hint, and write-tick
   maintenance may also rate-limit-refresh it when fold/GC work is
   disabled or deferred. Ordinary writer commits never touch
   `current.json` on the commit path. The fold CAS is therefore the
   only steady-state writer of the snapshot pointer, `log_seq_start`,
   and snapshot counters, which strengthens compaction-state atomicity.

The snapshot file is content-hashed. If a compactor crashes mid-PUT,
the body will not match its own filename hash and readers reject it.
If a compactor loses the `current.json` CAS, the snapshot is simply an
orphan; the winner's `current.json` remains authoritative.

The shipped snapshot level is `L9`. The key shape reserves room for a
future multi-level scheme, but the current kernel uses one materialized
snapshot per collection head.

## Maintenance runtime model

Compaction and GC are write-triggered and bounded. After a successful
commit (a winning `log/<seq>` create), the writer may dispatch
`runBoundedMaintenance` with the post-commit context:

- Reads never dispatch maintenance.
- The fold handles at most
  `BoundedMaintenanceOptions.maxFoldEntriesPerPass` entries per pass.
  The Cloudflare/free-safe default is
  `WRITE_TICK_FOLD_ENTRIES_PER_PASS`; the Node adapter threads the
  larger `NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS`.
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

1. **The numbered `log/<seq>` create linearizes commits.** A mutation
   becomes visible when its `If-None-Match: "*"` create wins (`200`),
   **not** via any `current.json` CAS. `current.json` is read for the
   snapshot pointer and the tail floor, never as the authoritative
   head.
2. **Concurrent create-if-absent is exactly-one-winner.** Under N
   concurrent `If-None-Match: "*"` creates of a fresh `log/<seq>`,
   exactly one wins and the rest get `412`. This is the one
   load-bearing backend prerequisite (see
   [Required storage semantics](#required-storage-semantics)); a
   backend that admits two winners produces split-brain commit.
3. **`seq` is the causal order.** The kernel reads and folds
   `log/<seq>.json` by integer sequence. The `lsn` timestamp prefix is
   an external cursor hint, not the authority for kernel ordering.
4. **The live log range is dense.** A writer always targets the
   _first_ empty seq, so `log/N` exists before `log/N+1` is ever
   attempted; the forward-probe stops at the first empty seq and
   **never skips**. A missing or malformed entry inside the trusted
   `[log_seq_start, tail_hint)` range is a protocol violation and
   surfaces as an error. This density is a protocol obligation the
   storage layer does **not** enforce — an interior hole is unhealable
   (baerly-storage has no fill primitive) — so it is fuzz-asserted rather
   than backend-guaranteed.
5. **Snapshots cover a prefix.** If `log_seq_start > 0`,
   `current.snapshot` names a snapshot that covers
   `[0, log_seq_start)`.
6. **`current.json` is compaction state, sole-written by the
   compactor in steady state.** The compactor's fold CAS is the only
   steady-state writer; `tail_hint` is a non-authoritative monotone
   lower bound, durably advanced by compaction folds and by the
   write-tick runner's tail refresh when fold/GC work defers or is
   disabled. Ordinary writer commits never refresh it inline. Other
   non-commit-path writers are explicit: the one-time `createCurrentJson`
   bootstrap, operator/import paths such as `admin restore`, and the
   best-effort `last_warned_seq` graduation stamp.
7. **A committed doc is eventually correctly indexed.** New index keys
   are emitted _before_ the commit and stale keys deleted _after_, so
   a committed value is never de-indexed by an abandoned write. The
   only residual is a benign false-positive (an extra key) dropped by
   `matchesWire`; it self-heals on the doc's next write, with
   `rebuildIndex` as the operator backstop.
8. **Reads are pure.** Reads load state; they never compact, GC, or
   tick maintenance. The tail forward-probe is Class B (GETs), so the
   idle-reader cost bound is untouched.
9. **Maintenance is bounded.** Write ticks do at most a configured
   slice of compaction or GC work. Over-ceiling folds defer and warn;
   they do not try to outrun the host.
10. **Per-collection isolation.** Each collection has its own
    `current.json` and log series. A write storm on one collection does
    not serialize unrelated collections, and cross-collection atomicity
    is not part of the protocol.
11. **`writer_fence` is not a replay filter.** The current kernel does
    not stamp log entries with fence epochs and no prod path reads or
    writes the field (it is dormant). Readers decide visibility from
    `seq`, the snapshot, the trusted log range, and the forward-probe.

## LSNs, wall clocks, and downstream consumers

Each `LogEntry` carries both:

- `seq`: the integer sequence minted as the first empty log slot found
  by the forward-probe from `current.json.tail_hint`.
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

## Commit scope is per collection

Each collection has its own numbered log series and `current.json`
control object, so each collection has its own commit hotspot at the
log tail. There is no per-tenant or per-bucket mutex.

That choice buys:

- independent progress across collections;
- one cheap compaction bookmark plus one log series per collection for
  reads and long-poll state;
- a tractable idle-reader cost bound.

It also means:

- hot single-collection workloads eventually hit conditional log-create
  contention;
- each write is atomic per document;
- cross-document atomicity requires graduating to a database that
  owns a real transaction coordinator.

The published envelope is roughly 30 sustained logical writes per
minute per collection, 10 GB per tenant, and 100 collections per
tenant. Crossing those is a graduation signal, not a protocol failure.

## Verification

The implementation is pinned by tests at three layers:

- `packages/protocol/src/storage/conformance.ts` requires CAS,
  same-key read-after-write, and the concurrent exactly-one-winner
  create-if-absent property for every adapter.
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
advance a small control object. baerly-storage's constraint is stricter
than most of those systems: the coordinator must fit inside a portable
`(Request) => Response` handler and a bucket. That rules out a
catalog service, lock table, always-on compactor, or operator-installed
scheduler.

See [prior-art.md](prior-art.md) for the detailed comparison.
