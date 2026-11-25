---
"@gusto/baerly-storage": patch
---

Read responses now carry a `/v1/since` cursor for exactly the state they returned, and the React hooks start their change feed from it.

- `GET /v1/c/:collection`, `GET /v1/c/:collection/:id` and `GET /v1/count` add `_meta.since_cursor`. Polling `/v1/since` from it delivers every change committed after the rows the read returned, each once and in order, and none the read already showed. The `404 NotFound` from `GET /v1/c/:collection/:id` carries the same `_meta`, so a subscription to a row that does not exist yet sees the insert that creates it. The cursor is minted from what the read already loaded, so reads make no extra storage calls.
- `useQuery` subscriptions used to start their poll with a separate `cursor=""` request sent alongside the query, and did so again after `CursorExpired`. That request read the log at a different moment than the query, so a change that committed and folded between the two was never delivered (the query kept showing the old rows until the next change), or a change the query already showed was delivered again. The poll now waits for the query and starts from its `_meta.since_cursor`. A query that read before that cursor arrived and saw a different state reruns once.

The field is additive. A hand-rolled `/v1/since` loop should seed from the read it renders (`_meta.since_cursor`) instead of `cursor=""`, including when it re-reads after `CursorExpired`. Against a server that does not send the field, the React hooks fall back to `cursor=""`, as before.
