---
"@gusto/baerly-storage": minor
---

A commit whose `log/<seq>` create wins at a sequence the collection has already
certified deleted now fails with `BaerlyError{code:"AmbiguousCommit"}` instead of
returning success. That state is reachable when a create request or a lost-ack
retry straddles a fold plus a log-retirement pass: the object lands beneath every
reader's floor, so no reader will ever consult it — and whether the mutation
itself is visible is undecidable from durable state. Either the create re-filled
a hole retirement had already certified deleted (invisible) or it landed in a
live empty slot that a fold absorbed before retirement swept it (visible through
the snapshot); both are reported as ambiguous.

Under this fault the write contract is at-least-once rather than exactly-once.
The writer cannot determine whether an earlier attempt of its own landed and was
folded before retirement removed the slot — no durable state distinguishes that
from a foreign writer's entry being folded instead — so retrying is the intended
recovery and may apply the mutation a second time. `err.retriable` is `false` so
a generic conflict-retry wrapper cannot absorb it silently; handle the code
explicitly. Every other commit path is unchanged and remains exactly-once.

The fault is reachable in this release: the log-retirement pass that writes
`log_delete_floor` is the last step of every maintenance pass that reaches it —
scheduled maintenance, and any write tick that did not spend its one phase on a
fold. A collection with enough history to fold and then retire can therefore
surface the code, so handle it from day one.

`AmbiguousCommit` is a new `BaerlyErrorCode`. It maps to HTTP 409 with a scrubbed
message and to CLI exit 3.

Cost is one additional GET per commit. A GET is a Class B request while billable
Class A ops are PUT/LIST (`DeleteObject` is $0 on both R2 and S3), so per-write
Class A billing is unchanged.

Buckets written by earlier versions need no migration. A bucket whose previous
GC already swept a long sub-floor log prefix carries `log_delete_floor = 0` for
those sequences until retirement certifies them, so the check does not cover
those legacy holes until the floor catches up.
