---
"@gusto/baerly-storage": minor
---

Remove `lastModified` from `StorageListEntry`. A listed object is now `key` + `etag` only.

GC was its only reader, and anchoring the grace period on it was a bug (see the GC grace entry of this release). Wall-clock needs are served by `StoragePutResult.serverDate`, which is unchanged. A custom `Storage` adapter that yields `lastModified` now fails its excess-property check; drop the field.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before: yield { key, etag, lastModified }  // after: yield { key, etag }
```
