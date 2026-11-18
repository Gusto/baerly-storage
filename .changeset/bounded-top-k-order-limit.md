---
"@gusto/baerly-storage": patch
---

`order(...).limit(k)` reads with `k` up to 64 select the top `k` rows with a bounded heap instead of sorting every row; results are unchanged.
