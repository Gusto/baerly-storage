---
"@gusto/baerly-storage": minor
---

An `update` patch can no longer change or remove a row's `_id`. A patch whose top-level `_id` is present and is not `===` the row's own `_id` (including `_id: null`, a number, or any other non-matching value) now throws `BaerlyError{code:"InvalidConfig"}` (HTTP 400 on `PATCH /v1/c/:collection/:id`) before that row is validated or committed. A patch that carries the row's own `_id`, or omits `_id`, or sets it to `undefined`, is accepted as before.

Previously such a patch silently corrupted data: `update("a", { _id: "b" })` re-keyed the stored post-image so that `get("a")` returned `{ _id: "b", … }` and a later update of `"a"` produced two rows that both carried `_id: "b"`; `update(id, { _id: null })` stripped `_id`, after which a predicate `delete()` reported `{ deleted: 1 }` but tombstoned the wrong key and left the row in place.

For a predicate update (`where(...).update(patch)`) the check runs per row, before that row commits, so rows earlier in the batch may already be applied when a later row rejects. Atomicity stays per row.

**Migration — agents: if you wrote the LEFT, use the RIGHT:**

```ts
// before: renaming a document by patching its _id (silently corrupted the row)
await db.collection("tickets").update("old-id", { _id: "new-id" });
// after: insert under the new id, then delete the old one
const row = await db.collection("tickets").get("old-id");
await db.collection("tickets").insert({ ...row!, _id: "new-id" });
await db.collection("tickets").delete("old-id");

// before: removing _id with a merge-patch null
await db.collection("tickets").update(id, { _id: null, status: "closed" });
// after: omit _id from the patch
await db.collection("tickets").update(id, { status: "closed" });
```

Every insert or update commit now also requires the post-image to be a plain object whose own `_id` is the string the row is stored under. The public `insert` and `replace` already force `_id`, so this only rejects post-images an update patch made inconsistent (for example a patch that is an array or a scalar, which replaces the whole document).

**Rows the old bug already corrupted.** A stored row whose `_id` is missing, not a string, or a different id from the one it is stored under now makes `update` and `delete` throw `BaerlyError{code:"InvalidResponse"}` (HTTP 502) instead of committing. Before, `update("a", …)` on a row re-keyed to `_id: "b"` wrote a second `_id: "b"` row, and `delete("a")` reported `{ deleted: 1 }` while the row survived. A predicate `update`/`delete` that matches such a row throws when it reaches it; rows earlier in the batch are already applied.

`replace(id, doc)` repairs the row, because it forces `_id` to `id`. After that, `update` and `delete` work on it again:

```ts
try {
  await db.collection("tickets").update(id, patch);
} catch (err) {
  if (err instanceof BaerlyError && err.code === "InvalidResponse") {
    // The row stored at `id` carries a corrupt `_id`: rewrite it under `id`.
    const { _id, ...fields } = (await db.collection("tickets").get(id))!;
    await db.collection("tickets").replace(id, { ...fields, _id: id });
    await db.collection("tickets").update(id, patch);
  } else {
    throw err;
  }
}
```

To remove a corrupt row instead, `replace` it first and then `delete(id)`.
