---
"@gusto/baerly-storage": minor
---

The HTTP client now mints an auto-ID insert's `_id` (a UUIDv7, timestamped by the client's clock) before sending it, and flags it with `mintedId`. A retransmission of that same request, for example by a `fetch` wrapper that resends it, gets the original `201 { _id }` while the stored row still matches, not a duplicate row; a different current body yields `AlreadyExists`, and deletion permits reinsertion. The client itself sends each insert once and does not retransmit it. Calling `insert(doc)` again is a new operation and mints a new auto-ID. Caller-supplied `_id`s are sent unchanged.
