---
"@gusto/baerly-storage": patch
---

`runScheduledMaintenance` no longer inherits `compact()`'s
`minEntriesToCompact` default of 100. It now applies its own scheduled
default of `1` (`SCHEDULED_MIN_ENTRIES_TO_COMPACT`), so a scheduled pass
folds whatever live tail exists.

Previously, a cron that called `runScheduledMaintenance` with no options
ticked green for months while folding nothing: a low-write collection's
tail sat permanently below the 100-entry floor (measured in the wild at
36 entries — every read paying 36 S3 GETs, ~1.2s, forever) and every skip
was invisible. The floor of 100 (and the write-tick floor of 50) exists
for the **in-band write tick**, where a write is not a scheduling
decision and folding on every write would thrash snapshot rewrites; the
scheduled path — where the scheduler firing *is* the decision to work —
shares neither cost profile and no longer shares the default.

No migration is required, and callers passing an explicit
`options.compact.minEntriesToCompact` (including the
`CLOUDFLARE_*_TIER` profiles, which carry their own explicit thresholds)
are unaffected. If you relied on the bare call **not** folding small
tails — e.g. to batch snapshot rewrites on a write-amplification-
sensitive host — pass the floor you want:

```ts
await runScheduledMaintenance(
  args,
  { compact: { minEntriesToCompact: 100 } }, // previous effective default
);
```

Every fold rewrites the entire snapshot; at a 5-minute cadence the new
default bounds snapshot rewrites to one per tick that actually received
writes (an idle tick costs only the `current.json` GET + tail probe).
The trade-off and the per-trigger floor table are documented in
`docs/spec/sync-protocol.md` § "Scheduled vs in-band fold floors".

Also in this change: a below-floor skip is now observable. `compact()`
emits `db.compaction.below_min_total` (with the `collection` label) when
it returns `skippedReason: "below-min-threshold"`, so a maintenance loop
that discards results can no longer look healthy while doing nothing —
see `docs/guide/observability.md` for the response playbook.