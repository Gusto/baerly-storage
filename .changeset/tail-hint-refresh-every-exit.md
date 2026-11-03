---
"@gusto/baerly-storage": patch
---

Write-tick maintenance now refreshes `tail_hint` whenever the refresh is due,
including when the tick's fold publishes nothing or the fold or GC throws.
Previously a collection whose folds and GC kept failing (for example a
persistent 503 with no adapter retries) never advanced `tail_hint`. Each
commit's tail search then cost more GETs as writes piled up since the last
refresh, and once the lag neared 100,000 writes, reads and then commits
started failing.
The lag now stays within about 132 writes (the 128-write refresh interval plus
the 4-write GC cadence) whatever the tick's outcome.
