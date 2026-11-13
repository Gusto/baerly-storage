---
"@gusto/baerly-storage": minor
---

Every request now runs under a storage request budget, and a storage call
past it is refused before it is sent with `CapacityExceeded` (HTTP 409,
not retriable unchanged) instead of failing on the host's own limit. The
budget counts every attempt, retries and `list` pages included, plus the
Worker's Cache API calls, and covers the write-tick maintenance a request
dispatches through `ctx.waitUntil`.

On Cloudflare the budget follows `BAERLY_MAINTENANCE_PROFILE`: `cf-free`
(the default) allows 900 storage calls per invocation, of which at most 45
may leave through `fetch` (S3 over HTTP, GCS) or the Cache API; `cf-paid`
allows 9,000. R2 binding calls count toward the 900 only. A cron
invocation gets its own budget. The read cache skips a lookup or store it
has no room for and serves from storage; it never refuses a request. Node
counts calls and never refuses one.

No app code changes. A multi-row write refused part-way keeps the rows it
already committed; re-read before retrying it.
