---
"@gusto/baerly-storage": patch
---

`GET /v1/since` now stays inside the request's storage budget instead of
failing with `CapacityExceeded` (409, not retriable), which stopped a React
subscription for good. On Workers Free with storage over `fetch` (S3 over
HTTP) an idle long-poll used to run out of its 45 calls about 22 s into the
25 s default and return 409.

A long-poll now ends when its budget runs out: with the events it read so
far, whose `next_cursor` resumes exactly after the last one, or, after at
least one poll interval, with an empty batch at the same cursor. On Free
over `fetch` an idle long-poll holds for about 22 s; with the R2 binding,
on Paid and on Node it holds for the full timeout as before. A request
that cannot afford even one poll returns `MaintenancePending` (503,
retriable, `Retry-After: 1`), never an empty batch at once. An idle poll
also costs two storage reads however far `tail_hint` lags the tail, and a
busy poll reads each entry once instead of twice.

No app code changes; the response shape and cursor contract are
unchanged. The bundled client already retries `MaintenancePending`.
