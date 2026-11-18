---
"@gusto/baerly-storage": patch
---

Aborting an S3 or GCS storage call through its `AbortSignal` now cancels the request in flight and rejects with the `AbortError` after one attempt, as the memory, local-fs and R2 binding adapters already did. Before, an S3 request kept running after the abort, and a GCS abort was wrapped as a retriable `NetworkError` and resent until the retry limit ran out. Code that treated a cancelled call as a `NetworkError` should check `error.name === "AbortError"` instead.
