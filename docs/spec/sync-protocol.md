---
title: Sync protocol
audience: spec
doc_type: current-contract
summary: Atomic document writes over object storage via single-write commit — the numbered log append is the commit (one linearizable If-None-Match create); current.json is compactor-owned compaction state with a non-authoritative tail_hint; readers discover the tail by forward-probe.
last-reviewed: 2026-11-13
tags: [protocol, sync, current-json, causal-consistency]
related:
  [
    causal-consistency-checking.md,
    log-entry-shape.md,
    json-merge-patch.md,
    writer-fence-adversarial-model.md,
    prior-art.md,
    "../adr/002-ephemeral-coordination.md",
    "../adr/004-single-write-commit.md",
  ]
---

# Sync protocol

A conforming `Storage` backend gives the protocol one hot-path
arbitration primitive: create a named object only if it does not already
exist. baerly-storage uses that primitive on the next numbered log
entry, not on `current.json`.

For each `(app, tenant, collection)`, the bucket holds a
`log/<seq>.json` series and a `current.json` control object. The writer
serializes the `I` / `U` post-image into `LogEntry.after`, then creates
exactly one numbered log object with `If-None-Match: "*"`, the commit's
only write. If that create succeeds, the mutation
is committed at that `seq`; no later `current.json` CAS is needed.

The live log is dense: writers target the first missing sequence
number, and readers stop at the first missing sequence number. In this
spec, the tail means that first missing sequence number: the exclusive
upper bound of committed log entries. If `log/0` through `log/6` exist
and `log/7` is missing, the committed tail is 7. `current.json` can tell
readers where to start looking, but it cannot decide where the tail is.

The atomic moment is therefore the conditional `If-None-Match: "*"`
create on `log/<seq>.json`, **not** a CAS on `current.json`. The current
kernel orders rows by integer `seq` and discovers the end by probing to
the first missing log entry; it does not replay committed rows by
wall-clock time or use a reader-side list-and-repair lag window.

This is the single-write commit design; see
[ADR-004](../adr/004-single-write-commit.md) for the decision record
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

The collection prefix may contain these objects:

| Key                                           | Role                                                                                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current.json`                                | Compactor-owned compaction-state object: snapshot pointer, `log_seq_start`, snapshot counters, plus the non-authoritative `tail_hint`. **Not** the linearization point. |
| `log/<seq>.json`                              | One `LogEntry` per mutation, keyed by monotonic integer `seq`. The create-if-absent on this key **is** the linearization point.                                         |
| `content/<sha>.json`                          | Side object emitted by a legacy writer. Inert: no reader opens one and GC does not touch the prefix. See [Legacy content side objects](#legacy-content-side-objects).   |
| `index/<name>/...`                            | Legacy zero-byte index markers written before 0.7. Inert: never read, written or reclaimed; the prefix stays reserved. See [Legacy index markers](#legacy-index-markers). |
| `snapshot/L9/<000000000000>-<max>-<sha>.json` | Content-hashed materialized snapshot covering `[0, max)`. `min` and `max` are fixed-width 12-digit zero-padded; `min` is always `0`.                                    |
| `gc/pending.json`                             | Two-phase GC candidate ledger (orphan-snapshot and orphan-content only; stale logs are reclaimed by computed range, not listed).                                                                                                                                          |

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
  log_delete_floor?: number;
  generation?: string;
}
```

`tail_hint` exists to shorten tail discovery, not to certify the end of
the log. If the true tail is 7 and `tail_hint` is 5, entries 5 and 6
are still committed. The reader must find them by probing forward.

`tail_hint` is a non-authoritative monotone **lower bound** for the live
tail: the protocol requires it to be less than or equal to the true
tail. It can be stale low; a value above the true tail is a protocol
violation. Readers must probe at and above it. It replaces the old
authoritative head pointer that carried the next sequence number.

`mean_entry_bytes` is the optional compactor-stamped mean folded-entry
size that drives the derived live-tail estimate after the first fold. It
is a maintenance sizing estimate, not tail authority. It replaces the
old exact stored-byte counter, which can no longer be writer-incremented
once commits skip `current.json`.

`log_delete_floor` is the exclusive upper bound of the contiguous log
prefix certified deleted: every `log/<seq>.json` below it is gone from
the bucket. An absent field or `0` means no deleted prefix is certified;
it does not claim that existing GC has never deleted a sparse log object.

