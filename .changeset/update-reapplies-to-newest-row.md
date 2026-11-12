---
"@gusto/baerly-storage": minor
---

`update` no longer loses a concurrent write to the same row or brings back a row that was deleted concurrently. Previously, if another write to the same `_id` committed between an update's read and its commit, the update overwrote it with the row as it was read: a concurrent `delete` that returned `{ deleted: 1 }` was undone, and a concurrent update to a different field was lost.

Updates now follow PostgreSQL READ COMMITTED semantics. The patch is applied to the row's newest committed version, so both writes' fields survive. A row deleted in between is left deleted: `update(id, patch)` returns `{ modified: 0 }` (`404 NotFound` over HTTP), and `.where(p).update(patch)` skips the row and leaves it out of `modified`. For `.where(p).update()`, `p` is evaluated again on the newest version, and a row that no longer matches is skipped. `replace(id, doc)` is still last-writer-wins against a concurrent update, but it no longer resurrects a concurrent delete: it throws `NotFound` and commits nothing. No new error codes.
