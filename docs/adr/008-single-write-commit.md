---
title: Single-write commit — the numbered log append is the commit
audience: adr
summary: ADR 008 — a commit is one linearizable `If-None-Match:"*"` create on `log/<seq>`; `current.json` leaves the commit path and becomes compactor-owned compaction state with a non-authoritative `tail_hint`; readers discover the tail by forward-probe; index emission is hybrid (new keys before the commit, stale keys after); schema bumps v2→v3 (breaking).
last-reviewed: 2026-06-15
tags: [decision, adr, sync-protocol, runtime-model]
related:
  [
    README.md,
    "../spec/sync-protocol.md",
    001-tenant-cas-isolation.md,
    004-ephemeral-coordination.md,
    007-layout-versioning-cordon.md,
  ]
---

# 008 — Single-write commit: the numbered log append is the commit

## Status

Accepted (2026-06-15). Implemented. Supersedes the two-write commit
described by earlier revisions of
[sync-protocol.md](../spec/sync-protocol.md). Pre-launch, so the v2→v3
schema break ships with no migration path.

## Context

A commit used to be **two writes**: `PUT log/<seq>.json`
(`If-None-Match:"*"`) followed by a CAS-advance of `current.json` (which
carried the authoritative `next_seq`, the snapshot pointer, `log_seq_start`,
the live-tail byte counter, and the snapshot counters). A crash between the
two writes left an **orphan at `next_seq`** — a committed log entry that
`current.json` never acknowledged. Because every future writer started from
`current.json.next_seq`, that orphan **wedged the collection**: the next
writer's create-if-absent at `next_seq` collided with the orphan forever.
Read-clean and no data loss, but a permanent liveness hole (the old
`phase5-crash-fuzz.test.ts` BUG 1).

The settled fix removes the second write entirely. There is no longer a
pointer to crash between, so the whole orphan-at-`next_seq` class — and the
recovery tooling that would have policed it (`dead_seqs`, a K-detector, a
recovery CAS) — ceases to exist. The threat model is fail-stop; recovery
tooling is dropped as YAGNI pre-launch.

This ADR resolves: tail discovery, compaction-state ownership, maintenance
counters off the commit path, index consistency, the one load-bearing
backend prerequisite and its deploy gate. The patent narrative is tracked
separately and is owner-gated; it is deliberately out of scope here.

## Decision

### 1. The numbered log append is the commit

A commit is **one** linearizable `If-None-Match:"*"` create on
`log/<seq>.json`. Winning (`200`) means committed; `412` means a peer
committed that sequence number. The content body is written first
(content-addressed, `If-None-Match:"*"`, so a retry is a no-op), then the
committing `log/<seq>` create. Steady-state cost is **2 Class-A PUTs**
(content + log create) down from 3 — there is no `current.json` write on the
commit path.

A bare `412` is **not** proof a peer won. The writer GETs the occupant and
runs the existing same-session adoption check
([`log-conflict-adoption.ts`](../../packages/server/src/log-conflict-adoption.ts)):
if the occupant is this writer's own session/seq, it is a lost-ack
self-retry and the writer adopts it as already-committed; only a _foreign_
occupant means a peer won, in which case the writer re-probes the next seq
and retries. (The per-commit `session` is minted outside the retry loop and
the LSN encodes the seq, so a dropped ack is unambiguously distinguishable
from a genuine peer.)

There was, briefly, a post-commit fence verify (a re-read of
`writer_fence` after the create). It is **removed** as incoherent under
single-write commit: the create-if-absent _is_ the proof of commit, and a
separate fence read adds nothing while reintroducing a second round-trip.
The `writer_fence` field is left **dormant** (its drop is deferred — it is
entangled with an owner-gated mechanism; see ADR-007's reserved-field
discipline). No prod path reads or writes it.

### 2. `current.json` leaves the commit path → compactor-owned compaction state

With the commit-path CAS gone, the compactor's fold CAS is the **sole
steady-state writer** of `current.json`. The object is no longer the
authoritative head; it is **compaction state** plus a _non-authoritative
lower-bound hint_ for the live tail. Ordinary writer commits never refresh
the hint. Other non-commit-path writers are explicit and fine: the one-time
`createCurrentJson` bootstrap, write-tick tail refreshes when maintenance
defers or fold/GC phases are disabled, operator/import paths such as
`admin restore`, and the best-effort `last_warned_seq` graduation-warn stamp.

