---
"@gusto/baerly-storage": patch
---

Fence GC deletion candidates to the collection generation that marked them, re-check `stale-log` candidates at sweep time, and clear the GC ledger on `baerly admin restore`.

Before, a candidate was a bare key, so a decision made against one view of the bucket could run up to seven days later against another. After `baerly admin restore --force` re-created a log object an earlier pass had already marked, GC could delete it, leaving a hole in the live log that made every read and fold of the collection fail with `Internal`.

- Each candidate now records the `current.json` generation it was marked under. A pass drops (never deletes) a candidate whose generation no longer matches, or a `stale-log` candidate that is live again. This adds no storage calls.
- `baerly admin restore` deletes `gc/pending.json` before its first commit, so a reseeded collection does not inherit the old ledger.
- A GC pass that finds `gc/pending.json` deleted under it reports a retriable `WriteConflict` rather than `InvalidResponse`, so a restore no longer makes a concurrent maintenance pass fail with a corrupt-data code.
- New metric `db.gc.dropped_total`, labelled by cause (`stale-generation`, `still-live`), counts candidates resolved without a DELETE. A sustained `still-live` rate means marking is misjudging liveness.

A pass already in flight when a restore lands still holds the old manifest, so a window of one pass remains; run a restore that matters without a maintenance pass racing it.

**On upgrade.** No migration or configuration. `generation` is optional, so `GC_PENDING_SCHEMA_VERSION` stays 1. Expect one `stale-generation` drop spike on the first pass after upgrading: each older candidate is dropped and, if still orphaned, marked again, which delays its reclamation by one grace period. Each `baerly admin restore` causes another, self-healing spike.
