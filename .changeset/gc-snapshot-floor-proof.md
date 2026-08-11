---
"@gusto/baerly-storage": patch
---

GC proves an orphan snapshot is obsolete before deleting it.

A due `orphan-snapshot` candidate is now checked against a freshly read
`current.json`: a candidate the fresh pointer names is rescued, and every
other one must prove its `max_seq` is strictly below the observed
`log_seq_start` before it is deleted. Previously a compactor that published
a snapshot between GC's classification and its DELETE could have that live
snapshot removed. Snapshot keys GC cannot parse — unknown levels,
non-canonical names, inverted ranges — are left untouched and resolved out
of the bounded candidate ledger rather than being swept. This is on the
default path: it applies on every host, not only under a bounded maintenance
profile.
