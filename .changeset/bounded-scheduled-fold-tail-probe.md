---
"@gusto/baerly-storage": minor
---

Bound Cloudflare Free scheduled maintenance tail discovery.

`CLOUDFLARE_FREE_TIER` now bounds both scheduled tail probes. Which scheduled recipe fits each host is in the "Cloudflare scheduled maintenance budgets" entry of this release.

`CLOUDFLARE_FREE_TIER.compact.minEntriesToCompact` drops from 50 to 20, so Free-tier scheduled compaction now folds as soon as one pass's worth of log entries is available. A threshold above the 25-slot probe budget is not reachable in a single pass, so the old 50 would have made bounded passes checkpoint repeatedly before folding anything.

Compaction walks at most 25 stale-tail log slots per pass. A pass that cannot yet prove the fold threshold durably advances `tail_hint` and returns `skippedReason: "probe-budget-checkpointed"`; later scheduled passes resume from that checkpoint.

The exact Free-tier per-phase maxima are now pinned: compaction 49 operations and GC 22.

`CompactResult` and the tier profiles are no longer published (see the entry of this release where `/maintenance` "exports one function"); a checkpointed pass now reports `deferred: { reason: "budget" }`:

```ts
// before
switch (result.skippedReason) {
  // existing cases only
}

// after
const res = await runScheduledMaintenance(target, { tier: "cf-free" });
if (res.deferred?.reason === "budget") {
  // No snapshot was published; the next scheduled pass resumes.
}
```
