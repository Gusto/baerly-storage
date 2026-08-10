---
"@gusto/baerly-storage": minor
---

Remove the `orphan-content` GC category.

`runGc` no longer LISTs, reads, or deletes anything under
`<collection>/content/`. Current writers no longer emit
`content/<sha>.json`; a supported v0.6.0 node can still create one during
a mixed rollout. No kernel reader opens these side objects, and current GC
ignores the prefix, so they are inert to the current kernel — they cost
storage and nothing else. They are left on the bucket. No cleanup is
required for correctness or migration. To reclaim the bytes after legacy
writers are quiesced, follow the
[backups and recovery runbook](../docs/guide/backups.md#legacy-content-cleanup),
which preserves the configured bucket key prefix and requires verifying the
target before recursive deletion.

`RunGcResult.marked` loses the released `orphan_content` member.
`RunGcResult` also loses the optional `contentDeferredReason` field;
`ContentDeferralReason` and `isDegradedContentDeferral` are no longer
exported from `@gusto/baerly-storage/maintenance`; and the
`db.gc.content_deferred_total` and `db.gc.cas_lost_total` metrics are gone.
Only `orphan_content` appeared in v0.6.0. The remaining surfaces arrived in
unreleased changesets alongside the bounded-admission work this removes, so
there is nothing to deprecate for them. If you were reading
`contentDeferredReason` from a pre-release build, remove that conditional
code: a GC pass no longer defers.

`gc/pending.json` loses `content_scan_cursor`, and
`GC_PENDING_SCHEMA_VERSION` stays at `1`. A ledger written by v0.6.0
still decodes: the field is ignored on read and dropped on the next
write, and `"orphan-content"` remains an accepted `reason`. A legacy
`orphan-content` candidate is evicted from the ledger on the next pass
without deleting the object it names. That eviction is load-bearing, not
housekeeping — the ledger keeps only its first
`GC_MAX_PENDING_CANDIDATES` entries, so a v0.6 bucket whose head was
full of content candidates would otherwise have discarded every new
`stale-log` and `orphan-snapshot` mark indefinitely.

A GC tick is substantially cheaper as a result: a maximally contended
Cloudflare-Free write-tick GC pass costs 26 storage operations against
the 50-subrequest invocation cap, down from 50. The unreleased
`CLOUDFLARE_FREE_TIER` profile drops its
`gcMaxTailProbeGets` and `gcMaxLiveLogEntriesPerRun` knobs, which fed the
removed liveness admission and nothing else. `compact()`'s own tail-probe
budget is unchanged.

One behavioural fix falls out of this. A GC tick used to suppress the
`tail_hint` refresh whenever content classification deferred, on the
grounds that the bounded admission had already checkpointed the tail —
but the two degraded reasons carried no checkpoint, so a collection with
an unreadable log entry or snapshot stopped advancing `tail_hint`
entirely, and its read and write forward-probes re-walked a growing live
tail. Every GC tick now takes the ordinary rate-limited refresh.
