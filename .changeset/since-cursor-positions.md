---
"@gusto/baerly-storage": patch
---

`/v1/since` cursors now survive log folds, and an empty cursor no longer misses changes that fold between polls.

- A caught-up cursor kept getting `410 CursorExpired` after each fold, even though the client had seen everything. A cursor now resumes across folds, reading entries that were folded but not yet reclaimed. It expires only when a change it still needs is gone, meaning the client fell further behind than the log keeps.
- A subscriber that polled with `cursor=""` and got no events stayed on `""`. Each poll then started again from the log floor, so a change that committed and folded between two polls was never delivered. The first response to `""` now returns a position cursor even when `events` is empty. This includes an empty or not-yet-created collection, whose first change could otherwise commit and fold before the next poll. Pass it back as usual.
- A resumed cursor whose next log entry is missing now gets `CursorExpired` instead of skipping that entry without notice.

Clients that already pass `next_cursor` back after every response, including empty ones, need no change. The React hooks already do. A hand-rolled `/v1/since` loop that keeps its cursor only when `events` is non-empty must also adopt `next_cursor` from empty responses. During a rolling deploy that mixes versions, an older server answers the new position cursors with `CursorExpired` (or echoes one back unchanged for a collection that does not exist yet), so idle subscribers may refetch until every server runs this version.
