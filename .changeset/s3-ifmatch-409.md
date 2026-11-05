---
"@gusto/baerly-storage": patch
---

The S3 adapter now treats AWS S3's `409 ConditionalRequestConflict` on a contended `If-Match` PUT (such as the compactor's `current.json` CAS) as a retryable `NetworkError`, as it already did for contended `If-None-Match: "*"` creates. Previously it surfaced as a non-retriable `InvalidResponse`.
