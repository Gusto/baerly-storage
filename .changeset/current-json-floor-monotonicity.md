---
"@gusto/baerly-storage": patch
---

Enforce `log_seq_start` monotonicity on the `current.json` coordination
object, and validate the compactor's seq-arithmetic options at the seam
they arrive on.

`casUpdateCurrentJson` now rejects a mutator that lowers the fold floor,
throwing `BaerlyError{code:"Internal"}`; equality is still permitted,
since a `tail_hint` refresh or `last_warned_seq` stamp holds the floor
fixed. No *production* mutator writes the floor, so no shipping caller
could regress it — this closes the gap for future ones, where a lowered
floor would let a stale long-poll cursor pass the
`cursorSeq < log_seq_start` re-bootstrap check and silently resume into
the wrong generation.

`compact()` cannot route through that helper, because it must CAS on the
etag of the read it folded from. It instead validates `maxEntriesPerRun`
and `knownTail` as non-negative integers before any I/O, throwing
`BaerlyError{code:"InvalidConfig"}`. That keeps its fold end monotone by
construction, and it closes a non-finite input path in the same stroke.
A `NaN` is false under every range comparison in the fold, so before
this change it reached the CAS and wrote `log_seq_start: null`
(`JSON.stringify` renders `NaN` as `null`), after which every read path
— `admin restore --force` included, since it reads `current.json` before
reaching its own floor exemption — fails with `InvalidResponse`.
`snapshotKey` gained the same `Number.isInteger` check, so a non-finite
seq can no longer be padded into a `…-00000000000NaN-…` filename. No
in-tree caller supplies a non-finite value, but the seam is reachable
from JS callers, from in-repo casts, and through the
`@baerly/server/_internal/testing` subpath.

`baerly admin restore --force` is unaffected and remains the one path
that lowers the floor deliberately — a truncate reseeds to one past the
highest surviving log object, which may be below the old floor when a
budget-bounded GC sweep has left sub-floor objects behind.

Out of scope, tracked as #73: `/v1/since` gates re-bootstrap on a
bare `cursorSeq < log_seq_start` with no generation discriminator, so a
`--force` reseed that lowers the floor lets a stale pre-restore cursor
resume into the new generation and silently gap its stream. Until that
is closed in code, `docs/guide/backups.md` documents draining long-poll
readers as part of the cutover.