`writer_fence` is **dormant** authority metadata: no production
commit/read path uses it for authority. Its drop is deferred (see
[ADR-004](../adr/004-single-write-commit.md#decision)).

Readers fold `[log_seq_start, tail_hint)`, the range `current.json`
asserts is committed but not snapshotted. A missing entry inside that
range is an error. Then readers **forward-probe** from
`max(log_seq_start, tail_hint)` to the first missing log entry. For
valid `current.json`, that normally starts at `tail_hint`. Entries below
`log_seq_start` have already been folded into `snapshot`. The first 404
marks the prefix this read can trust: `log/<tail>` was absent when
probed, and entries at or above it are outside this read's prefix.
Later commits may appear there.

### Legacy content side objects

Current writers do not create `content/<sha>.json`. Buckets written by
legacy writers that emitted content side objects may still contain
them, and during a mixed v0.6.0 rollout v0.6.0 nodes may still create
them. No kernel reader opens one, and GC never marks, sweeps, or
otherwise touches the `content/` prefix — the objects are inert and
cost only storage.

A legacy `orphan-content` candidate left in a v0.6.0 `gc/pending.json`
is resolved out of the ledger without a DELETE. The collector cannot
classify a key whose liveness set no longer exists, and retaining the
candidate would wedge the ledger's bounded head against every later
mark.

Verified v0.6.0 buckets therefore require no migration. An operator who
wants the bytes back deletes the prefix directly — see
[Legacy content cleanup](../guide/backups.md#legacy-content-cleanup).
The key and hash layout needed to interpret an object that already
exists is in
[`log-entry-shape.md`](log-entry-shape.md#legacy-content-side-object-layout).

### Legacy index markers

Current writers create nothing under `index/`. Writers before 0.7 PUT a
zero-byte marker there per declared index a write touched, and during a
mixed 0.6 / 0.7 rollout 0.6 nodes still do. No 0.7 reader, writer, GC
pass or `fsck` opens the prefix: reads and insert uniqueness take
membership from the snapshot plus the committed log, so a missing, stale or
extra marker changes no result. The prefix stays reserved. Deleting it,
and the rollback consequence of 0.7 writes carrying no markers, are in
[Legacy index markers](../guide/backups.md#legacy-index-markers).

## Required storage semantics

On the ordinary commit path, writers do not race to update
`current.json`. They race to create the same fresh numbered log key.
Separately, compaction still needs CAS on `current.json`. The `Storage`
backend must provide three behaviors:

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
concurrent create-if-absent races all behave correctly. Operators should
run this probe before relying on a bucket. Cloudflare deploy can run the
same live probe when passed `--probe-bucket=<uri>` and aborts before
deploying if that opt-in preflight fails; self-hosted Node has no deploy
wrapper, so the doctor command is the manual gate.

**Deployment-topology rule — no negative caching in front of the
log/CAS path.** The log and CAS requests must hit the object-store API
**directly**, never through a negative-caching CDN or proxy. A cached
`404` on a newly created `log/<seq>` would corrupt the
forward-probe's "first 404 = tail" signal, hiding a committed entry.
The conformance and live probe checks validate the direct object-store
API path; this is a deployment-topology constraint about anything placed
in front of that path, not a substitute for backend probing.

## Write algorithm

`Writer.commit` is per collection and carries no authority between
calls. Each commit reads `current.json` fresh; correctness comes from
the conditional log create, not from process-local writer state.

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
   becomes `seq`. The search is Class B (GET/read-class) only; the
   `If-None-Match: "*"` create happens later, at the discovered
   first-empty slot. The walk is capped by `LOG_FORWARD_PROBE_CAP`; cap
   exhaustion is an `Internal` runaway alarm, not normal contention. The
   write verbs instead probe linearly from their pre-commit read's tail
   and validate the entries they pass; see
   [Insert: the first `I` wins](#insert-the-first-i-wins),
   [Capacity: the commit-time re-check](#capacity-the-commit-time-re-check),
   and [Update and delete: decided on the newest row version](#update-and-delete-decided-on-the-newest-row-version).
3. **Serialize `LogEntry.after`.** `I` / `U` post-images are serialized
   into the `LogEntry.after` field; current writers create no content
   side object and no index object. Reads and insert uniqueness use the
   authoritative snapshot-plus-log fold, whatever indexes a collection
   declares.
4. **Create `log/<seq>.json` with `If-None-Match: "*"` — this create
   _is_ the commit.** Winning (`200`) means committed; a `412` means
   the slot is occupied (re-probe the next seq, per the
   [contention rules](#contention-and-retries)). It is the commit's only
   write.

The `log/<seq>` create on step 4 is the linearization point. A reader
sees the mutation once the log entry exists and the reader's
forward-probe reaches it. There is no `current.json` write on the
commit path and no post-commit fence verify — the create-if-absent is
itself the proof of commit. `writer_fence` is dormant authority
metadata; no production commit/read path uses it for authority.

### Contention and retries

Two writers racing the same collection may discover the same first-empty
slot and contend for the `log/<seq>` create, not for a `current.json`
CAS. For any given `seq`, exactly one `If-None-Match: "*"` create wins
(`200`). A loser gets a `412`, reads the occupant back, and either
adopts its own lost-ack entry or re-runs tail discovery from `seq + 1`.
A writer racing peers may "gallop" forward through occupied slots
during tail discovery, but every slot it skips past is occupied by a
_committed_ entry, so it never leaves a hole behind it.

**A bare `412` is never proof a peer won.** Before treating a `412` as
a lost race, the writer **must read the occupant back** and
disambiguate:

- A **same-session / same-seq / same-entry** occupant is this writer's
  _own_ committed write whose ack was lost (a self-retry). The writer
  **adopts** it as already-committed rather than failing. Adoption is
  only sound for the single-input commit shape shipped today.
- A **foreign** occupant means a peer genuinely won that seq. The
  writer re-runs GET-based tail discovery from `seq + 1` and tries the
  new first-empty slot.

The per-commit `session` is minted once, **before** the first create
and reused across forward probes, and the LSN encodes the `seq`, so a dropped ack is unambiguously
distinguishable from a genuine peer. The foreign-occupant path is
bounded by the forward-probe cap; exhausting that cap is an `Internal`
runaway alarm, not a normal high-contention conflict. Failures before the
committing create is dispatched surface through the ordinary `BaerlyError`
path. A failed committing-create call gets one readback because a
storage adapter may report failure after an internal attempt became durable,
or, when the call was provably not applied, because a throttle may hide a
lost race.
The `AmbiguousCommit` contract below applies when readback cannot resolve it.

### Insert: the first `I` wins

Of concurrent inserts of one `doc_id`, at most one commits (exactly one,
absent storage failures); the others fail with
`BaerlyError{code:"AlreadyExists"}` and commit nothing, unless an
identical `mintedId` resend replays the stored row (**SDK-minted replay**,
below). A row is live when the last entry for its `(collection, doc_id)` is
an `I` or `U`, and an insert may commit only while the row is absent. The rule is enforced by
backward validation over the slice of the log the insert's own check could
not see:

1. **Check read.** `Collection.insert` folds the collection through the
   tail `T0` its forward-probe found, on the full-scan path. A live row
   there fails the insert before the writer runs. Otherwise the doc is
   absent at `T0`, and the insert commits with `T0` as its guard.
2. **Window read, before any write.** After reading `current.json`, the
   writer reads every entry in `[T0, seq)`, where `seq` is the slot it will
   create. Slots in `[T0, log_seq_start)` that a fold moved below the floor
   are read with point GETs. A missing one (retired by log retention) fails
   the insert with retriable `WriteConflict`, because the window can no
   longer be checked. The rest of the window is the tail probe itself,
   started at `max(T0, log_seq_start)` and collecting every entry it passes;
   uncontended, `T0` is the tail and the probe is one `404` GET.
3. **Window decision.** If the last entry for this doc in the window is an
   `I` or `U`, a peer's insert won: the insert fails with `AlreadyExists`
   before it writes anything. A `D`, or no entry, lets it proceed.
4. **Lost create race.** A foreign occupant at `seq`, and every entry the
   forward probe from `seq + 1` passes, join the window, and step 3 runs
   again before the next create. A live row there fails the insert with
   `AlreadyExists`: the occupant proves this commit's send did not land at
   `seq`, so nothing of the insert was written.

**SDK-minted replay.** An HTTP insert whose body carries `mintedId` (a
canonical UUIDv7 equal to `doc._id`) is a client resending an insert of an
`_id` it minted. At step 1 and at every step-3 decision, a live last entry
whose `after` equals the insert's post-image after a JSON round-trip (key
order ignored) is treated as replay success: the insert returns
`{ _id }` and writes nothing, with no create and no maintenance tick. Any
other live row still fails with
`AlreadyExists`, and an insert without `mintedId` never replays, so a
caller-chosen `_id` keeps at most one winner. Equality is against the current
live row, not a retained request result: deletion permits reinsertion, an
update to a different body yields `AlreadyExists`, and updating back to the
original body permits replay. Calling the client's `insert(doc)` again is a
new operation and mints a new auto-ID.

Own-entry adoption, `AmbiguousCommit` precedence (an unresolved create fate
is reported as `AmbiguousCommit`, never as `AlreadyExists`), and reads are
unchanged. The guard is part of the writer, so the rule holds once every
writer on a collection runs a kernel that applies it; a writer on an older
kernel does not read the window, and its insert can still land a second `I`
over a concurrent one.

### Capacity: the commit-time re-check

The write verbs refuse growth past the serving host's fold ceiling
(`CapacityExceeded`, `MaintenancePending`) from the state their pre-commit
read folded through tail `T0`. Two concurrent growth writes can each pass
that check and together pass the ceiling, so the decision runs again at
commit time over the entries the read could not see:

1. The writer reads the window `[T0, seq)` exactly as an insert does
   (steps 2 and 4 above, shared with the insert guard on an insert). For an
   update or delete this replaces the galloping tail search; uncontended it
   is the same single `404` GET.
2. An empty window means nothing intervened: the pre-commit decision
   stands and nothing is recomputed. Otherwise the decision re-runs over
   the read's tail plus the window, for this write and the batch rows
   after it, before the first create, and again after each lost create
   race before the next create. A refusal commits nothing.
3. In a batch, each row's window starts one past the previous row's
   committed seq, so no entry is read twice. A refusal there stops the
   batch with the earlier rows applied.

The insert decision runs first, so a peer's live row is `AlreadyExists`
whatever the capacity re-check says. Direct `Writer` commits are not
checked.

### Update and delete: decided on the newest row version

An update reads the row, merges its patch, and commits the full post-image
as `LogEntry.after`. Committing the post-image built from the read would
undo a write to the same `_id` that committed after the read: a delete
would be resurrected, a change to another field lost. A delete built from
the read would tombstone a row that a peer had already deleted and
re-inserted, or one that no longer matches its predicate. The write verbs
instead follow PostgreSQL READ COMMITTED's EvalPlanQual, decided in the
same commit window as the capacity re-check:

1. **Newest version.** At each window decision (before the first create,
   and again after each lost create race), the verb looks for entries on
   the row's `_id` among everything committed after its read: the window
   `[T0, seq)`, plus, in a batch, the windows of the rows already committed.
   No entry means the read's version is still the newest, and the planned
   post-image commits unchanged.
2. **Deleted there: skip.** A `D` on the `_id` means the row the verb read
   is gone, so the row commits nothing, even if a later `I` re-created the
   `_id` (a different row). `update(id, patch)` returns `{ modified: 0 }`
   (`404 NotFound` over HTTP); `.where(p).update()` skips the row and does
   not count it; `replace(id, doc)` throws `NotFound`; `delete` skips the
   row and does not count it, so of two racing deletes one reports
   `deleted: 1` and the other `0`.
3. **Rewritten there: re-decide.** For an update or a delete, `p` is
   evaluated again on the newest post-image (`order` and `limit` are not).
   If it no longer matches, the row is skipped as in step 2. Otherwise an
   update's patch is merged onto the newest post-image, schema-validated,
   and that becomes the commit's post-image, and a delete tombstones the
   row. A `replace` keeps its document: it is last-writer-wins against
   updates.

The result is that every committed `U` from an update is its patch merged
onto the entry immediately before it for that `_id`, and no `U` follows a
`D` of its row, and every committed `D` follows a live version of its row.
No new error is thrown.

A batch's forced maintenance tick rides its last planned row's commit;
when that row is skipped, the verb dispatches the forced tick itself
after its last commit, so rows committed under pressure still drive the
fold.

### Unresolved create fate

Retries happen at one layer. The `Storage` adapter retries each request
under the storage retry policy (`STORAGE_RETRY_MAX_ATTEMPTS` attempts in
total), so the writer issues exactly one `Storage.put` per slot and never
resends a create at the same slot. A lost acknowledgement needs no resend:
the adapter's own next attempt sees the landed object as a `412`, or the
readback finds it. Before reporting a failed committing create, the writer
reads the slot back with one `Storage.get`, which the adapter likewise
retries; the writer does not re-read. An exact own-entry occupant is
adopted as committed. An identified foreign occupant advances the writer
to the next slot. A missing, unreadable, malformed, or otherwise
unidentifiable occupant cannot prove that no internal attempt committed,
so the writer reports
`BaerlyError{code:"AmbiguousCommit"}` with `retriable: false`.

`AccessDenied` and `InvalidConfig` from a slot's send skip the readback
and propagate as-is. The `Storage.put` contract makes them definitive for a
create-only put: an adapter that retries internally reports a rejection that
follows an attempt of unknown outcome as `NetworkError` instead. A
`NetworkError` whose `cause.notApplied` is `true` guarantees that no attempt of
that call was applied or can still apply: the adapters set it when every
internal attempt was provably throttled before applying (`429` or S3's
`503 SlowDown`) or refused before issue (the Workers subrequest limit,
which the R2 adapter does not retry). An adapter builds it as
`new BaerlyError("NetworkError", msg, { cause: { notApplied: true } })`.
The writer still reads the slot back once, since a throttle can hide a create
race lost with a `429` instead of a `412`. An own-entry occupant is adopted
and an identified foreign occupant advances the writer to the next slot, as
above. An empty, unreadable, malformed, or otherwise unidentifiable slot
propagates the original retriable `NetworkError`: the adapter's guarantee
already proves that retrying cannot duplicate this create.

R2 error `10058` uses the throttle backoff but retains an unknown create
outcome (`cause.mayHaveApplied`), since Cloudflare does not document that it
proves an unapplied write. A later definitive rejection cannot erase that
uncertainty. An empty readback is still `AmbiguousCommit`: a negative read
does not prove an unresolved write will never land. This
contract is scoped to failed committing-create calls;
earlier read, configuration, and index-write errors keep their ordinary error behavior. The same code also covers the
certified-delete-floor case described in invariant 5: a create may have
landed beneath every reader's floor, and durable state cannot establish
whether an earlier attempt was folded before retirement.

Callers should re-read the affected row by its stable `_id` and compare it with
the intended state before deciding what to do. A matching row can help
reconcile the outcome, but absence is not proof that the create failed: a send
may still complete, or a later write may have superseded the effect. Retrying
is an explicit at-least-once choice and may repeat logical work. The error
carries the affected row's `_id` (`BaerlyError._id`, and `error._id` in the
HTTP envelope), including the id an auto-ID insert minted, so a retry can reuse
it: every create for one `_id` targets one row, so a same-`_id` retry cannot
mint a second document. It does not make retries idempotent or provide
exactly-once execution across calls, restarts, or lost responses; a replayed
post-image can still overwrite a concurrent change. For multi-row operations,
rows committed before the ambiguous row remain applied; the operation does not
return its partial-progress count.

### Per-invocation request budget

Each invocation (an HTTP request, a Workers cron tick) carries one request
ledger, set by the adapter on the observability context. The retry policy
charges it before every attempt, so adapter retries and `list` pages are
charged as they are issued, and work in `ctx.waitUntil` charges the
ledger of the request that dispatched it. An attempt the ledger has no room
for is never sent: it fails with
`BaerlyError{code:"CapacityExceeded"}` whose cause carries `refused: true`,
which ends the retry loop. A committing create refused before any attempt
of uncertain outcome keeps `CapacityExceeded` and carries `notApplied`; the
writer treats it like a `notApplied` `NetworkError`, so an empty or
unreadable readback (the ledger refuses that too when nothing is left)
surfaces the `CapacityExceeded` refusal, with nothing committed. Refused
after an attempt of uncertain outcome, the create is a `NetworkError` with an
unknown fate, which the writer resolves by readback as above.

The ledger has two pools: `internal`, charged for every storage call, and
`external`, charged as well for a call that leaves through `fetch` (S3 over
HTTP, GCS) or the Cache API. The R2 binding charges `internal` only. The
limits follow the Workers maintenance profile:

| Profile | `internal` | `external` |
| --- | --- | --- |
| `cf-free` (default) | `CF_FREE_INTERNAL_REQUEST_LIMIT` (900) | `CF_FREE_EXTERNAL_REQUEST_LIMIT` (45) |
| `cf-paid` | `CF_PAID_REQUEST_LIMIT` (9,000) | `CF_PAID_REQUEST_LIMIT` (9,000) |
| Node | counted, never refused | counted, never refused |

**Commit-resolution reserve.** Once its committing create is sent, a write
may still need one occupant readback and the delete-floor `current.json`
read to know its fate; without room for them, a create that landed but lost
its reply becomes `AmbiguousCommit`. So each slot's attempt (the create,
the readback and the floor read) runs under a ledger **hold** of
`STORAGE_RETRY_MAX_ATTEMPTS + COMMIT_RESOLUTION_RESERVE` = 9 requests (the
create at full retries, plus 6 for the readback and the floor read),
whatever indexes the collection declares. The writer takes the hold only if the
ledger's room, net of other holds, covers it, and otherwise refuses with
`CapacityExceeded`, nothing written. Only calls made in the attempt's own
async context draw on the hold; every other call in the invocation, a
`ctx.waitUntil` write tick of an earlier row included, sees the room net of
it, so concurrent work cannot spend the reserve. After a lost create race
the hold is released (the foreign occupant proves this commit's only send
did not land, so a refusal from there is clean), the forward probe runs,
and the next slot takes a new hold. Only a call outside every hold that the ledger cannot refuse
(the read cache's post-write invalidation) or a platform cap below the
ledger's limit can still cut into a hold; then the create resolves as
described above (`CapacityExceeded` when the create was never sent,
`AmbiguousCommit` when a sent create cannot be read back). The write tick
runs after the hold and swallows a refusal, leaving the commit
acknowledged.

A multi-row update or delete commits row by row, so a refusal part-way
keeps the rows already committed, commits neither the refused row nor any
after it, and surfaces the `CapacityExceeded`; nothing is ambiguous.

Each limit keeps a margin under the platform cap (1,000 internal and 50
external on Free, 10,000 on Paid) for calls the ledger does not see, such
as the verifier's JWKS fetch. The Worker's read cache charges each Cache API
call to `external`, at most `CF_CACHE_API_MAX_CALLS` per invocation; a cache
`match` or `put` without room is skipped and the request is served from
storage, and the invalidation after a write is always sent.

The `/v1/since` long-poll reads the ledger and never runs past it, so it
never fails with the ledger's `CapacityExceeded`. Each poll cycle starts
only with room for an idle one (two GETs: `current.json` and the probe at
the cursor), and its entry reads and probe are capped by what is left. Out
of room, the request returns the entries it has read, a prefix whose
`next_cursor` resumes after the last one, or, having waited at least one
poll interval, an empty batch at the same cursor. A request without room
for its first cycle returns `MaintenancePending` (503, `Retry-After`), so
an empty batch never comes back sooner than one interval. On `cf-free`
with storage over `fetch` this shortens an idle long-poll to about 22 of
its 25 seconds; elsewhere the timeout ends it first.

The write tick a commit dispatches shares that ledger, so it sizes each
phase at the phase's start from what the ledger has left on the pool its
storage charges, net of active holds, with the host profile's per-pass
caps as ceilings. The tick is dispatched outside every commit hold, so a
tick that runs while a multi-row write continues sizes against the room
the later rows' commit-resolution reserves leave, and never plans to spend
them. A fold needs `MAINTENANCE_FOLD_BASE_REQUESTS` (5) plus the entries
it would fold and is skipped, never shortened, when that does not fit: the
growth refusal models fold passes of exactly `maxFoldEntriesPerPass`
entries. A GC slice needs `MAINTENANCE_GC_BASE_REQUESTS` (6) and runs with
its sweep cap lowered to what is left after that, or is skipped when
nothing is. The `tail_hint` refresh needs
`MAINTENANCE_TAIL_HINT_REFRESH_REQUESTS` (2). These are common-path costs
(each call answered first time, no contention). A retry or a concurrent
writer can still overrun one; the ledger refuses that call before it is
sent and the tick ends quietly
(`db.maintenance.request_budget_refused_total`). A fold or GC slice cut
short this way leaves nothing the next tick cannot redo: an unpublished
snapshot is an orphan GC collects, and an unrecorded sweep is swept again.
A skipped phase counts `db.maintenance.request_budget_skipped_total`
(label `phase`).

Log retirement is sized for every attempt instead, because it moves
`log_delete_floor` past its range before it DELETEs that range, and the
next pass starts at the floor: a DELETE that fails after the floor CAS
leaks that log object. The pass takes at most
`(remaining − MAINTENANCE_RETIRE_PRE_FLOOR_REQUESTS) / STORAGE_RETRY_MAX_ATTEMPTS`
DELETEs (`MAINTENANCE_RETIRE_PRE_FLOOR_REQUESTS` = 7, the most it can be
charged before the CAS lands), so the ledger never refuses one of them on
its own account. A crash, a DELETE that fails all its attempts, or calls
charged concurrently by other work in the same invocation between the
floor CAS and the DELETEs still leak the objects not deleted (they are
never read again, only stored); that window predates the ledger.

### Read admission

A read whose work does not fit the serving request is refused whole with
`CapacityExceeded`, never answered with a truncated row set, and a read that
fits returns the same rows on every host. A refused read writes nothing and
dispatches no maintenance, so a read never carries `MaintenancePending`.
Admission runs in two stages (`packages/server/src/read-admission.ts`):

1. **Head.** From `current.json` alone, the read is refused when its work is
   certain not to fit. `tail_hint` is a lower bound on the tail, so the
   strict range `[log_seq_start, tail_hint)`, the snapshot GET and the
   probe's closing empty slot are a lower bound on the storage calls; when
   that is more than the request ledger has left, the read is refused
   before its snapshot GET.
2. **Staged.** The ledger charges each storage call as it is issued. The
   forward probe past `tail_hint` is capped at
   `min(LOG_FORWARD_PROBE_CAP, ledger remaining)` (`forwardProbeCap` in
   `log-tail.ts`, shared by every read path that probes); exhausting a
   ledger-set cap is `CapacityExceeded`, exhausting `LOG_FORWARD_PROBE_CAP`
   remains the `Internal` runaway alarm.

The host may also set a read envelope on the observability context
(`readEnvelope`): snapshot bytes and rows (checked from the head before the
snapshot GET), tail entries and bytes (each stored body charged before it is
decoded), rows materialized before predicate, sort and limit, and rows in
the answer (a count is exempt). Every read, index-covered or not, is a full
fold (see [Read algorithm](#read-algorithm)), so these are also the bounds
on an index-covered read: its work is the snapshot rows plus the tail
entries it materializes, and there is no index-specific bound. Two
collections with identical heads but different tails are told apart at the
staged checks. No shipped profile sets the data bounds
yet; the Worker sets only the request pool its storage charges, so the head
check is exact for the R2 binding and for `fetch` storage.

### Crash safety

Crashes fall on one side of the commit line: serializing `LogEntry.after`
is preparation and the `log/<seq>` create is the commit. The single
`log/<seq>` create is the commit's only write and the only point at which
the mutation becomes committed. Reads reconstruct visibility from the
snapshot and log.

| Crash point | Bucket residue | Reader behavior |
| --- | --- | --- |
| Before the log create | Nothing of the commit. | The uncommitted row is invisible. |
| After the log create | The committed entry. | The committed row is visible from the log. |

The orphan-at-the-tail wedge of the old two-write commit is **gone by
construction**: there is no longer a head pointer to crash _between_, so
a committed log entry can never be left undiscoverable behind
`current.json`. Two separate passes reclaim what the fold leaves
behind. Superseded snapshots are marked and swept by garbage
collection, under the existing grace and revalidation checks. Log
objects below `log_seq_start` are not: they are retired over a computed
sequence range with no grace and no ledger, because a certified
`log_delete_floor` — CASed before the DELETEs — is a stronger guarantee
than a timer. For artifacts outside the
committed range, both passes are cleanup, not reader correctness:
readers decide visibility from the snapshot, `[log_seq_start,
tail_hint)`, and the forward-probe.

## Read algorithm

Every read loads `current.json` fresh for the collection to get the
snapshotted prefix and the probe start for newer commits. If
`current.json` is missing, the collection is empty. Otherwise, a
read reconstructs the collection from a snapshot plus a
numbered log suffix.

For every read:

1. Read `current.json`.
2. Load `current.snapshot` if it is non-null, verifying the snapshot
   body's SHA-256 against the hash embedded in its filename.
3. **Fold the trusted range, then forward-probe the tail.** Fetch
   `log/<seq>.json` for every integer in `[log_seq_start, tail_hint)`
   (the trusted, dense range) with bounded parallelism, then
   forward-probe from `max(log_seq_start, tail_hint)` (normally
   `tail_hint`) using Class B (GET/read-class) operations. Fold each
   found entry and **stop at the first 404**. If the probe reaches a 404
   within the cap, that 404 is the discovered tail for this read. For
   example, with `tail_hint = 5` and committed entries at 5 and 6, the
   reader folds 5 and 6 and stops at the 404 for 7. Because the live
   range is dense, the probe can never stop early inside a hole.
4. Fold entries in ascending `seq` order:
   - `I` / `U` with `after` set `doc_id` to that full post-image.
   - `D` deletes `doc_id`.
5. Apply the predicate, order, and limit in memory.

The returned tail and rows come from this same complete fold. Predicates,
including filtered-index predicates, cannot restrict which committed
entries are loaded. Selection for update, delete, and replace uses the
same authoritative row set. Reads issue no index LISTs and do not depend
on index completeness. Declaring or rebuilding an index does not change
query results or accelerate reads.

An empty result still requires loading the snapshot and log to prove
absence. Order and limit apply after materialization, so they do not
bound fold I/O or memory. Existing snapshot ceilings and host request
budgets remain the workload constraints; no read-side maintenance runs.

## Snapshots and compaction

The log is append-only, so reads would grow with every write unless
maintenance periodically turns an old log prefix into a snapshot.
Write-triggered maintenance folds a prefix of the live log into a
snapshot:

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
   folds are the primary durable advancer of the hint. Explicitly bounded
   scheduled compaction can instead durably checkpoint an incomplete probe's
   certified lower bound in `tail_hint` without publishing a snapshot; a
   later pass resumes from that checkpoint. Write-tick maintenance
   rate-limit-refreshes the hint when fold work defers or fold/GC work is
   disabled, and after a GC slice that did not follow a landed fold in
   the same tick — a landed fold has already published a hint at or
   past the observed tail, so refreshing again would rewrite identical
   bytes. Ordinary writer commits never touch
   `current.json` on the commit path. The fold CAS is therefore the
   only steady-state writer of the snapshot pointer, `log_seq_start`,
   and snapshot counters, which strengthens compaction-state atomicity.

The snapshot file is content-hashed. If a compactor crashes mid-PUT,
the body will not match its own filename hash and readers reject it.
If a compactor loses the `current.json` CAS, the snapshot becomes an
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
  the maintenance profile's `maxFoldEntriesPerPass` entries per pass.
  The Cloudflare/free-safe default is
  `WRITE_TICK_FOLD_ENTRIES_PER_PASS`; the Node adapter threads the
  larger `NODE_MAINTENANCE_FOLD_ENTRIES_PER_PASS`.
- The fold starts only while the snapshot is under both ceilings:
  bytes `C` (`snapshot_bytes <= C`) and rows `E` (`snapshot_rows <= E`).
  The fold applies the longest prefix of the slice whose rebuilt row
  count stays within `E`, stopping before the first entry that would add
  a row past it.
  Only the byte ceiling is operator-overridable:
  `C` defaults to `MAINTENANCE_MAX_FOLD_BYTES_DEFAULT` and can be
  raised via `BAERLY_MAINTENANCE_MAX_FOLD_BYTES`, whereas `E`
  (`MAINTENANCE_MAX_FOLD_ROWS`) is a hardcoded constant with no env
  override.
- GC marks and sweeps bounded batches from `gc/pending.json`, over the
  `log/` and `snapshot/` prefixes only — never `content/`
  ([Legacy content side objects](#legacy-content-side-objects)).
- Before any due snapshot candidate can be swept, GC re-reads `current.json`
  and resolves every candidate named by the fresh `current.snapshot` pointer.
  Stale-log classification continues to use the initial monotone
  `log_seq_start`; a stale read can delay collection but cannot make a live log
  stale.
- A Cloudflare scheduled invocation processes one collection. With the R2
  binding, Free or Paid, one combined `runScheduledMaintenance()` call with the
  host's profile fits the request ledger; on Free with storage over `fetch` it
  does not, so that host alternates direct bounded `compact()` and `runGc()`
  calls, one phase per invocation. Fan-out must be sharded or driven by a
  persisted collection cursor.
- Cloudflare can defer the tick past the response with
  `ctx.waitUntil`; Node runs inline unless the host wraps it
  differently.

There is no daemon, lease service, scheduler, or background thread.
`runScheduledMaintenance` is an exported convenience for Cloudflare Paid or
Node teams that want an explicit maintenance window; it is not required for
correctness.

### Scheduled vs in-band fold floors

The two maintenance triggers carry different `minEntriesToCompact`
defaults, deliberately:

| Trigger | Floor | Why |
| --- | --- | --- |
| In-band write tick (`runBoundedMaintenance`) | 50 (`WRITE_TICK_MIN_ENTRIES_TO_COMPACT`) | A write is not a scheduling decision — folding on every write would thrash snapshot rewrites. |
| Scheduled (`runScheduledMaintenance`, no `options.compact`) | 1 (`SCHEDULED_MIN_ENTRIES_TO_COMPACT`) | The scheduler firing **is** the decision that it is time to work; the only live tail worth leaving unfolded is none. |
| Cloudflare Paid scheduled (`runScheduledMaintenance(args, CLOUDFLARE_PAID_TIER)`) | 1 (`SCHEDULED_MIN_ENTRIES_TO_COMPACT`) | The library-provided scheduled profile exists for per-pass caps (`maxEntriesPerRun: 200`, GC bounds), not an in-band count floor. |
| Cloudflare Free compact options (`CLOUDFLARE_FREE_TIER.compact`) | 20 (`maxFoldEntriesPerPass`) | Explicit so `minEntriesToCompact <= P` (25) and each pass stays bounded. Pass it to `runScheduledMaintenance` only with the R2 binding; with storage over `fetch`, alternate its `.compact` / `.gc` halves. |
| Direct `compact()` call | 100 (`DEFAULT_MIN_TO_COMPACT`) | The in-band shape; direct callers should pass a threshold sized to their trigger. |

The scheduled floor drains the tail to zero so reads stay O(snapshot),
not O(history). Every fold rewrites the entire snapshot, so at a
5-minute cadence a threshold of 1 bounds snapshot rewrites to one per
tick that actually received writes (an idle tick costs only the
`current.json` GET + tail probe, no PUT). `CLOUDFLARE_PAID_TIER` uses
that same floor of 1 with a 1,000-GET tail probe
(`CF_PAID_COMPACT_TAIL_PROBE_GETS`); Free carries an explicit 20. A
write-amplification-sensitive caller whose fold cost outweighs its
per-entry read cost raises the floor explicitly via
`options.compact.minEntriesToCompact`; the trade is a tail of up to
`floor − 1` unfolded entries that every read replays at one GET apiece.
The floor is a count, not a timestamp — the cron cadence already carries
the timing signal, and behaviour stays identical on every backend.

A below-floor skip on a non-empty tail (`available > 0`) is observable
as the `db.compaction.below_min_total` counter (with the `collection`
label), in addition to `compact()`'s `{written: false, skippedReason:
"below-min-threshold"}` return value — a maintenance loop that discards
results must still be able to distinguish "nothing was foldable" from
"a live tail sat under the floor." An idle skip (`available === 0`)
does not increment the counter.

The doctrine and trade-offs live in
[ADR-002](../adr/002-ephemeral-coordination.md). Capacity thresholds
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
   `[0, log_seq_start)` (carve-out: `baerly admin restore --force`
   leaves `snapshot: null` with a possibly-positive floor, because a
   truncate drops those entries rather than folding them).
   **No reader depends on a log object below the floor.** Entries in
   `[0, log_seq_start)` are already represented in the snapshot and may
   be reclaimed at any time, so a sub-floor read is a protocol
   violation, not a miss to tolerate. The two `Db` log-read seams —
   `getLogEntry` and `probeLogTail` — take the `current.json` they are
   floored against and throw `Internal` below it, so the floor is a
   property of the seam rather than a discipline each caller has to
   repeat. The one deliberate sub-floor read is a windowed commit's
   point GETs of the entries a fold absorbed after its caller's read
   (an insert guard or admission re-check); a missing entry refuses the
   commit with `WriteConflict`, never a wrong read.

   A **second, stricter floor** sits beneath it. `log_seq_start` marks
   what a reader may *need*; the optional `log_delete_floor` is the
   exclusive upper bound of the contiguous log prefix certified deleted.
   Every lower log object is gone; absent or `0` means no deleted prefix
   is certified. The gap between the floors is the deliberately-retained
   safety window. Both seams check it, and the two throws carry different
   messages on purpose: below `log_seq_start` an object is folded and
   *may* already be reclaimed, while below `log_delete_floor` it is
   **gone**. An operator reading the throw has to be able to tell those
   apart. The seams clamp the effective delete floor to
   `min(log_delete_floor, log_seq_start)` rather than trusting the stored
   value — see invariant 12 for why an out-of-bound value is readable at
   all. The commit path checks the same clamped floor. After the
   committing `log/<seq>` create resolves — on both the fresh-win and the
   own-session-adoption paths — the writer re-reads `current.json`, and a
   `seq` below `min(log_delete_floor, log_seq_start)` fails the commit with
   `BaerlyError{code:"AmbiguousCommit"}`. A winning create means the slot
   was empty immediately before the PUT, so a sub-floor `seq` proves the
   object it wrote is beneath every reader's floor. It does **not** prove
   the logical mutation is invisible: a create that landed live and was
   then folded *and* retired reads identically here, and is rejected too.
   That over-rejection is the accepted safe direction. The band
   `log_delete_floor <= seq < log_seq_start` is **not** a failure — not
   because it is provably safe, but because it is undecidable the same
   way (a fold absorbs our own earlier attempt and a foreign entry
   identically, keeping no writer identity) and rejecting it would fail
   every ordinary post-fold commit. The invisible half of that band is a
   residual this check does not reach, by construction.

    Stale log objects are reclaimed by a sequence window rather than a
    timed mark-and-sweep. The retention pass deletes every
    `log/<seq>.json` with `seq < log_delete_floor` in a bounded slice
    on each write tick and on scheduled maintenance. No LIST is required:
    log keys are computable from `seq` alone. The gap between the two
    floors (`LOG_RETENTION_SEQ_WINDOW`) is sized from intentional
    point-in-time readers below the floor, not from the writer-retry
    window that `GC_GRACE_PERIOD_MILLIS` covers. The window is **not** a
    paused-writer fence — it bounds no wall-clock and no commit count.
    The commit-path check in this invariant closes that schedule instead.

    **Retirement certifies before it deletes, and that is what makes the
    check total.** `retireLogRange`
    ([`packages/server/src/log-retention.ts`](../../packages/server/src/log-retention.ts))
    CASes `log_delete_floor` to the end of its authorized range *before*
    issuing a single DELETE. So every physically-deleted slot is already
    below a certified floor by the time it is gone, and a later create
    that re-fills a retired hole necessarily lands sub-floor — exactly the
    condition this invariant's commit-path check rejects with
    `AmbiguousCommit`. Nothing reclaims a log object outside that path:
    GC does not LIST or delete under `log/`. The one exception is a
    legacy `gc/pending.json` written before retirement existed, which can
    still carry `stale-log` candidates that `runGc` DELETEs without
    advancing the floor; that residual is one-shot and self-extinguishing,
    because no current build marks the category. See
    [`packages/server/src/gc.ts`](../../packages/server/src/gc.ts)'s Arm 1
    comment.
6. **`current.json` is compaction state; the commit path does not write
   it.** The compactor's fold CAS is the only steady-state writer of
   the snapshot pointer, `log_seq_start`, and snapshot counters.
   `tail_hint` is a non-authoritative monotone lower bound, durably advanced
   by compaction folds, explicitly bounded scheduled-compaction probe
   checkpoints, and by the write-tick runner's
   rate-limited tail refresh — which fires when fold work defers or
   fold/GC work is disabled, and after a GC slice whose tick did not already
   land a fold that published the hint. Those durable
   writers use monotone CAS updates and never move `tail_hint`
   past the true first missing log slot. Ordinary writer commits never refresh
   it inline. Other non-commit-path writers are explicit: the one-time
   `createCurrentJson` bootstrap, operator/import paths such as `admin
   restore`, and the best-effort `last_warned_seq` graduation stamp.
7. **Retired in 0.7.** The writer maintains no index markers, so the
   marker-ordering invariant this number held has nothing left to order;
   the number stays so later citations keep theirs.
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
    not stamp log entries with fence epochs, and no production
    commit/read path uses the field for authority. Readers decide
    visibility from `seq`, the snapshot, the trusted log range, and the
    forward-probe.
12. **The fold floor is monotone.** `current.json`'s `log_seq_start`
    never decreases in steady state. `assertCurrentJsonTransition`
    (`packages/protocol/src/coordination/current-json.ts`) is the single
    enforcement point: it rejects a transition that lowers the floor
    with `BaerlyError{code:"Internal"}`. Equality is permitted, so a
    `tail_hint` refresh, a bounded probe checkpoint, or a
    `last_warned_seq` stamp holds the floor fixed.
    `casUpdateCurrentJson` routes its mutator through the validator, and
    every writer that bypasses that helper calls the validator directly
    before publishing: the compactor's fold CAS and probe checkpoint
    (`packages/server/src/compactor.ts`), the `claimWriter` fence bump,
    and the `admin restore` tail stamp (invariant 6 names the
    `current.json` writers). The compactor still issues its own
    `If-Match` PUT because its CAS must be tied to the etag of the read
    it folded from — centralizing transition admission does not
    centralize publication. `baerly admin restore --force` is the
    deliberate operator exemption: it reseeds a truncated collection to
    one past the highest _surviving_ log object, which can sit below the
    old fold floor when a bounded GC sweep has left folded log objects in
    place. Any such survivor must be at or above the certified delete
    floor. The reseed is sound because it remains strictly greater than
    every log object still present, so the committing `log/<seq>` create
    cannot collide with the old generation.

    The optional `log_delete_floor` (invariant 5) obeys two rules in the
    same validator: it never decreases, and it never exceeds
    `log_seq_start`. Both are **transition-scoped**. The single-state
    read guard `assertCurrentJson` checks shape only — optional
    non-negative integer — and deliberately does not carry the
    `<= log_seq_start` bound, unlike the `log_seq_start <= tail_hint`
    bound it does carry. That asymmetry is intentional: an inverted live
    *read* range must stop a reader, whereas an out-of-bound delete
    floor affects only *deletion*, and `readCurrentJson` sits on `admin
    restore`'s own path, so rejecting the state there would leave the
    bucket with no in-product repair path. Fail-safe direction is stall,
    not lockout. The consequence is that an out-of-bound floor **can**
    be read back off disk, so every consumer of the field — the read
    seams and any retirement pass that deletes against it — must clamp
    to `min(log_delete_floor, log_seq_start)` rather than trust the
    stored value. `baerly admin restore --force` **drops** the field
    entirely because the truncate starts a new generation. A reseed can
    land below the old delete floor when the certified old prefix — and
    potentially the entire old log — is gone: LIST then finds no surviving
    log object and returns `truncatedNext = 0`. Restored rows reuse slots
    below the old floor, so carrying the old-generation certificate through
    that unchecked raw PUT could persist
    `log_delete_floor > log_seq_start`. Dropping it resets the new
    generation to no deleted prefix certified.

    The retention window between the two floors
    (`LOG_RETENTION_SEQ_WINDOW`) is a rate limit on how fast retirement
    approaches the live floor, which also keeps folded entries readable for
    a windowed commit. It is **not** a
    paused-writer fence and no safety property may be derived from it: it
    bounds no wall-clock and no commit count, so a delayed create PUT, an
    isolate suspension, or the adapter's retry of a create can each
    straddle an unbounded number of peer commits and folds. What closes that
    schedule is the commit-path check in invariant 5, which fails rather than
    acknowledging an invisible mutation.

    The consequence for the write contract is stated rather than hidden: under
    this fault a commit is **at-least-once**, not exactly-once. The writer
    cannot determine whether an earlier attempt of its own landed and was
    folded before retirement removed the slot — the fold keeps no writer
    identity, so the two histories leave identical durable state (invariant
    11). Retrying is the intended recovery and may apply the mutation twice.

    Every `log/<seq>.json` with `seq < log_delete_floor` is certified
    deleted and must never be read. A crash after the floor CAS may
    leave physical objects in that prefix; they are a deliberate leak,
    not live data. The gap between `log_delete_floor` and
    `log_seq_start` is the retention window (`LOG_RETENTION_SEQ_WINDOW`).
    Retention is a logical bound on the same axis as the floor, so it
    depends on no clock and no per-adapter object metadata — which is why
    retiring a log object needs neither a LIST nor a `gc/pending.json`
    entry.

    Both maintenance triggers route floor movement through the same
    checked retirement path. `admin restore --force` remains the
    deliberate truncate exemption and resets this floor.

13. **A `/v1/since` cursor is valid only within the generation that
    minted it.** `current.json` carries an opaque `generation` nonce,
    and the cursor the server hands a long-poll client is
    `<generation>.<lsn>` whenever that nonce is present. On resume, a
    generation that does not match the manifest's is rejected with
    `BaerlyError{code:"CursorExpired"}` (HTTP 410) and the client must
    re-bootstrap. A cursor below `log_seq_start` is rejected the same
    way; a malformed cursor is `SchemaError` (HTTP 400).

    A manifest with no `generation` keeps handing out a **bare** LSN
    rather than `-.<lsn>`. Both decode to the same sentinel, so the
    comparison below is unaffected; emitting the bare form confines the
    wire-shape change to collections that actually carry a nonce,
    instead of changing every cursor in the bucket on upgrade.

    This exists because invariant 12's `--force` exemption makes a seq
    comparison alone unsound. A seq identifies a `log/<seq>` slot, and
    slots are reused: after a truncating reseed that lands below the old
    floor, a pre-restore cursor clears the `cursorSeq < log_seq_start`
    check and resumes into the new generation, silently skipping every
    restored row beneath it — gapped, not broken, which a sync client
    cannot detect for itself.

    The nonce is re-minted by the writers that *replace* a collection
    (both `baerly admin restore` seeds, writer auto-provision,
    `ensureTable`) and carried through untouched by the writers that
    *advance* one (the compactor's fold CAS, `claimWriter`, every
    `casUpdateCurrentJson` mutator). It is deliberately not
    `writer_fence.epoch`: the fresh-target restore branch seeds
    `epoch: 0`, so a truncate-to-empty would be indistinguishable from a
    genuine epoch-0 collection. A counter that resets cannot
    discriminate generations.

    Absent is a defined state, not a degraded one. A `current.json`
    predating the field and a bare-LSN cursor predating the composite
    shape both decode to the sentinel `-`, so one string comparison
    covers every case with no fail-open branch:

    | Manifest      | Cursor (decoded) | Result | Why                                            |
    | ------------- | ------- | ------ | --------------------------------------------------------- |
    | no generation | `-`     | pass   | Nothing was truncated.                                      |
    | no generation | nonce   | reject | Manifest replaced by an older build; treat as unknown.      |
    | nonce `A`     | `-`     | reject | Only a mint adds the field, and a mint means replacement.   |
    | nonce `A`     | `A`     | pass   | Same generation.                                            |
    | nonce `B`     | `A`     | reject | Truncated.                                                  |

14. **The compactor's publication window is assumed shorter than the
    GC grace.** The compactor owns the only publication window this
    invariant governs. It PUTs a snapshot (`packages/server/src/compactor.ts`,
    step 6) before it CASes `current.json` to point at it (step 7). In
    between, the snapshot key is not `current.snapshot`, so `runGc` can
    classify it `orphan-snapshot`. The content-before-log window a
    legacy v0.6.0 writer still opens is not governed here — GC never
    marks a `content/<sha>.json` object, so the grace has nothing to
    bound ([Legacy content side objects](#legacy-content-side-objects)).

    The protocol assumes this window does not stay open
    longer than `GC_GRACE_PERIOD_MILLIS`
    (`packages/protocol/src/constants.ts`, 7 days), which is the delay
    GC imposes between a mark and the DELETE it authorises.
    `packages/server/src/gc.ts`'s module JSDoc states the
    same bound from the GC side — "The grace bounds the worst plausible
    writer-retry window". Request-bounded runtimes (a Worker invocation,
    a Lambda, an HTTP handler) enforce the assumption in practice.
    Nothing in the kernel checks it, and no error is raised if it is
    violated.

    **The grace alone does not cover the compactor window.** A snapshot
    PUT has already **succeeded**; what is outstanding is the pointer
    CAS, not a repeat of the PUT, so an argument about writer retry
    latency does not bound the compactor's publication window. What
    covers it is `runGc`'s sweep-time
    revalidation: the sweep gate
    re-derives liveness from the `current.json` and floor that same pass
    already read, and drops — never deletes — a candidate that now reads
    live or whose `generation` no longer matches the live manifest. An
    artifact that became reachable after it was marked is therefore
    dropped unswept — as far as the freshest manifest that pass holds
    can see, which is the freshness bound stated in the second
    limitation below.

    **Known limitation: the grace is wall-clock, with no cross-node
    backstop.** `computeDueAt` stamps `due_at` as the marking node's
    `Date.now()` plus the grace, and the sweep gate compares that
    against the sweeping node's `Date.now()`. There is no lease, no
    bucket-side clock, and no skew tolerance on this path
    (`LAG_WINDOW_MILLIS` covers log timestamps, not GC due dates). A
    node whose clock runs more than the grace ahead of the node that did
    the marking sees every candidate as already due on the first pass
    that observes it. The consequence is that the grace stops bounding
    anything, and the sweep-time revalidation above becomes the only
    check standing between a mark and its DELETE.

    **Known limitation: the revalidation is only as fresh as the
    freshest manifest the pass already holds.** `runGc` reads
    `current.json` at step 1
    ([`packages/server/src/gc.ts`](../../packages/server/src/gc.ts)) and
    re-reads it at step 4 only when a due `orphan-snapshot` candidate
    could actually be deleted. The fence and the floor re-check use
    whichever of the two is newer, so a pass that re-read for the
    snapshot arm gets the fresher answer for the legacy log arm for free
    — but a pass with no due snapshot never re-reads at all.
    That is deliberate: an unconditional second read would add a Class B
    op to every pass, and costing nothing extra is what lets GC ride the
    write tick. So on such a pass the fence detects "the collection was
    replaced since this candidate was MARKED", not "since this pass
    started reading", and the difference is a real window.

    The worked case below is exactly that shape, and it is reachable only
    through a legacy ledger: it needs due `stale-log` candidates and no
    due snapshot, and no current build marks `stale-log` at all. Pass `P`
    reads generation `G1` and floor 12 and loads the due candidates
    naming `log/10` and `log/11`. `P` then spends seconds on the snapshot
    LIST and its own manifest work. Meanwhile `baerly admin restore
    --force` reseeds the collection to generation `G2` at floor 10,
    clears `gc/pending.json`, and re-creates `log/10` and `log/11` as
    live entries of the new generation. `P` reaches step 4 still holding
    its stale `current`: the fence compares `G1` against `G1` and passes,
    `10 < 12` reads dead, and both live keys are deleted. The restore's
    ledger clear does not help — `P` loaded those candidates into memory
    before the clear landed. Read together with the wall-clock limitation
    above, this window is the entire safety margin: on a node clocked far
    enough ahead the grace collapses to nothing, and all that stands
    between a mark and its DELETE is one read of `current.json` taken an
    unbounded time earlier. The mitigation is operational and is the one
    [`packages/cli/src/admin/restore.ts`](../../packages/cli/src/admin/restore.ts)
    already states — do not run `admin restore` against a collection
    taking live traffic, where "traffic" includes GC passes, since
    `runScheduledMaintenance` fires them on a cron independent of writes.
    Re-reading or CASing the manifest immediately before the DELETEs
    would close the window, and is deliberately not done: it would trade
    a window that operational exclusivity already covers for a permanent
    key leak on any pass that dies between the check and the DELETE.

## LSNs, wall clocks, and downstream consumers

Each `LogEntry` carries a kernel sequence and an external cursor:

- `seq`: the integer sequence minted as the first empty log slot found
  by the forward-probe from `max(log_seq_start, tail_hint)`.
- `lsn`: an opaque cursor shaped
  `<base32-time>_<session>_<seq>`.

The timestamp-like prefix is for downstream LSN listing only: descending
base-32 makes recent LSN keys list efficiently, but the kernel orders by
integer `seq`. The kernel reconstructs `log/<seq>.json` directly from
integer `seq`. This ordering property is verified by
[`packages/protocol/src/lsn-reverse-list.test.ts`](../../packages/protocol/src/lsn-reverse-list.test.ts)
and quantified by [`bench/lsn-reverse-walk.ts`](../../bench/lsn-reverse-walk.ts)
against the pinned baseline at
[`docs/spec/attachments/lsn-reverse-walk-baseline.json`](attachments/lsn-reverse-walk-baseline.json)
(`pnpm bench:lsn-reverse-walk`).

`LAG_WINDOW_MILLIS = 5000` remains the named tolerance for wall-clock
skew in log timestamps consumed outside the kernel. A writer whose
clock regresses can mint an `lsn` whose time prefix sorts after a
causally earlier entry, or otherwise out of causal order; this cannot
reorder kernel reads, because kernel reads sort by `seq`. Downstream
CDC/export consumers must sort by `seq`, not by the timestamp prefix.

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
minute per collection; ~100 collections per tenant (a soft fan-out
guideline — cost grows linearly, not a protocol ceiling); and >10 GB per
tenant stored (the R2 free-tier storage line, a cost signal, not a
baerly-storage protocol constraint). Crossing those is a graduation
signal, not a protocol failure.

## Common misdescriptions

These statements read as plausible but describe a different system than
the one above. Each is a recurring way the protocol gets mis-summarized;
the right-hand column is the load-bearing correction.

| Don't say | Actually |
| --- | --- |
| "`current.json` is the latest-commit pointer." | It is a compaction bookmark: snapshot pointer, `log_seq_start`, counters, and a non-authoritative `tail_hint`. The commit is the log create. See [Storage layout](#storage-layout). |
| "A write commits by updating both a log entry and `current.json`." | The ordinary commit is the single `log/<seq>` create-if-absent. There is no `current.json` write on the commit path. See [Write algorithm](#write-algorithm). |
| "The `session` is an account, login, lease, or persistent writer identity." | It is a one-time in-memory value for recognizing one writer's own retry. See [Contention and retries](#contention-and-retries). |
| "`tail_hint` is the authoritative tail." | It is a lower-bound starting point that only moves forward. The true tail is the first missing `seq` found by the forward-probe. See [Read algorithm](#read-algorithm). |
| "Reads repair, compact, or garbage collect." | Reads are pure: they fetch and verify state. Maintenance is triggered by successful writes. See [Maintenance runtime model](#maintenance-runtime-model). |
| "The LSN text globally sorts all writes into causal order." | The kernel orders by integer `seq`. The LSN time prefix is a downstream listing hint only; cross-session same-millisecond order is arbitrary. See [LSNs, wall clocks, and downstream consumers](#lsns-wall-clocks-and-downstream-consumers). |
| "An external scheduler is required for correctness." | The in-band write-tick is the default and needs no scheduler. `runScheduledMaintenance` is an opt-in convenience for buckets that outgrow in-band draining. See [Maintenance runtime model](#maintenance-runtime-model). |
| "The server-timestamped `writer_fence` is the commit path." | `writer_fence` is dormant. No production commit path relies on it; the field persists only for schema compatibility. |

## Verification

The implementation is pinned by tests at three layers:

- `packages/protocol/src/storage/conformance.ts` requires CAS,
  same-key read-after-write, and the concurrent exactly-one-winner
  create-if-absent property for every adapter.
- `tests/fixtures/randomized-cascade.ts` drives the all-to-all
  causal-consistency cascade across memory, local-fs, Minio, and
  Cloudflare R2 variants.
- `tests/integration/maintenance-e2e.test.ts` and
  `maintenance-crash-fuzz.test.ts` exercise compaction, GC, crash
  injection, read parity, object-count drain, and the idle-reader
  cost bound.

Adding a storage adapter must add a conformance path and a randomized
cascade variant. Touching the write path, log walk, compactor, or GC
requires updating this spec and the relevant property tests.

## Prior art

Like Git, Iceberg, Delta Lake, Litestream, and SlateDB, the protocol
writes immutable artifacts and keeps mutable coordination small.
baerly-storage makes the high-frequency coordination point the numbered
log append; `current.json` is compaction state. The coordinator must fit
inside a portable `(Request) => Response` handler and a bucket. That
rules out a catalog service, lock table, always-on compactor, or
operator-installed scheduler.

See [prior-art.md](prior-art.md) for the detailed comparison.
