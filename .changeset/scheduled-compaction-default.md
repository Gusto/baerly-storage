---
"@gusto/baerly-storage": patch
---

Scheduled maintenance now folds whatever live tail exists. Before, `runScheduledMaintenance` inherited the in-band write tick's floor of 100 entries (50 for the Cloudflare Paid recipe), so a cron on a low-write collection ticked green for months while folding nothing and every read paid for the unfolded tail.

The floor is no longer configurable: `minEntriesToCompact` left the public options when scheduled maintenance became addressed by collection (see the entry of this release where `/maintenance` "exports one function"). Node and `"cf-paid"` passes fold from one pending entry; `"cf-free"` folds a 20-entry slice. Every fold rewrites the whole snapshot, so a hot cron rewrites it more often; to batch rewrites, run passes less often:

```ts
// before
await runScheduledMaintenance(args, { compact: { minEntriesToCompact: 100 } });
// after: no floor option; run the pass on a slower cron instead
await runScheduledMaintenance({ storage, app, tenant, collection });
```

A pass that skips a non-empty tail below its floor now counts `db.compaction.below_min_total` (labelled by `collection`); an idle pass does not. The per-trigger floors are in `docs/spec/sync-protocol.md` § "Scheduled vs in-band fold floors".
