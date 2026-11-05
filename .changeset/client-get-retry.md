---
"@gusto/baerly-storage": patch
---

The HTTP client now retries a `GET` up to twice more (3 attempts, jittered backoff, `Retry-After` honoured up to 10 s) after a thrown `fetch` or an envelope-less 5xx, 408 or 429 from a proxy or CDN in front of the server. An error the server itself returned is never retried, an abort stops at once, and the final failure is thrown unchanged. Writes (`POST`, `PATCH`, `PUT`, `DELETE`) are still sent once.
