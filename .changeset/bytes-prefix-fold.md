---
"@gusto/baerly-storage": patch
---

In-band compaction now folds the longest prefix of its pass whose rebuilt snapshot stays within the host's byte ceiling `C`, sized entry by entry, instead of deferring the whole pass when the pass as a whole would rebuild past `C`. A byte-heavy pending change no longer pins the changes before it: they fold, and the next pass starts at the heavy change, so a delete or shrinking update behind it can fold with it and the collection recovers on the same host.

The `CapacityExceeded` "no fold can make progress" state for bytes is now decided from the pending log alone, not from where fold passes fall: it applies when a fold pass's worth of pending changes in a row each leave the snapshot past `C`. A write that would complete such a run is refused too, since it could never fold on that host; a write that brings the collection back within `C` still commits. Reads keep working in every case, and nothing new is configured.
