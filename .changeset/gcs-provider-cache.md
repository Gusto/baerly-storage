---
"@gusto/baerly-storage": patch
---

Cache GCS credential providers on first use, reuse credentials until five minutes before expiration, and share concurrent resolution and refresh attempts. Failed attempts propagate to callers and allow a later request to retry. AWS providers also recover from synchronous throws.

Migration: GCS providers without `expiration` now resolve once for the lifetime of the storage handle. Providers that rotate credentials must return an `expiration: Date` on every result to enable refresh; static credential objects need no changes.

```ts
// Before: relies on resolving the provider for every request.
credentials: async () => ({ accessKeyId, secretAccessKey });
// After: refresh five minutes before the credentials expire.
credentials: async () => ({ accessKeyId, secretAccessKey, expiration });
```
