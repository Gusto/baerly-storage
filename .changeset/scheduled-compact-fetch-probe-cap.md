---
"@gusto/baerly-storage": patch
---

Scheduled compact under the `cf-free` profile with storage over `fetch` no longer stalls behind a stale `tail_hint`.

`runScheduledMaintenance(target, { tier: "cf-free", phase: "compact" })` now sizes its tail probe from what the invocation's 45-call request limit has left after the fold it may run, so a pass behind a stale `tail_hint` folds up to 20 entries in at most 45 calls instead of being refused at its 46th call before writing anything. When less is left, the pass records how far it probed and reports `deferred: { reason: "budget" }`; the next scheduled pass continues from there. The API is unchanged.
