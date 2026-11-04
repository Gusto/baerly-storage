---
"@gusto/baerly-storage": minor
---

The HTTP client now mints an auto-ID insert's `_id` (a UUIDv7) before sending it and flags it with `mintedId`. An identical retransmission returns `201 { _id }` when the current live row matches; a different current body yields `AlreadyExists`, and deletion permits reinsertion. Calling `insert(doc)` again is a new operation and mints a new auto-ID. Caller-supplied `_id`s are sent unchanged.
