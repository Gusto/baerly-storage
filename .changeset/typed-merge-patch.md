---
"@gusto/baerly-storage": minor
---

`update` patches are typed `MergePatch<T>` instead of `Partial<T>`, on `Collection.update(id, patch)`, `Query.update(patch)` and the HTTP client's `ClientCollection.update`, so the type matches the RFC 7396 runtime: `null` on an optional field type-checks and deletes it, and nested plain objects take a nested patch. `null` on a required field is a compile error; remove a required field with `replace`. Arrays and scalars are still replaced whole. On an unconfigured collection every field accepts `null`. `MergePatch` is exported (type only) from `@gusto/baerly-storage` and `@gusto/baerly-storage/client`.

Types only: no runtime or wire change. A `null as never` cast on a patch member is no longer needed. The `/v1/spec` method table carries the new `update` signatures; `specVersion` stays `"1"`, since only a TypeScript type string changed and no request, response or route did.
