---
"@gusto/baerly-storage": minor
---

Fix `Path<T>` walking `Array.prototype` for optional array fields; export
`PredicateArg` / `Predicate` / `Collection` for consumers

**Bug fix — optional array fields no longer poison predicate types**

`Path<T>` (the dotted-path key type behind `Predicate<T>` / `.where(...)`)
descended into `Array.prototype` when a field was an **optional** array. For a
field `tags?: string[]`, the field type is `string[] | undefined`, and the
`undefined` arm defeated the array-is-a-leaf check — so the path walker
recursed into the array's methods and synthesized bogus keys like
`` `tags.map.${string}` `` typed `undefined`.

Required array fields (`tags: string[]`) were unaffected; only the optional
form triggered it.

The visible symptom: registering **any** collection with an optional array
field (e.g. a Zod `z.array(z.string()).optional()`) broke structural
assignability of a bound `Db<Config>` / `BaerlyClient<Config>` to a hand-rolled
interface whose `collection(name: string)` takes a runtime string — because the
generic collapses the row to the union of every row, and the synthetic
`undefined`-typed prototype path made every index-signature predicate object
non-assignable. Collections that never touched the array field were still
affected.

The fix runs the leaf test on `NonNullable<T[K]>`, so an optional array
terminates path recursion exactly like a required one. `Path<{ tags?: string[]
}>` is now `"tags"`, with no `Array.prototype` members.

**New public exports**

- `PredicateArg` and `Predicate` are now exported from `@gusto/baerly-storage`.
- `PredicateArg` is now exported from `@gusto/baerly-storage/client` (which
  already exported `ClientCollection` and `Predicate`). The client handle type
  remains `ClientCollection`; the in-process `Collection` type is exported only
  from the root `@gusto/baerly-storage` entry, since the client's HTTP handle
  is structurally distinct (read-only `.where(...)`, `TerminalOptions`).

These let consumers name the `.where(...)` argument and predicate types
directly instead of hand-rolling a structural interface to accept a `Db` or a
`BaerlyClient`.

**Migration**

- No action required. Both changes are additive; existing typed call sites are
  unaffected.
- If you hand-rolled a structural `collection(name: string)` shim to read
  collections by a runtime-computed name, you can now either import the real
  types, or narrow at the boundary with
  `(db as Db<UnboundConfig>).collection(name)` to open the row to
  `DocumentData` for dynamic names.
