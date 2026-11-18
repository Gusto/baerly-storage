---
"@gusto/baerly-storage": minor
---

Remove the `orphan-content` GC category.

`runGc` no longer LISTs, reads, or deletes anything under `<collection>/content/`. Current writers no longer emit `content/<sha>.json`; a supported v0.6.0 node can still create one during a mixed rollout. No kernel reader opens these side objects, and current GC ignores the prefix, so they are inert to the current kernel — they cost storage and nothing else. They are left on the bucket. No cleanup is required for correctness or migration. To reclaim the bytes after legacy writers are quiesced, follow the [backups and recovery runbook](../docs/guide/backups.md#legacy-content-cleanup), which preserves the configured bucket key prefix and requires verifying the target before recursive deletion.

`RunGcResult.marked` loses the released `orphan_content` member. `RunGcResult` also loses the optional `contentDeferredReason` field; `ContentDeferralReason` and `isDegradedContentDeferral` are no longer exported from `@gusto/baerly-storage/maintenance`; and the `db.gc.content_deferred_total` and `db.gc.cas_lost_total` metrics are gone. Of these, only `orphan_content` was in 0.6.0; the others never shipped in a release.

`gc/pending.json` loses `content_scan_cursor`, and `GC_PENDING_SCHEMA_VERSION` stays at `1`. A ledger written by v0.6.0 still decodes: the field is ignored on read and dropped on the next write, and `"orphan-content"` remains an accepted `reason`. A legacy `orphan-content` candidate is evicted from the ledger on the next pass without deleting the object it names. Without that eviction, a 0.6.0 ledger full of content candidates would crowd out every new `stale-log` and `orphan-snapshot` mark.

A GC tick is cheaper as a result: a maximally contended Cloudflare Free write-tick GC pass costs 26 storage operations, down from 50. Every GC tick now also takes the ordinary rate-limited `tail_hint` refresh; before, a collection with an unreadable log entry or snapshot stopped advancing `tail_hint`, so its reads re-walked a growing live tail.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before (0.6.0)
const { marked } = await runGc(args);
console.log(marked.orphan_content);
// after: runGc is no longer published; a scheduled pass reports deletions
const { gcDeleted, pending } = await runScheduledMaintenance({ storage, app, tenant, collection });
```

Delete the field from any dashboard or assertion that reads `RunGcResult.marked.orphan_content`. A leftover `content/` prefix needs no action.
