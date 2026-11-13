---
"@gusto/baerly-storage": minor
---

**Breaking:** `insert` now refuses a present, non-string `_id`, and `get` refuses an id no row can be stored under. Both throw `BaerlyError{code:"InvalidConfig"}` (HTTP 400) before any storage call.

`insert({ _id: 42 })` and every other present non-string `_id` (`true`, `{}`, `[]`, `-0`, `NaN`, `null`) used to be silently replaced by a generated UUIDv7, so the row landed under an id the caller never saw. It now throws, in-process and in the HTTP client (which throws before sending). An absent `_id`, `_id: undefined` and `_id: ""` still get a generated id.

`get(id)` and `GET /v1/c/:collection/:id` with an id that breaks the `_id` key rules (empty, `/`, `.` or `..`, a control character, a leading `_`, over 256 UTF-8 bytes) used to answer "not found" (`undefined`, HTTP 404) after reading storage. They now throw `InvalidConfig` (HTTP 400). Point reads do not require NFC, so a row an earlier release stored under a non-NFC `_id` stays readable. In the HTTP client, `get("")`, `get(".")` and `get("..")` used to resolve to the list route and return an array of rows; they now throw `InvalidConfig` without a request.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before: a numeric id was silently replaced by a generated one
await db.collection("orders").insert({ _id: 42, total: 10 });
// after: pass the id as a string, or omit it to have one generated
await db.collection("orders").insert({ _id: String(42), total: 10 });

// before: an invalid id read as "not found"
const row = await db.collection("orders").get(userSuppliedId); // undefined
// after: it throws InvalidConfig; treat that as "no such row" if the id is untrusted
let found;
try {
  found = await db.collection("orders").get(userSuppliedId);
} catch (err) {
  if (!(err instanceof BaerlyError && err.code === "InvalidConfig")) throw err;
  found = undefined;
}
```
