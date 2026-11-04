---
"@gusto/baerly-storage": minor
---

Concurrent inserts of the same `_id` now have exactly one winner: the first insert to commit keeps the row, and every other one throws `BaerlyError{code:"AlreadyExists"}` (HTTP 409, `retriable: false`) and commits nothing. Previously the duplicate check saw only rows committed before the insert started, so two concurrent inserts of one `_id` could both succeed, and the later one silently replaced the earlier one's body. This applies to caller-supplied and server-minted ids alike.

The writer now reads the log entries committed between the insert's check read and its own commit, and refuses to commit over a live row it finds there. Uncontended, an insert into a collection without an index leading on `_id` makes no more storage requests than before. With such an index, the duplicate check now folds the log instead of listing the index, because the index can miss a live row: it costs a snapshot GET (once the collection has been compacted) plus one GET per log entry since the last fold, where it used to cost one LIST. Each entry a concurrent writer committed in that window costs one more GET. If log retention deleted part of that window before the writer could read it, the insert throws retriable `WriteConflict` instead, still committing nothing; call it again. An insert's `AlreadyExists` now also carries the `_id` (`BaerlyError._id`, and `error._id` in the HTTP envelope).

```ts
// before: both could resolve, and the stored row was whichever committed last
await Promise.all([tickets.insert({ _id: "t-1", by: "a" }), tickets.insert({ _id: "t-1", by: "b" })]);
// after: one resolves, the other rejects with AlreadyExists
const [a, b] = await Promise.allSettled([
  tickets.insert({ _id: "t-1", by: "a" }),
  tickets.insert({ _id: "t-1", by: "b" }),
]);
```

The rule is enforced by the writer, so it holds once every process writing to a collection runs this release. A writer still on an older release does not check the window, and its insert can still land over a concurrent one.

This narrows the `Collection.insert` contract rather than adding to it. Under the [API surface lock](../docs/contributing/conventions/change-discipline.md#api-surface-lock) a behavioural shift needs a supersession record, and this changeset is that record: "concurrent inserts of one `_id` can both succeed" is superseded by "exactly one concurrent insert of an `_id` commits".
