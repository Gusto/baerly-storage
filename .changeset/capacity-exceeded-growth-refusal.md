---
"@gusto/baerly-storage": minor
---

Writes now fail with the new non-retriable `BaerlyError{code:"CapacityExceeded"}`
(HTTP 409) instead of silently stalling compaction when a collection reaches
its host's fold ceiling (`E` rows or `C` snapshot bytes for the active
maintenance profile). Nothing is committed when a write is refused.

- An insert, or an update that makes a row larger, is refused once the
  projected snapshot would reach `E` rows or pass `C` bytes. Deletes and
  same-size or shrinking updates still commit and make room for later growth
  (on the bytes arm, once the snapshot itself is over the limit, after
  write-tick maintenance folds them).
- When the stored snapshot is already past the ceiling (for example a
  collection folded on a larger host and served by a smaller one), or a pending
  insert cannot fold onto an `E`-row snapshot, every write is refused; serve it from a larger profile (`BAERLY_MAINTENANCE_PROFILE=cf-paid`
  or `node`) or export it with `baerly admin dump`. Reads keep working.
- A batch `.where(...).update()` / `.delete()` is refused before its first row
  commits. Its per-row `_id` and schema checks also now run for every matched
  row before any row commits.
- Concurrent writes cannot together pass the ceiling: when another write
  commits between a write's check and its own commit, the check runs again
  over those writes before committing, and the later write is refused. A
  batch refused this way part-way keeps the rows it already committed. With
  no concurrent write in between, the commit reads nothing extra.

The decision is recomputed on every request from the collection's current
state, so the refusal clears with no operator action. Direct `Writer` commits,
including `baerly admin restore`, are not checked.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before: a collection past its host's fold ceiling kept accepting writes
// while compaction silently stalled
await tickets.insert(doc);

// after: growth can be refused. CapacityExceeded is not retriable, so a
// generic retry wrapper (retriable === false) will not loop on it.
try {
  await tickets.insert(doc);
} catch (err) {
  if (err instanceof BaerlyError && err.code === "CapacityExceeded") {
    // Nothing was committed. Delete or shrink rows, archive the collection,
    // or move it to a host with a larger ceiling; reads and deletes still work.
  } else {
    throw err;
  }
}
```

Over HTTP the refusal is `409` with `error.code: "CapacityExceeded"`. Alerting that matched `409` as a write conflict should match on `error.code` instead.
