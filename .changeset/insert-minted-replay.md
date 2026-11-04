---
"@gusto/baerly-storage": minor
---

`POST /v1/c/:collection` accepts an optional `mintedId` next to `doc`. When a client minted the document's `_id` itself, it sends that id in both `doc._id` and `mintedId`; if a live row with that `_id` already holds exactly the same document, the insert returns the original `201 { _id }` instead of `409 AlreadyExists`, and commits nothing. Key order does not matter; any other difference in the body is still a `409`. Replay compares the current live row: deletion permits reinsertion, an update to a different body yields `AlreadyExists`, and updating back to the original body permits replay. Calling `insert(doc)` again is a new operation and mints a new auto-ID. The `@gusto/baerly-storage` HTTP client sends `mintedId` for every auto-ID insert in this release.

`mintedId` must be a canonical UUIDv7 equal to `doc._id`; anything else is `400 SchemaError`. An insert without `mintedId` keeps strict `409 AlreadyExists` on any live row, even an identical one, so a caller-chosen `_id` used as a run-once guard still has at most one winner. In-process `Collection.insert` is unchanged. A server without this change ignores `mintedId` and answers a resend `409`, never with a duplicate row.

```sh
curl -X POST "$BASE/v1/c/tickets" -H "Authorization: Bearer $TOKEN" \
  -d '{"doc":{"_id":"0195f1c2-7a3b-7c4d-8e5f-0123456789ab","title":"hi"},"mintedId":"0195f1c2-7a3b-7c4d-8e5f-0123456789ab"}'
# first send, or identical resend while the current live row matches: 201 {"_id":"0195f1c2-7a3b-7c4d-8e5f-0123456789ab"}
```
