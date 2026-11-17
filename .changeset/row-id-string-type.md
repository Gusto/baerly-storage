---
"@gusto/baerly-storage": minor
---

**Breaking (types only):** every row a read returns is typed with `_id: string`, and `insert` types `_id` as an optional string. This holds for collections with no bound config (row type `DocumentData`), for bound-config collections, and for the HTTP client. Runtime behavior is unchanged: a stored row's `_id` is always a string, and `insert` already refuses a non-string `_id` with `InvalidConfig`.

`first()`, `all()` and `get(id)` on a collection, and `first()` / `all()` on a query, return `T & { _id: string }` instead of `T`. `insert(doc)` takes `Partial<T> & DocumentData & { _id?: string }`. A row's `_id` now passes straight to `get`, `update`, `replace` and `delete`, with dot access (`row._id`), on an unconfigured collection too.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before: `_id` typed as DocumentValue on an unconfigured collection
for (const row of await notes.all()) await notes.delete(String(row["_id"]));
// after: `_id` is a string
for (const row of await notes.all()) await notes.delete(row._id);

// before: a non-string `_id` compiled, then threw InvalidConfig at runtime
await notes.insert({ _id: 42, title: "x" });
// after: it is a compile error; pass a string, or omit `_id` to have one minted
await notes.insert({ _id: String(42), title: "x" });

// before: a cast to a row shape without `_id`
const rows = (await notes.all()) as Array<{ title: string }>;
// after: include `_id` in the asserted shape (or bind a config with a schema)
const rows = (await notes.all()) as Array<{ _id: string; title: string }>;
```

A hand-written fake or mock of `Collection<T>` / `ClientCollection<T>` whose row type lacks `_id` no longer compiles: `const fakeAll: Collection<Note>["all"] = async () => [] as Note[]` is TS2322. Add `_id: string` to the row type.

Code that narrowed `_id` with `String(row._id)` or `row._id as string` keeps compiling. Row types that already declare `_id: string` are unaffected. Code that relied on a non-string `_id` type now gets a compile error.
