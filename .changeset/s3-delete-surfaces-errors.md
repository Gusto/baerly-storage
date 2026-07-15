---
'@gusto/baerly-storage': patch
---

S3/GCS adapter `delete()` now surfaces an unexpected non-2xx/404 status
as an error instead of silently treating it as success. `200`/`204`/`404`
stay a success (delete is idempotent; a `404` is a no-op); anything else
maps through the shared classifier (`403 → AccessDenied`, `429`/`≥500 →
retryable `NetworkError`, else `InvalidResponse`).

**Why:** the previous inline path swallowed every non-2xx as success, so
a `403` on delete during GC/compaction looked like it removed an object
it never touched — the bucket would grow while maintenance reported
success. Surfacing the status is a correctness fix. It is safe on the
write path: GC deletes in parallel and a thrown delete aborts only the
rest of that sweep (landed deletes are durable, `pending.json` is
CAS-merged), and the maintenance runner already swallows every
non-`Conflict` throw after counting + logging it, so a delete error never
propagates to crash a write-tick.
