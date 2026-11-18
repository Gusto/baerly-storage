---
"@gusto/baerly-storage": patch
---

Fix `LocalFsStorage` admitting multiple winners for a concurrent `ifMatch` CAS on the same base etag. Concurrent callers could all read the same etag, all pass the comparison and all publish, so every update but the last was silently lost; 16 racers produced 16 winners and no `WriteConflict`.

`LocalFsStorage` now serializes every mutation of a key (`ifMatch`, unconditional, create-if-absent and `delete`) behind one in-process lock per key, shared by every instance over the same directory and keyed on the canonical file path, so case variants and symlinked roots (`/tmp` and `/private/tmp`) share it too. The guarantee is single-process: within a process, concurrent CAS on a key admits exactly one winner across any number of instances; across processes nothing is guaranteed, which is why horizontally scaled deploys need S3 or R2.

Two smaller fixes in the same adapter:

- A key deleted while `list()` walks it is skipped, instead of escaping as a raw Node `ENOENT` rather than a `BaerlyError` (reachable whenever GC deletes while the compactor lists).
- The `.baerly-tmp-` key prefix is reserved. A user key inside it used to be writable and readable but invisible to `list`.

A temp file stranded by a hard crash now stays inside the bucket directory, where nothing reclaims it; non-crash failures are still cleaned up.
