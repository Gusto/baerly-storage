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
from that checkpoint. Bounded GC likewise checkpoints tail progress before
deferring only orphan-content discovery. Malformed occupied probe slots retain
safe occupancy progress but make content classification incomplete.

Deferring passes report why, via the `contentDeferredReason` field and
`db.gc.content_deferred_total` metric added alongside this release. Two of the
reasons are budget-driven and self-clear; the others are degraded and do not.
The new `isDegradedContentDeferral` predicate is what tells them apart — it is
the only place that classification lives, so it stays correct as reasons are
added. A cron handler sees no metrics outside an HTTP scope, so read the field:

```ts
import { isDegradedContentDeferral, runGc } from "@gusto/baerly-storage/maintenance";

const gc = await runGc({ storage, currentJsonKey }, CLOUDFLARE_FREE_TIER.gc);
if (isDegradedContentDeferral(gc.contentDeferredReason)) {
  console.error("orphan-content GC is degraded:", gc.contentDeferredReason);
}
```

A GC pass that loses its admission-checkpoint CAS now reports the deferral too,
rather than returning a result indistinguishable from an idle no-op, and counts
the loss as `db.gc.cas_lost_total`.

The exact Free-tier per-phase maxima are now pinned: compaction 49 operations,
admitted content-marking GC 46, and content-deferred GC 49 — so every
alternating single-collection phase remains within the 50-operation invocation
limit.

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
