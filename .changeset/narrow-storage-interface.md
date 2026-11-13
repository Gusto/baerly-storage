---
"@gusto/baerly-storage": minor
---

The `Storage` interface no longer has `versionId` or conditional GET. Objects are read unconditionally and carry only an `etag`. Conditional PUT (`ifMatch`, `ifNoneMatch: "*"`) is unchanged and remains the commit primitive. The kernel never issued a conditional GET or read `versionId`, so this only affects custom `Storage` adapters and code that called `storage.get` directly. The conformance suite drops its `supportsConditionalGet` option and the conditional-get cases.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before
const got = await storage.get(key, { ifNoneMatch: etag, versionId, signal });
const { etag, versionId } = await storage.put(key, body);
defineStorageConformanceSuite("MyStorage", factory, { supportsConditionalGet: false });
// after
const got = await storage.get(key, { signal }); // always unconditional, current version
const { etag } = await storage.put(key, body);
defineStorageConformanceSuite("MyStorage", factory);
```

Adapter authors: delete the `ifNoneMatch` / `versionId` handling from `get`, the `versionId` field from `get` and `put` results, and any 304 mapping. `StorageGetOptions` is now `{ signal? }`, `StorageGetResult` is `{ body, etag }`, and `StoragePutResult` is `{ etag, serverDate? }`. Pin a historical object by keying it (the protocol's log and snapshot keys are immutable), not by S3 version id.
