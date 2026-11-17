---
"@gusto/baerly-storage": patch
---

An S3 `400 ExpiredToken` or `TokenRefreshRequired` response (an expired STS session token whose provider returned a missing or wrong `expiration`) now drops the cached credentials and resends the request once with a fresh provider call. The resend counts against the request budget like any attempt. If the resend is rejected the same way, or the credentials are static, the call throws `AccessDenied` naming the S3 code instead of `InvalidResponse`. `S3HttpStorage` accepts an optional `invalidateCredentials` hook for custom signers; `s3Storage`, `r2Storage` and `minioStorage` wire it up. GCS is unchanged.
