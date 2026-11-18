---
"@gusto/baerly-storage": patch
---

Give GC's grace period its full length on every storage backend. On S3, GCS and R2 it was effectively `max(0, grace − object age)`, so a candidate older than the seven-day default was marked already due and deleted on the next pass, with no window for a retrying writer. Only `MemoryStorage` and `LocalFsStorage` got the full grace.

GC now anchors a candidate's due time on when it was marked (`now() + grace`) and no longer reads the listed object's `lastModified` (which this release removes from `StorageListEntry`). This is strictly more conservative on every backend, so nothing is deleted sooner than before.

Not retroactive: candidates already recorded in `gc/pending.json` keep the due time they were marked with, so the first pass after upgrading still sweeps that backlog on the old horizon.
