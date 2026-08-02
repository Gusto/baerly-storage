---
"@gusto/baerly-storage": patch
---

Fix `LocalFsStorage` admitting multiple winners for a concurrent `ifMatch`
CAS on the same base etag.

The `ifMatch` path read the stored body, compared etags, and only then
staged and published the new one — with awaited filesystem operations in
between, and no lock. Because `node:fs/promises` yields the event loop at
each of those, concurrent callers all read the same base etag, all passed
the comparison, and all published. Measured on the pre-fix code, 16 racers
against one base etag produced **16 winners and zero `Conflict`s**; the
same held across 16 separate `LocalFsStorage` instances over one directory.
Every update but the last was silently lost.

That is reachable in the default test suite today: the `local-fs` variant of
`randomized.test.ts` runs three writers over one directory whose write-tick
maintenance CAS-updates a shared `gc/pending.json` via `casUpdateGcPending`.
It went unnoticed because no test asserted the property — the storage
conformance suite's `ifMatch` block was three sequential cases, and its only
concurrency test covered `ifNoneMatch:"*"`.

`LocalFsStorage` now serializes every mutation of a key — `ifMatch`,
unconditional, create-if-absent, and `delete` — behind a per-key async
mutex held across the whole read-compare-write. The lock is module-level,
not per instance, because instances sharing a directory are the normal
case (`localFsStorage()` returns a new one per call); a per-instance lock
would have left the multi-writer harness broken. It is keyed on the
canonical filesystem path — `realpath`'d, case-folded, NFC-normalized —
because several spellings can name one file, and giving an alias its own
lock reinstates the race: case variants on macOS, and any symlinked root
such as `/tmp` versus `/private/tmp`. Entries are evicted when their last
contender drains, so the map is bounded by in-flight writers rather than
by the keyspace.

Two smaller defects in the same file are fixed alongside, both the same
shape as the main one. `list()` walks names and then reads each file to
hash its etag; a `delete` landing in that window escaped as a raw Node
`ENOENT` instead of a `BaerlyError` — reachable whenever GC deletes while
the compactor walks the same prefixes. A key that vanishes mid-listing is
legal on a real object store, so it is now skipped. And the
`.baerly-tmp-` prefix that `list` filters is now *reserved*: a user key
inside it used to be writable and readable but invisible to `list`,
silently violating put-then-list.

One trade-off is worth stating because the EXDEV change created it: a
temp stranded by a hard crash now sits inside the bucket, and since every
enumerator goes through `list`, nothing reclaims it. Staging in
`os.tmpdir()` at least let the OS reap it. Non-crash failures are still
cleaned up.

The conformance suite gains the missing contract — "admits exactly one
winner under concurrent `ifMatch` on the same etag", plus an error-code
parity row — so it now binds every backend rather than just this one.
`MemoryStorage` and the miniflare R2 binding already satisfied it.

The guarantee is explicitly single-process, and the adapter's docs now say
so precisely: within a process, concurrent CAS on a key admits exactly one
winner across any number of instances; across processes nothing is
guaranteed, which is why horizontally-scaled deploys need S3 / R2.
