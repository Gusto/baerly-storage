---
"@gusto/baerly-storage": patch
---

Reclaim replaced snapshots at the rate folds create them, so bucket
storage stops growing on a busy collection.

GC's mark pass only looked at the oldest `maxMarks` snapshot keys (20 per
pass on Cloudflare, 200 on Node). Snapshots that were already marked sat
in that window for their full 7-day grace, so newer replaced snapshots
went unmarked until the older ones were deleted. Each collection could
reclaim only about `maxMarks` snapshots per week. Any collection that
folded faster than that kept every extra replaced snapshot, and on
Cloudflare Free each one can be up to 512 KiB.

The mark pass now skips past snapshots that are already pending and
marks up to `maxMarks` new ones each pass. The scan still fits one LIST
page (one request unless the provider truncates the page short). At
steady state a collection keeps about one week of replaced snapshots
(fold rate × grace period). The grace period, sweep budget, and deletion
checks are unchanged.

The GC ledger still holds at most 1000 pending snapshots, so one
collection reclaims at most about 1000 replaced snapshots per 7-day
grace, roughly 143 folds a day. A collection that folds faster than
that still accumulates the excess until the ledger has room.
