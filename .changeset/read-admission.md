---
"@gusto/baerly-storage": minor
---

A read that cannot fit in one request is now refused whole with
`CapacityExceeded` (HTTP 409, not retriable unchanged) instead of failing
part-way or on the host's own limit. When `current.json` alone shows the
read needs more storage calls than the request has left, it is refused
before loading the snapshot; a forward probe past `tail_hint` that runs out
of request budget is refused the same way. A read never returns a
truncated row set and never triggers maintenance.

No app code changes. Reads that fit return exactly what they did before.
