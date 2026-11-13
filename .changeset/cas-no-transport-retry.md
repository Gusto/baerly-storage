---
"@gusto/baerly-storage": patch
---

Storage adapters (S3, GCS, the R2 binding) no longer resend an `If-Match`
PUT. When a compare-and-swap landed but its reply was lost or came back as
a 5xx, the resend met its own write as a 412 and reported a false
`WriteConflict`, so a fold that had published reported `cas-lost`. A failed
compare-and-swap now surfaces its first error to the caller, and every
in-tree caller (the compactor, the `tail_hint` refresh, log retirement's
floor, the GC pending ledger) skips and re-reads on its next pass. Every
other request keeps the 3-attempt retry policy.
