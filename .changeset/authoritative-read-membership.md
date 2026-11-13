---
"@gusto/baerly-storage": patch
---

Read and select mutation targets from the complete snapshot and committed log, so missing index markers and concurrent commits cannot hide live rows or invalidate read cursors. Reads no longer LIST index markers. Indexed misses now load the authoritative snapshot and log to prove absence; use explicit ordering before a limit when row choice matters.
