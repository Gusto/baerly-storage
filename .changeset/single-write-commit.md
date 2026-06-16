---
"@gusto/baerly-storage": minor
---

Single-write commit: appending the numbered log entry **is** the commit.

The commit path no longer CAS-advances `current.json`. A write now PUTs the
content object and then creates `log/<seq>` with `If-None-Match:"*"`; that
create-if-absent IS the linearization point. A `412` means a peer won that
sequence number — the writer re-reads the tail and retries at the next seq.
This drops the steady-state commit cost from **3 Class-A PUTs to 2** (content +
log create) — there is no `current.json` write and no post-commit fence verify
on the hot path.

**`current.json` is no longer the authoritative head.** It is now
compactor-owned compaction state: a durable _lower-bound hint_ for the live log
tail plus the snapshot pointer. Readers find the true tail by reading
`tail_hint` and forward-probing `log/<tail_hint>`, `log/<tail_hint+1>`, … until
the first `404`. The compactor is the sole writer that durably advances
`tail_hint` (monotone max), after folding a dense prefix.

**Schema v3 (`current.json`).** This is a breaking on-disk change:

- `next_seq` → `tail_hint` (renamed; now a compactor-owned lower bound, not the
  authoritative next sequence).
- added `mean_entry_bytes` — the compactor-stamped mean folded-entry size that
  drives the derived live-tail estimate the maintenance trigger reads.
- removed `tail_bytes` — the exact stored byte counter is gone; the trigger now
  reads a _derived_ estimate (`observedTail × mean_entry_bytes`).

**Buckets written under schema v2 are rejected and must be recreated.** There
is no migration path. Acceptable pre-launch (no production data exists); flagged
so it is not a surprise. Re-import via `baerly admin dump` (v2 build) →
`baerly admin restore` (v3 build) if you need to carry data across.

**Index emission is now hybrid around the commit.** New index keys are written
_before_ the log create (so a committed entry is never observed unindexed);
stale index keys are deleted _after_ (so a lost commit never strands a live
doc's index). Per-doc index correctness is eventually consistent and
`rebuildIndex` remains the backstop.

**S3 `409 ConditionalRequestConflict` now maps to a retryable `NetworkError`**
(previously surfaced raw) — the writer's retry loop handles it like any other
transient on the create-if-absent path.

`Db.probeLogTail` is `@internal` (tooling/recovery surface), not part of the
public API.
