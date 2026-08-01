---
"@gusto/baerly-storage": minor
---

Remove `lastModified` from `StorageListEntry`. A listed object is now
`key` + `etag` only.

The field existed to serve one consumer: GC anchored a candidate's
`due_at` on it. That anchoring was a bug — it was populated only by the
S3/GCS/R2 adapters, so it made the grace period `max(0, grace − object
age)` on exactly those backends while reading full-length everywhere the
test suite ran. With the anchor corrected to `now() + grace`, nothing
read the field, and three adapters were still minting a `Date` per
listed entry on every LIST for a value with no consumer.

Nothing else wanted it. `baerly admin usage` had already declined it,
reading `commit_ts` from the `LogEntry` body instead and documenting
that as the cross-backend-uniform choice. A per-entry server clock is
not something the protocol should carry speculatively; the wall-clock
needs that are real are served by `StoragePutResult.serverDate`, which
drives the adaptive clock-skew loop and is unaffected.

Marked `minor` rather than `patch` because `StorageListEntry` is
exported from the public barrel and `docs/contributing/extending.md`
names `Storage` as an extension point, so this narrows published type
surface. There are no third-party adapters, and all five in-tree impls
(`MemoryStorage`, `LocalFsStorage`, `S3HttpStorage`, `GcsHttpStorage`,
`r2BindingStorage`) are updated, so no known consumer breaks. A custom
adapter that yielded `lastModified` would now fail its excess-property
check and can drop the line.

The storage conformance suite previously projected the field out of its
list-entry comparison as adapter-optional — which is precisely why it
could not see the GC bug. It now compares entries whole, so a
backend-specific field cannot be reintroduced without a conformance
failure.
