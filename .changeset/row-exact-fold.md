---
"@gusto/baerly-storage": minor
---

In-band compaction now counts real rows against the host's row ceiling `E`
instead of assuming every log entry adds one. A fold applies the longest
prefix of its slice whose rebuilt snapshot stays within `E` rows and stops
before the first entry that would add a row past it. Previously a fold
deferred whenever `snapshot_rows + maxFoldEntriesPerPass > E`, so a
collection within one pass of `E` stopped compacting even when its tail was
only updates or deletes; the tail then grew without bound and every read paid
one GET per entry.

Updates and deletes now fold a full pass right up to `E`, and a delete-only
tail drains in place at `E`. Compaction stops only when the next log entry
would add a row to a snapshot already holding `E` rows. `baerly inspect`
reports `fold_gate: closed:rows` once stored `snapshot_rows > E`, and the
`fold_deferred` record no longer carries `max_fold_entries_per_pass`.
