---
"@gusto/baerly-storage": minor
---

A collection whose snapshot has passed the fold ceiling (`C` bytes, or
`snapshot_rows + maxFoldEntriesPerPass > E` rows) now says so loudly. Past that
wall compaction stops for good on that host profile: `log_seq_start` freezes,
log retention freezes with it, and the live tail and the bucket grow without
bound while writes keep succeeding. Previously the only signals were an
unlabeled counter that never reached the canonical line on Cloudflare and a
`console.warn` that recommended `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` even when
rows had tripped, where it does nothing.

- **Structured warning.** Each deferral emits a `fold_deferred` LogTape record
  at `warning` on the new `["baerly", "maintenance"]` category, with fields
  `collection`, `dimension` (`bytes` / `rows`), `gate` (`pre-fold` /
  `rebuild`), `snapshot_bytes`, `snapshot_rows`, `ceiling_bytes`,
  `ceiling_rows`, `max_fold_entries_per_pass`, `live_log_tail`, and
  `log_seq_start`. On Cloudflare this record is the signal, since the fold runs
  in `ctx.waitUntil` after the canonical line is written. The human
  `console.warn` stays and now names both ceilings, the tripped arm, that
  retention is paused, and the remedy for that arm. Both fire on a
  collection's first deferral and then at most once per 1,000 writes.
- **Metrics.** `db.compaction.deferred_total` gains a `gate` label, and the new
  `db.compaction.deferred_bytes_total` / `db.compaction.deferred_rows_total`
  carry the dimension onto the canonical line, which drops labels. A deferral
  is counted once: `compact()` no longer emits the counter and instead returns
  `deferral: { dimension, snapshotBytes, snapshotRows }` on its `"deferred"`
  result.
- **Rebuild-gate deferrals.** When the stored snapshot is under `C` but the
  rebuilt one is over it (the usual way bytes first cross `C`), the write tick
  now signals and refreshes `tail_hint` like any other deferral, instead of
  ending silently.
- **`baerly inspect`** reports `fold_gate` per host profile (`cf-free`,
  `cf-paid`, `node`): `open`, `closed:bytes`, or `closed:rows`, with the
  profile's `C` and `E` and a `retention_stalled` flag. `--profile=<name>`
  narrows it to one host, and `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` from the CLI's
  environment overrides `C`. Exit code stays 0.

`MaintenanceDispatch` gains an optional `warn` sink, which both shipped adapters
set. A custom adapter that builds its own `MaintenanceDispatch` gets only the
`console.warn` line until it sets `warn: logMaintenanceWarning` (exported from
`@gusto/baerly-storage/observability`).
