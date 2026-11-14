---
"@gusto/baerly-storage": minor
---

**Breaking:** `ensureTable` (from `@gusto/baerly-storage/dev`) now takes the collection name under `collection`, matching `db.collection(name)` and the rest of the API. The old `table` key is gone, with no alias: passing `table` is a type error, and at runtime it is refused with `InvalidConfig` (the message names `collection`) before any write.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before
await ensureTable(storage, { app: "helpdesk", tenant: "demo", table: "tickets" });
// after
await ensureTable(storage, { app: "helpdesk", tenant: "demo", collection: "tickets" });
```

The `baerlyDev` Vite plugin's own pre-warm is updated; projects that only use the plugin need no change.
