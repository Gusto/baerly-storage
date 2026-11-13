---
"@gusto/baerly-storage": minor
---

**Breaking:** `insert`, `replace` and `update` (by id or by predicate) now refuse a document or patch holding a value JSON cannot store as written, with `BaerlyError{code:"InvalidConfig"}` before any storage call. The message names the path of the first offending value, and `err.resolution` says how to convert it.

Refused at any depth: `NaN`, `Infinity`, `-Infinity`, an `undefined` object member (on `insert` and `replace`), an `undefined` or missing array element, a function, a symbol, a bigint, a circular reference, and any nested object that is not a plain object or array (`Date`, `Map`, `Set`, typed arrays, boxed primitives, class instances). The document itself may still be a class instance: its own fields are stored, as before. `update` checks the patch before any I/O and each merged post-image before any write; an `undefined` patch member is absent and leaves that field unchanged, as the same patch sent over HTTP does. Before, the write path's `JSON.stringify` silently stored `null` for `NaN`/`±Infinity` and for `undefined` array elements, dropped `undefined` members, functions and symbols, stored a `Date` as its ISO string and a `Map` as `{}`, and threw a raw `TypeError` for a bigint or a cycle. The HTTP client (`createBaerlyClient`) applies the same check before it sends, because a server only receives what `JSON.stringify` produced. `null` values, `-0`, and a top-level `_id: undefined` (treated as absent) are accepted as before. A raw-HTTP caller cannot express any of these values, so its requests are unaffected.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before: silently stored { due: "1970-01-01T00:00:00.000Z", score: null, tags: {} }
await db.collection("tasks").insert({ due: new Date(0), score: NaN, tags: new Map() });
// after: convert to plain JSON yourself
await db.collection("tasks").insert({
  due: new Date(0).toISOString(),
  score: null,
  tags: Object.fromEntries(new Map()),
});

// before: a nested Date in a patch was merged away or stored as a string
await db.collection("tasks").update(id, { meta: { due: new Date(0) } });
// after
await db.collection("tasks").update(id, { meta: { due: new Date(0).toISOString() } });
```
