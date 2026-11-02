---
"@gusto/baerly-storage": patch
---

When bounded readback cannot resolve a failed committing create, the writer
returns non-retriable `AmbiguousCommit` (HTTP 409), joining the existing
certified-delete-floor case, instead of the reported storage error. That
error could be a retriable `NetworkError` (HTTP 502), which could trigger a
duplicate write.

`AmbiguousCommit` now carries the affected row's `_id` (`BaerlyError._id`,
and `error._id` in the HTTP envelope), including an auto-ID insert's minted
id. Re-read that row to reconcile; absence does not prove failure. Retry an
insert with the same `_id` so it cannot create a second document; a
deliberate retry may still repeat logical work.

A definitive `AccessDenied` (HTTP 403) or `InvalidConfig` from the slot's
only send still surfaces as-is; the S3 and GCS adapters report one that
follows an internally retried attempt as `NetworkError`. A create those
adapters saw throttled on every attempt (`429`, or S3's `503 SlowDown`) was
never applied, so it still surfaces as retriable `NetworkError`.

A maintenance dispatcher failure after a durable commit no longer masks the
commit result.
