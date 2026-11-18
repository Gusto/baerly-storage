---
"@gusto/baerly-storage": patch
---

Lower CPU and memory per request. Results, signatures and auth behavior are unchanged.

- `order(...).limit(k)` with `k` up to 64 selects the top `k` rows without sorting every matching row.
- Filtered reads and `count()` evaluate the predicate in one pass per query.
- S3 requests signed by `sigV4Signer` or the S3, R2 and Minio storage factories no longer copy the request body to sign it, so a large PUT no longer holds a second copy of its body.
- `goog4Signer` and `gcsStorage` reuse the derived signing key for the same secret and UTC day.
- `cloudflareAccess` verifies the `Cf-Access-Jwt-Assertion` token without rebuilding the request.
- Snapshot hashing no longer copies the snapshot bytes.
