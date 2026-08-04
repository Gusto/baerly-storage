---
"@gusto/baerly-storage": minor
---

GC no longer classifies orphan content against an incomplete live set.

A missing or malformed live log entry, or a `current.json` snapshot that
will not read or hash-verify, previously left those post-images out of the
live set and let the pass mark live content as orphan; the 7-day grace
period was expected to absorb it. It does not, because a persistent fault
recurs on every pass and the mark stands until the sweep deletes the blob.
Such a pass now skips orphan-content discovery entirely: nothing marked, no
pending content candidate swept, and `content_scan_cursor` held so the next
pass resumes in place. Stale-log and orphan-snapshot marking and their
sweeps are unaffected. A pending content candidate proven live by a
complete set is now rescued rather than swept. This is on the default path:
it applies on every host, not only under a bounded maintenance profile.

**Operators should watch for this.** `RunGcResult` carries a new optional
`contentDeferredReason` (`"live-log-unreadable"` or
`"snapshot-unreadable"`, exported as `ContentDeferralReason`), also
emitted as the `db.gc.content_deferred_total` counter labelled by reason.
A reason names the unreadable artifact, not the fault class, so a single
occurrence may be a transient storage error; a reason that REPEATS across
passes does not self-clear, and orphan content accumulates for as long as
the underlying artifact is unreadable. A cron handler runs outside any
HTTP scope where metrics fall through to the noop recorder, so read the
result field and log a reason that repeats across passes. `admin fsck`
walks the same chain.
