---
"@gusto/baerly-storage": patch
---

Write-triggered maintenance now also folds once the pending log tail reaches a fixed entry count (20 under the default Cloudflare profile, 64 under `cf-paid` and on Node), not only once the tail's bytes reach the snapshot's. Every read and write fetches each pending log entry with its own storage GET, so on a large collection of small documents a request could make thousands of storage reads (a point read on a 32 MiB collection on Workers Paid made about 6,300); it now makes at most the entry count plus a few fixed reads. The cost is more frequent snapshot rewrites on large collections: about one per 64 writes where it was as rare as one per 200. No API, option or stored format changes.
