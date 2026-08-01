---
"@gusto/baerly-storage": patch
---

Give GC's grace period its full length on every storage backend. It was
silently near-zero on all of them except the two the test suite runs.

`runGc` marks an orphan candidate with a `due_at` horizon and only
deletes it once that horizon passes, so a writer still retrying towards
an anchor we judged dead has a window to land. `computeDueAt` set that
horizon to `(entry.lastModified ?? now()) + grace` — anchored, when the
adapter surfaced it, to when the *object* was written rather than to
when we *marked* it.

`StorageListEntry.lastModified` was optional, and which adapters
populated it split exactly along the local/production line:
`MemoryStorage` and `LocalFsStorage` omitted it and took the `now()`
fallback; the S3, GCS and R2 adapters populated it from server-side
headers. On those three the effective grace was `max(0, grace − object
age)`, so past the seven-day `GC_GRACE_PERIOD_MILLIS` default it was
**zero** — a candidate was marked already-due and swept on the next pass
with no absorber. Stale-log and orphan candidates are precisely the
objects old enough to hit this. The constant's own contract tells
operators not to lower the knob; the anchoring defeated it regardless of
what they set.

`computeDueAt` now anchors on the mark — `now() + grace`, unconditionally
— and no longer reads `lastModified`. This is strictly more conservative
than the old behaviour on every backend, so it cannot delete anything
sooner than before; on the local-clock backends it is unchanged.

No test could see this. The default suite runs `memory` and `local-fs`,
both on the fallback path, and `pnpm test:parity` could not either — the
storage conformance suite projected `lastModified` out of its comparison
as adapter-optional. The regression test therefore lists through a
delegating `Storage` that attaches a month-old timestamp to every listed
entry, which was the only way to reach the production shape from
`MemoryStorage`.

With the anchor corrected the field had no reader left, and it is
removed from `StorageListEntry` in this same release — see the
accompanying `minor` entry. A listed object is now `key` + `etag` only.
The regression test keeps attaching a timestamp anyway, via a cast, to
assert that `computeDueAt` reads nothing off the entry at runtime.

Not retroactive: candidates already recorded in `gc/pending.json` keep
the `due_at` they were marked with, so the first pass after upgrading
still sweeps that backlog on the old horizon. Nothing is deleted sooner
than it would have been without this fix — the full window applies to
everything marked from here on.
