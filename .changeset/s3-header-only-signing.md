---
"@gusto/baerly-storage": patch
---

`sigV4Signer` and the Node S3/R2/Minio storage factories sign S3 requests from their headers only (`UNSIGNED-PAYLOAD`, as before), so a PUT no longer copies its whole body to sign it. The signed request now also keeps the caller's `AbortSignal`, so aborting an S3 storage call cancels the request in flight, as it already did for GCS.
