---
"@gusto/baerly-storage": minor
---

Bound Cloudflare Free scheduled maintenance tail discovery.

`CLOUDFLARE_FREE_TIER` now bounds both scheduled tail probes. Alternate
direct `compact()` and `runGc()` calls (for example, compact on even-minute
ticks and GC on odd-minute ticks); `runScheduledMaintenance()` always runs
both phases and is not safe under Cloudflare Free's 50-operation limit in one
invocation. That was true before this release too — the previous guidance,
which said one call with this profile fits the budget, was wrong.

`CLOUDFLARE_FREE_TIER.compact.minEntriesToCompact` drops from 50 to 20, so
Free-tier scheduled compaction now folds as soon as one pass's worth of log
entries is available. A threshold above the 25-slot probe budget is not
reachable in a single pass, so the old 50 would have made bounded passes
checkpoint repeatedly before folding anything.

Compaction walks at most 25 stale-tail log slots per pass. A pass that cannot
yet prove the fold threshold durably advances `tail_hint` and returns
`skippedReason: "probe-budget-checkpointed"`; later scheduled passes resume
from that checkpoint.

The exact Free-tier per-phase maxima are now pinned: compaction 49 operations
and GC 23 — so every alternating single-collection phase remains within the
50-operation invocation limit.

If you exhaustively switch on `CompactResult.skippedReason`, handle the new
case:

```ts
// before
switch (result.skippedReason) {
  // existing cases only
}

// after
switch (result.skippedReason) {
  case "probe-budget-checkpointed":
    // No snapshot was published; allow the next scheduled tick to resume.
    break;
  // existing cases
}
```
