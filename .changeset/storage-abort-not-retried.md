---
"@gusto/baerly-storage": patch
---

An S3 or GCS storage call whose `AbortSignal` aborts mid-request now rejects with that `AbortError` after the one attempt. Before, the abort was wrapped as a retryable `NetworkError` and resent until the retry cap ran out.
