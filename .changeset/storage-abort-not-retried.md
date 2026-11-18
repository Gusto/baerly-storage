---
"@gusto/baerly-storage": patch
---

Aborting an S3, GCS or R2 binding storage call through its `AbortSignal` now stops it after the attempt in flight, whatever the abort reason: a plain `abort()`, a custom reason, or a deadline's `TimeoutError` (as from `AbortSignal.timeout()`). No further attempt is signed, backed off or sent. An S3 or GCS call cancels its request in flight and rejects with the signal's reason, as the memory and local-fs adapters already did; an R2 binding call already in flight runs to its end and surfaces its own result. Before, an S3 request kept running after the abort, a GCS abort was wrapped as a retriable `NetworkError` and resent until the retry limit ran out, and a reason other than an `AbortError` was retried on every adapter. Code that treated a cancelled call as a `NetworkError` should check `signal.aborted` (or the reason it aborted with) instead. An aborted write is not proof that it was not applied.
