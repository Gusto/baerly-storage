---
"@gusto/baerly-storage": minor
---

Stale log objects are now reclaimed by a sequence window rather than a
timed mark-and-sweep. Steady-state log object count is bounded by a
constant regardless of how long a collection runs.

This replaces GC's `stale-log` category: `RunGcResult.marked.stale_log`
is removed, and GC no longer lists the `log/` prefix. Log keys are
computable, so the retirement pass issues DELETEs directly and needs no
LIST. Reclamation no longer depends on object timestamps, so it behaves
identically on every backend.
