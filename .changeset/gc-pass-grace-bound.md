---
"@gusto/baerly-storage": patch
---

A GC pass now stops deleting once it has run longer than a tenth of the GC grace (about 16.8 hours against the 7-day default) since the `current.json` read its deletions rest on. Before each batch of DELETEs the pass compares the elapsed time against that bound; past it, the remaining due candidates stay in `gc/pending.json` for a later pass, which reads the manifest again. A pass on any supported host lasts seconds, so this only affects a process that was paused or starved mid-pass, which could previously delete against liveness it had read arbitrarily long before. No configuration, no lease, and no change in storage requests.
