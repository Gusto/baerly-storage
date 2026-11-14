---
"@gusto/baerly-storage": minor
---

**Breaking:** a document is capped at 1 MiB (1,048,576 bytes) of JSON, `_id` included. `insert`, `replace` and `update` (by id or by predicate) refuse a write whose resulting row would encode larger, with `BaerlyError{code:"InvalidConfig"}` (HTTP 400) before any storage write; the message states the row's size and the limit, and `err.resolution` says how to split it. `update` checks each merged post-image, not the patch, so merge-patches that each fit the HTTP body cap can no longer grow a row past 1 MiB; a multi-row update with one over-cap row commits none. `baerly admin restore` refuses a dump line over the cap with its line number. Before, in-process writes had no size bound at all, and repeated HTTP patches could grow a row without limit. A row an earlier release stored over the cap stays readable and deletable, and an update that shrinks it under the cap commits; only a write producing an over-cap row is refused. `PayloadTooLarge` (413) still means the request body itself exceeded `MAX_BODY_BYTES`.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before: one row that keeps growing (now refused once it passes 1 MiB)
await db.collection("threads").update(threadId, { messages: [...messages, next] });
// after: one row per item, keyed back to its parent
await db.collection("messages").insert({ threadId, ...next });
```
