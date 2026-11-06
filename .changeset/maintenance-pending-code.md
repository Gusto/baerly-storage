---
"@gusto/baerly-storage": minor
---

Adds the `BaerlyError{code:"MaintenancePending"}` error code: HTTP 503 with a `Retry-After` header, retriable, carrying the suggested delay in seconds on `err.retryAfter` (and `error.retryAfter` in the HTTP envelope). It means a write was refused, nothing was committed, and maintenance is catching up; wait the indicated delay and repeat the call.

Near a collection's fold ceiling, writes now drive maintenance themselves instead of waiting for the usual fold trigger:

- While a growth write (an insert, or an update that makes a row larger) would be refused with `CapacityExceeded`, each accepted write folds the pending changes in its own write tick, within the usual per-pass budget.
- A growth write refused only because pending changes have not folded yet (they would make room once folded, for example deletes behind a burst of inserts) runs one bounded fold and fails with `MaintenancePending` (`retryAfter` 1 second) instead of `CapacityExceeded`. Retrying drains the backlog and the write then commits. With nothing pending that would make room, or when no fold can make progress on this host, the refusal stays `CapacityExceeded`.

On Cloudflare that fold runs in `ctx.waitUntil` after the response, like every write tick. Reads still never run maintenance, and nothing new is configured.
