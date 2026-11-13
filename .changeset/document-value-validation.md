---
"@gusto/baerly-storage": minor
---

**Breaking:** `insert`, `replace` and `update` (by id or by predicate) now refuse a document or patch holding a value JSON cannot store as written, with `BaerlyError{code:"InvalidConfig"}` before any storage call. The message names the path of the first offending value, and `err.resolution` says how to convert it.

Refused at any depth: `NaN`, `Infinity`, `-Infinity`, an `undefined` object member, an `undefined` or missing array element, a function, a symbol, a bigint, a circular reference, and any object that is not a plain object or array (`Date`, `Map`, `Set`, typed arrays, boxed primitives, class instances). Before, the write path's `JSON.stringify` silently stored `null` for `NaN`/`±Infinity` and for `undefined` array elements, dropped `undefined` members, functions and symbols, stored a `Date` as its ISO string and a `Map` as `{}`, and threw a raw `TypeError` for a bigint or a cycle. The HTTP client (`createBaerlyClient`) applies the same check before it sends, because a server only receives what `JSON.stringify` produced. `null` values, `-0`, and a top-level `_id: undefined` (treated as absent) are accepted as before.

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

// before: an undefined patch member was ignored
await db.collection("tasks").update(id, { note: maybeNote });
// after: omit the field, or pass null to delete it (RFC 7386)
await db.collection("tasks").update(id, maybeNote === undefined ? {} : { note: maybeNote });
```
