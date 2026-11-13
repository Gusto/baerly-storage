---
"@gusto/baerly-storage": minor
---

`update` no longer loses a concurrent write to the same row or brings back a row that was deleted concurrently. Previously, if another write to the same `_id` committed between an update's read and its commit, the update overwrote it with the row as it was read: a concurrent `delete` that returned `{ deleted: 1 }` was undone, and a concurrent update to a different field was lost.

Updates now follow PostgreSQL READ COMMITTED semantics. The patch is applied to the row's newest committed version, so both writes' fields survive. A row deleted in between is left deleted: `update(id, patch)` returns `{ modified: 0 }` (`404 NotFound` over HTTP), and `.where(p).update(patch)` skips the row and leaves it out of `modified`. For `.where(p).update()`, `p` is evaluated again on the newest version, and a row that no longer matches is skipped. `replace(id, doc)` is still last-writer-wins against a concurrent update, but it no longer resurrects a concurrent delete: it throws `NotFound` and commits nothing. No new error codes.

`delete` follows the same rule. A row that was deleted after a delete's read, including one whose `_id` was inserted again since, is not deleted again, so of two racing deletes one returns `{ deleted: 1 }` and the other `{ deleted: 0 }` (previously both returned `1`, and the second could destroy the re-inserted row). `.where(p).delete()` evaluates `p` again on the newest version and skips a row that no longer matches, leaving it out of `deleted`. A delete racing an update still deletes the row.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before: update returned { modified: 1 } and could resurrect a row deleted
// concurrently, or overwrite a concurrent update to another field
const { modified } = await tickets.update(id, { status: "closed" });

// after: the patch applies to the newest committed row. A concurrently
// deleted row stays deleted and reports modified: 0 (HTTP 404 NotFound).
const { modified } = await tickets.update(id, { status: "closed" });
if (modified === 0) {
  // row is gone: re-create it explicitly with insert() if that is what you want
}

// before: replace() on a concurrently deleted row re-created it
// after: it throws NotFound and commits nothing
await tickets.replace(id, doc).catch((err) => {
  if (!(err instanceof BaerlyError && err.code === "NotFound")) throw err;
  return tickets.insert({ ...doc, _id: id });
});
```

`delete(id)` now returns `{ deleted: 0 }` for the loser of two racing deletes; do not assume `{ deleted: 1 }` means this call removed the row.
