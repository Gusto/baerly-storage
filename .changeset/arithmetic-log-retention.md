---
"@gusto/baerly-storage": minor
---

Stale log objects are now reclaimed by a sequence window rather than a
timed mark-and-sweep. `current.json` gains an optional
`log_delete_floor`; every `log/<seq>.json` below it has been deleted.
Steady-state log object count is now bounded by a constant regardless
of how long a collection runs.

This replaces GC's `stale-log` category, which listed the `log/` prefix
under a rotation cursor. Log keys are computable, so the new path issues
DELETEs directly and needs no LIST. Reclamation no longer depends on
object timestamps, so it behaves identically on every backend.

A commit that would create beneath the certified delete floor now fails
with a non-retriable `AmbiguousCommit` error instead of acknowledging a
mutation no reader can see. The write contract under this fault is
at-least-once.

Buckets written by earlier versions need no migration: an absent
`log_delete_floor` reads as 0 and the first retention pass starts from
the bottom of the keyspace.
