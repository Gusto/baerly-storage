---
"@gusto/baerly-storage": patch
---

When bounded readback cannot resolve a failed committing create, the writer
returns non-retriable `AmbiguousCommit` (HTTP 409) instead of the reported
storage error. This includes retriable `NetworkError` (HTTP 502), which could
trigger a duplicate write. A definitive `AccessDenied` (HTTP 403) or
`InvalidConfig` from the slot's only send still surfaces as-is; the S3 and GCS
adapters report one that follows an internally retried attempt as
`NetworkError`. A create the S3 and GCS adapters saw throttled on every
attempt (`429`, or S3's `503 SlowDown`) was never applied, so it still
surfaces as retriable `NetworkError`. It joins the existing
certified-delete-floor case. Re-read by stable `_id` to reconcile; absence
does not prove failure, and a deliberate retry may repeat logical work. A
maintenance dispatcher failure after a durable commit no longer masks the
commit result.
