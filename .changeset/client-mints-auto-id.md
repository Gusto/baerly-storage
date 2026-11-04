---
"@gusto/baerly-storage": minor
---

The HTTP client now mints an auto-ID insert's `_id` (a UUIDv7) before sending it and flags it with `mintedId`, so resending the same request can never create a duplicate row: the server answers an identical resend with the original `201 { _id }`. Caller-supplied `_id`s are sent unchanged.