Compaction-state atomicity is _strengthened_ by the change: the snapshot
pointer + `log_seq_start` + snapshot counters all move together under the
single fold CAS, and only concurrent compactor runs (rare, already handled
by the cas-lost retry) contend for the object — commits no longer do.
`tail_hint` does **not** need to be atomic with the snapshot pointer, and
that decoupling is exactly what lets `current.json` leave the commit path.

### 3. Schema v2 → v3 (breaking)

| Field                              | v3 disposition                                                                                                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot` (pointer)               | stays — compaction output                                                                                                                                                  |
| `log_seq_start`                    | stays — log floor, atomic with `snapshot`                                                                                                                                  |
| `next_seq` → **`tail_hint`**       | renamed; now a compactor-owned, non-authoritative monotone **lower bound** for the tail. The rename is compiler-enforced so every read site is forced off "this is truth." |
| `snapshot_bytes` / `snapshot_rows` | stay — compactor-stamped, **exact** between folds; the `foldViable` CPU-kill ceiling reads them, so they must stay ground truth                                            |
| **`mean_entry_bytes`**             | **added** — compactor-stamped mean folded-entry size; drives the derived live-tail estimate (§4)                                                                           |
| **`tail_bytes`**                   | **removed** — the exact stored byte counter cannot be writer-incremented once commits skip `current.json`; replaced by a derived estimate (§4)                             |
| `writer_fence`                     | stays **dormant** (drop deferred)                                                                                                                                          |
| `schema_version`                   | **3** — any field rename/removal is a breaking schema change per the module's own contract                                                                                 |

A reader that meets a v2 record rejects it (`assertCurrentJson` throws
`InvalidResponse`). **There is no migration path**; pre-launch, a v2 bucket
must be recreated (dump under the v2 build, restore under the v3 build).

### 4. Maintenance counters off the commit path

The fold-ceiling safety inputs (`snapshot_bytes`, `snapshot_rows`) are
already compactor-time writes and are unaffected — they remain exact. Only
the _fold-trigger_ input changes: the live-tail byte size is now a **derived
estimate**, `estimateTailBytes = (observedTail − log_seq_start) ×
mean_entry_bytes`. The entry-count term is free (both fields are on the
`current.json` the maintenance tick already reads); `mean_entry_bytes` is
stamped by the compactor at fold time (it already has the folded slice's
byte sum and entry count in scope). Zero extra storage ops, and no `LIST`
of `log/` (a LIST yields key _names_, not bytes; the count is already free
by subtraction).

This degrades **safely**: the estimate feeds only the ratio trigger, which
**fails closed** — a low estimate folds _later_ (the tail grows toward the
read-amplification target — latency, never a budget or CPU-kill breach). It
is structurally barred from the `foldViable` ceiling, so an estimate error
can never drive an over-ceiling fold. Cold-start (before the first fold
stamps a mean) falls back to a non-zero per-entry constant.

### 5. Index emission is hybrid around the commit

Index markers are pre-materialized keys, so a write must keep them coherent
with the committed value. The emission is split around the committing log
create:

- **New (additive) index keys are PUT _before_ the commit** (`If-None-Match:"*"`).
  A committed row is therefore _always_ index-findable — there is no window
  in which a committed doc is observed unindexed. An additive key for a
  write that then _loses_ the commit is a benign false-positive: the read
  path's `matchesWire` filter drops it.
- **Stale index keys are DELETE'd _after_ the commit.** A DELETE mutates
  committed-doc-visible state, so it must never land for a write that does
  not commit. Deleting after the winning `log/<seq>` guarantees a crash can
  **never de-index a committed doc**.

This flips the only residual to a benign polarity. The dangerous failure —
a _committed-old-value_ doc silently de-indexed by a crash, which the read
path can never repair (it filters false-positives but never conjures a
missing candidate) — is eliminated. The remaining residual is a
false-positive (extra key) that `matchesWire` drops. Per-commit cost is
unchanged (same PUTs + DELETEs, just sequenced around the commit).

Per-doc index correctness is **eventually consistent**: a doc converges on
its next write (which re-emits its keys), and `rebuildIndex` is the
whole-collection operator backstop. A bounded in-tick reconcile slice was
considered and **deferred** (it is the one genuinely new design knob; YAGNI
pre-launch).

### 6. Tail discovery: `tail_hint` + bounded forward-probe

The log is **not** LIST-discoverable: log objects are keyed raw-decimal
(`log/<seq>.json`), which does not sort numerically under a lexicographic
LIST, and nothing in the kernel ever LISTs `log/` — every access is a
deterministic GET by computed seq. So tail discovery is a **bounded forward
probe**, not a reverse-LIST:

- **Writer.** Read `current.json` fresh, attempt `PUT log/<tail_hint>`
  with `If-None-Match:"*"`; on `412` (foreign occupant) probe `tail_hint+1`
  and retry, walking forward until a create wins.
- **Reader.** Fold the trusted range `[log_seq_start, tail_hint)`, then
  forward-probe `GET log/<tail_hint>, log/<tail_hint+1>, …` (Class B GETs),
  folding each found entry and **stopping at the first 404** — that 404 is
  the true tail.

This keeps reads **pure of Class A** (the idle-reader cost bound is
untouched) and is immune to LIST-after-write visibility lag: the only
operation that must be strongly consistent is the `If-None-Match:"*"`
create itself, the property the kernel already depends on.

#### Why a galloping writer and a linear reader are both safe

The two ends discover the tail by different mechanisms, and they are
reconciled by a single invariant: **the live log range is dense.** A writer
always targets the _first_ empty slot and never skips — `log/N` exists
before `log/N+1` is ever attempted (an interior hole is unhealable; baerly
has no fill primitive). So:

- A **writer** racing peers may "gallop" forward through several `412`s, but
  every seq it skips past is occupied by a _committed_ entry — it never
  leaves a hole behind it.
- A **reader** walks forward linearly from `tail_hint` and stops at the
  first 404. Because the range is dense, that 404 is the true tail; the
  reader can never stop early inside a hole, and a just-committed entry
  above a stale hint simply becomes visible when the probe reaches it (the
  reader sees a valid committed _prefix_ either way).
- `tail_hint` is a **proven lower bound**: the compactor stamps it
  (monotone max) only after probing a _dense prefix_. The write-tick runner
  may also stamp a writer-observed tail when fold/GC work defers or is
  disabled, and explicit operator/import paths may stamp a known tail. The
  ordinary writer never refreshes the hint inline — a per-commit refresh was
  considered and dropped because making it mandatory would collapse the
  design back into a two-write commit.

So the strict `[log_seq_start, tail_hint)` fold keeps `walkLogRange`'s
existing hole-is-corruption invariant (the trusted range never contains a
hole), and only the tolerant `[tail_hint, tail)` probe rides the dense
forward walk. The `log/N+1 ⟹ log/N` density obligation is a protocol
obligation the storage layer does not enforce; it is fuzz-asserted.

### 7. The load-bearing prerequisite + deploy-time probing

Single-write commit correctness rests entirely on the backend's
`If-None-Match:"*"` create-if-absent being **truly linearizable under
concurrency**: under N concurrent creates of a fresh `log/<seq>`, **exactly
one** wins and the rest get `412`. A backend that admits two winners
produces **split-brain commit** (two distinct committed entries at one seq).

This is gated, not assumed:

1. **Spec.** [sync-protocol.md](../spec/sync-protocol.md) and
   [storage-compatibility.md](../spec/storage-compatibility.md) state the
   concurrent-exactly-one-winner prerequisite explicitly (promoted from the
   old _sequential_ "rejects when the key exists" property).
2. **Probe + conformance.** `probeCas` carries an `ifNoneMatch-concurrent`
   sub-check (fire K concurrent create-if-absent of a fresh key; assert
   exactly one wins), and the conformance paths assert the same property
   where they run: native R2 in PR CI, MinIO in the local dev stack, and
   cloud S3-compatible endpoints in credential-gated runs. (Landed as the
   Plan A safety gate.)
3. **Deploy preflight.** Today the live probe is explicit:
   `baerly doctor --bucket` is the manual gate for any backend, and
   Cloudflare `baerly deploy` runs the same probe only when passed
   `--probe-bucket=<uri>`, aborting before deploy if it fails.
   `doctorCloudflare` stays config-only. A mandatory deploy hard gate is
   desired future posture, not current behavior.

There is also a deployment-topology rule the spec states: the log/CAS path
must hit the object-store API **directly**, never through a negative-caching
CDN/proxy — a cached `404` on a just-created `log/<seq>` would corrupt the
forward-probe's "first 404 = tail" signal. (Object-store APIs are themselves
strongly consistent post-2020; this is about what sits in front of them.)

## Invariants the spec states

1. The commit is **one** linearizable `If-None-Match:"*"` create on
   `log/<seq>`; winning = committed.
2. Concurrent create-if-absent is **exactly-one-winner** (the load-bearing
   prerequisite, §7).
3. The live log range is **dense**; the forward-probe stops at the first
   empty seq and never skips (§6).
4. `current.json` is **compaction state**, sole-written by the compactor in
   steady state; `tail_hint` is a non-authoritative monotone lower bound
   (§2).
5. A committed doc is eventually correctly indexed; the only residual is a
   benign false-positive dropped by `matchesWire`, never an abandoned-write
   de-index of a committed value (§5).

## Consequences

- The orphan-at-`next_seq` wedge — and any need for recovery tooling around
  it — is gone by construction.
- The writer hot path drops to 2 Class-A PUTs; reads stay pure of Class A
  (forward-probe is Class B). The writer worst case is a linear forward walk
  bounded by commits-since-last-hint-refresh — the same O(lag) shape the
  pre-image back-walk already tolerates.
- Correctness now depends on a backend property (concurrent
  exactly-one-winner) that the deploy gate and conformance suite must keep
  enforcing. A backend that fails the probe must not be deployed.
- The v2→v3 break means any existing bucket must be recreated. Pre-launch,
  this is acceptable and has no migration path.
- Every writer racing the same `log/<tail>` key concentrates PUTs on one S3
  prefix (~3,500 PUT/s/prefix ceiling). This is inherent to a linearized
  per-collection log — a graduation cliff at high write fan-in, not a
  regression (see [cost-model.md](../about/cost-model.md)).

## Rejected alternatives

- **Keep the two-write commit, add recovery tooling** (`dead_seqs`,
  K-detector, recovery CAS) to heal the orphan. Rejected: it polices a hole
  the single-write commit never opens. YAGNI pre-launch.
- **Reverse-LIST of `log/` for tail discovery.** Not implementable as the
  log is keyed today (raw-decimal keys do not sort numerically), would
  require re-keying the log (a wire break across read path / compactor / GC
  / `/v1/since`), would pay a Class-A LIST per commit on the hot path, and
  would expose tail discovery to LIST-after-write visibility lag. The
  forward-probe avoids all four.
- **Best-effort writer hint refresh** after winning the log create.
  Rejected: a stale hint only lengthens the next probe (never a correctness
  hazard), and any _mandatory_ refresh reintroduces the second
  `current.json` write — collapsing back into a two-write commit.
- **Emit _all_ index keys after the commit** (the simplest "post-commit"
  rule). Rejected in favor of the hybrid (§5): emitting new keys _after_ the
  commit would leave a committed doc transiently unindexed; the hybrid
  closes that window while keeping the DELETE safely post-commit.
- **Derive indexes from the log/snapshot at read time** (no pre-materialized
  markers). A different database — indexed reads would do work proportional
  to tail length. Out of scope; a separate ADR if ever pursued.
- **Add a `LIST log/` to count live entries** for the maintenance trigger.
  A LIST yields names, not bytes, and the count is already free by
  subtraction; the compactor-stamped mean is strictly better.

## Precedents

- The kernel's own per-tenant CAS isolation
  ([ADR-001](001-tenant-cas-isolation.md)) — single-writer linearization
  via a conditional write is the same primitive, now applied to the log
  object directly instead of to a head pointer.
- Schema-version discipline ([ADR-007](007-layout-versioning-cordon.md)) —
  the v2→v3 bump is move (b) (a required-field change → reject the old
  generation), and `writer_fence` staying dormant follows the same
  reserved-field discipline.
- Log-structured commit-by-append (Kafka, Bitcask, LSM WALs) — the append
  position _is_ the commit; baerly makes the conditional create the
  linearization point so a single object store with no coordinator suffices.
