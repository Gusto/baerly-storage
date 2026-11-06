---
"@gusto/baerly-storage": minor
---

The HTTP client now retries a request the server refused with `MaintenancePending` (HTTP 503), on every verb: it resends the identical request up to 3 attempts in total, waiting the server's `Retry-After` (or `retryAfter`, whichever is longer) each time, and surfaces the error unchanged once the attempts run out. A hint above 10 s is not waited on; the error surfaces at once. An auto-ID insert resends its minted `_id`, so the retry can never add a second row. Resending is safe because the server refuses with this code only before the write commits, and each client write is one row.

The React subscription poll now waits at least `retryAfter` (capped at 10 s) before re-polling after `MaintenancePending`, and a `CapacityExceeded` poll error parks the table like any other non-retriable error until `refetch`.

`BaerlyError.retryAfter` on a client-side `MaintenancePending` is now the longer of the envelope's `retryAfter` and the `Retry-After` header. Envelope-less failures on writes are still sent once; enveloped `NetworkError` is still never retried.
