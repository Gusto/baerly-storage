---
"@gusto/baerly-storage": patch
---

The HTTP client now resends an auto-ID `insert` (up to 3 attempts in total, same body, jittered backoff, `Retry-After` honoured up to 10 s) after a thrown `fetch` or an envelope-less 5xx, 408 or 429 from a proxy or CDN in front of the server. The resend carries the same minted `_id`, so an insert that had already committed replays as `201 { _id }` instead of adding a second row. An insert with a caller-chosen `_id`, `update`, `replace` and `delete` are still sent once for these failures. This shares one attempt budget with the existing `MaintenancePending` retry.
