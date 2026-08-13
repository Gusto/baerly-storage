---
"@gusto/baerly-storage": minor
---

`current.json` gains an optional `log_delete_floor`: the exclusive upper
bound of the contiguous log prefix certified deleted. Every lower log
object is gone from the bucket. This is distinct from `log_seq_start`,
which is the lowest sequence a reader may still need; the gap between
them is the retained safety window. Absent or `0` means no deleted prefix
is certified, even if existing GC deleted sparse log objects, so
`schema_version` stays at `3` and existing buckets are unaffected.

No writer sets the field yet. What ships is the safety envelope around
it, so that the pass which does set it lands against invariants that
already exist and are already tested:

- `assertCurrentJsonTransition` rejects a transition that lowers the
  delete floor, or that raises it above `log_seq_start`, with
  `BaerlyError{code:"Internal"}`. Both rules are transition-scoped; the
  single-state guard `assertCurrentJson` checks shape only.
- The two `@internal` `Db` log-read seams now distinguish *folded and
  possibly reclaimed* from **gone**. Below `log_seq_start` they keep the
  existing message; below `log_delete_floor` they say the object has
  been reclaimed. Same `Internal` code, different wording — an operator
  reading the throw needs to know whether the bytes are recoverable.
  Both clamp to `min(log_delete_floor, log_seq_start)` rather than
  trusting a stored value that the single-state guard does not bound.
- `baerly admin restore --force` deliberately **drops** the field when it
  reseeds. If the certified old prefix includes the entire old log, LIST
  finds no surviving log object and the new generation reseeds at `0`,
  below the old delete floor. Carrying the old-generation certificate
  would then publish `log_delete_floor > log_seq_start` through the one
  `current.json` PUT exempt from transition validation. The test now
  constructs that valid empty-old-log state and pins the reset.

No behavior change for any shipping caller. See invariants 5 and 12 in
`docs/spec/sync-protocol.md`.
