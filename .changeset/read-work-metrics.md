---
"@gusto/baerly-storage": minor
---

Every collection read now reports its work on the request's canonical log line, on every host: `db.read.decoded_entries_total` (snapshot rows plus log entries decoded, before predicate and limit — entries, not documents, so updates and deletes count once each), `db.read.live_documents_total` (distinct documents live after the fold) and `db.read.returned_rows_total` (rows left after predicate, order and limit). A point read or a `limit(1)` read still folds the whole collection, so a large decoded count beside one returned row is that read's real cost. Write verbs' pre-commit reads report the same counters.

The counters come from counts the read already holds: no extra storage calls, no change to query results, and no new threshold, warning or read cap.
