---
"@gusto/baerly-storage": patch
---

Cap the writer's backwards pre-image scan.

`Writer#readPreImage` walked the log backwards from the committing seq
to 0, one sequential GET per seq, to find the index keys a doc's prior
value produced so they can be deleted. Its docstring claimed the walk
was bounded by `log_seq_start`; it never was. Once GC swept a doc's
last insert/update, every later update or delete on that doc walked the
entire history inline on the write path — the only unbounded log walk
in the kernel.

The walk is now capped at `PREIMAGE_SCAN_MAX_GETS` log GETs below the
committing seq, sized against the Cloudflare free-tier wall of 50
subrequests per request: an indexed `U` commit plus a co-occurring
maintenance fold tick already spends ~41 of them.

**Behaviour change.** Stale index keys are now cleaned up only for a
doc rewritten within the budget. Colder docs keep an extra index key
until `rebuildIndex` or `baerly admin fsck --indexes` runs. That
residual is benign by construction — an extra key is a false positive
the read path drops, never a missing candidate — but it is more common
than before, and `docs/spec/sync-protocol.md` invariant 7 has been
amended to say so. Run `fsck --indexes` if you rely on index-key counts
directly.

No new metric label: the give-up path is the common case at this
budget, so counting it on `db.write.index_cleanup_errors_total` would
swamp the two steps on that counter that do signal a failure.
