---
"@gusto/baerly-storage": minor
---

Adds the `BaerlyError{code:"MaintenancePending"}` error code: HTTP 503 with a `Retry-After` header, retriable, carrying the suggested delay in seconds on `err.retryAfter` (and `error.retryAfter` in the HTTP envelope). It means a write was refused, nothing was committed, and maintenance is catching up; wait the indicated delay and repeat the call. Nothing throws it yet.
