---
"@gusto/baerly-storage": minor
---

Fix `Path<T>` walking `Array.prototype` for optional array fields; export
`PredicateArg` / `Predicate` / `Collection`

**Bug fix — optional array fields no longer poison predicate types**

`Path<T>` is the dotted-path key type behind `Predicate<T>` and `.where(...)`.
For an optional array field, it wrongly recursed into `Array.prototype` and
synthesized bogus keys.

A field `tags?: string[]` has the type `string[] | undefined`. The `undefined`
arm defeated the "an array is a leaf" check, so the path walker descended into
the array's methods and produced keys like `` `tags.map.${string}` `` typed
`undefined`. Required arrays (`tags: string[]`) were fine; only the optional
form triggered it.

Symptom: declaring *any* collection with an optional array field (for example a
Zod `z.array(z.string()).optional()`) broke assignability of a bound
`Db<Config>` or `BaerlyClient<Config>` to a hand-rolled interface whose
`collection(name: string)` takes a runtime string. Such an interface forces the
row type to collapse to the union of every collection's row; the stray
`undefined`-typed prototype path then made the resulting index-signature
predicate object non-assignable. Collections that never touched the array field
broke too.

The fix runs the leaf test on `NonNullable<T[K]>`, so an optional array ends
path recursion exactly like a required one. `Path<{ tags?: string[] }>` is now
`"tags"`, with no `Array.prototype` members.

**New public exports**

- `PredicateArg` and `Predicate` are now exported from `@gusto/baerly-storage`.
- `PredicateArg` is now exported from `@gusto/baerly-storage/client` (which
  already exported `ClientCollection` and `Predicate`).

The client handle type stays `ClientCollection`. The in-process `Collection`
type is exported only from the root `@gusto/baerly-storage` entry, because the
client's HTTP handle is structurally distinct (read-only `.where(...)`,
`TerminalOptions`).

These exports let you name the `.where(...)` argument and predicate types
directly, instead of hand-rolling a structural interface to accept a `Db` or a
`BaerlyClient`.

**Migration**

No action required. Both changes are additive; existing typed call sites are
unaffected.

If you hand-rolled a structural `collection(name: string)` shim to read
collections by a runtime-computed name, you can now either import the real types
or narrow at the boundary to open the row to `DocumentData` for dynamic names:

```ts
(db as Db<UnboundConfig>).collection(name)
```
