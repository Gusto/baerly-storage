---
"@gusto/baerly-storage": minor
---

The `Conflict` error code is removed and split in two, and `retriable` is now derived from the code alone.

- `WriteConflict` (HTTP 409, `retriable: true`, generic public message): a lost conditional write or CAS race. Re-read, then retry with bounded backoff. `Storage` implementations throw it for every rejected precondition (stale `If-Match`, or an `If-None-Match: "*"` collision).
- `AlreadyExists` (HTTP 409, `retriable: false`, message kept): a duplicate `_id` on `insert`, or `baerly admin restore` into an existing collection without `--force`. Never retry; pick a different `_id` or use `update` / `replace`.

`BaerlyError.retriable` is a pure function of `code`: only `NetworkError` and `WriteConflict` are retriable. The HTTP envelope still carries `retriable`, derived from the code. The client SDK ignores the wire value and derives it from the code. A code the client doesn't know (`Conflict` from an older server, or one added by a newer server) decodes by HTTP status, the same way as a response without an envelope: `NetworkError` for 5xx, 408 and 429, otherwise `Internal`. Only the message carries over; the undecoded wire error, including its `resolution`, `issues` and `_id`, is kept on `cause`. The CLI exits 3 for both new codes.

Migration:

```ts
// before
err.code === "Conflict" && err.retriable;   // CAS race
err.code === "Conflict" && !err.retriable;  // duplicate _id
throw new BaerlyError("Conflict", msg);     // custom Storage
new BaerlyError(code, msg, cause, issues, status, resolution, retriable, _id);
errorEnvelope(code, msg, issues, resolution, retriable, _id);

// after
err.code === "WriteConflict";
err.code === "AlreadyExists";
throw new BaerlyError("WriteConflict", msg);
new BaerlyError(code, msg, cause, issues, status, resolution, _id);
errorEnvelope(code, msg, issues, resolution, _id);
```

Both `BaerlyError` and `errorEnvelope` (from `@gusto/baerly-storage/http`) lose their `retriable` slot, so `_id` moves up one position. TypeScript rejects an old call with an extra argument; untyped JavaScript does not, and would put the old `retriable` boolean in `_id`, so update those call sites by hand. A custom `Storage` must throw `WriteConflict`, never `AlreadyExists`, for a rejected precondition: the kernel treats any other code as a hard failure, and `AlreadyExists` is a public message that would expose the bucket key.

Splitting `Conflict` renames a capability rather than removing one: both of its meanings survive under the new codes. Under the [API surface lock](../docs/contributing/conventions/change-discipline.md#api-surface-lock) a rename needs a supersession record, and this changeset is that record. The constructor's `retriable` slot goes with it, because no instance can override its code's retry meaning any more.
