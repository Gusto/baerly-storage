# `ClientTable` / `ClientQuery` duplicate `Table<T>` / `Query<T>`

**Severity: MEDIUM. Pure DX/maintainability concern; no runtime
bug. Couple to whichever direction the public-surface decision in
A1 (`unify-baerly-storage.md`) lands.**

`packages/client/src/client.ts:110-124` re-declares the same
fluent shape that `packages/protocol/src/db.ts` already provides
for `Table<T>` / `Query<T>` — method-by-method, identical JSDoc:

- `where(predicate: Predicate<T>): ClientQuery<T>`
- `order(spec: OrderSpec<T>): ClientQuery<T>`
- `limit(n: number): ClientQuery<T>`
- `consistency(level: ConsistencyLevel): ClientQuery<T>`
- `insert(...)`, `count()`, etc.

The duplication is so load-bearing that
`packages/client/src/client.test.ts:192-198` ships a
`_ShapeParityProbe` type-check whose only job is to fail the
build if `ClientTable` ever stops being a structural superset of
`Table`. It's a compile-time assertion that the two types must
stay in sync — without an actual mechanism for keeping them in
sync.

## Why the duplication exists today

Likely historical: the protocol kernel's `Table<T>` was originally
server-only and the client wanted its own DX surface. Once the
shapes converged (which the parity probe enforces), the
duplication became dead weight.

## Fix — pick after A1 lands

The right answer depends on the package-surface decision raised
in `unify-baerly-storage.md` (A1):

### If A1 lands "publish `@baerly/*` scope"

Re-export `Table<T>` / `Query<T>` from `@baerly/protocol` directly
in `@baerly/client/index.ts`:

```ts
export type { Table, Query, Predicate, OrderSpec } from "@baerly/protocol";
```

Drop `ClientTable` and `ClientQuery` exports. Keep
`makeClientTable` / `makeClientQuery` as internal factories that
return values *typed* as `Table<T>` / `Query<T>`. The
`_ShapeParityProbe` becomes redundant (one type instead of two)
— delete it.

### If A1 lands "consolidate to `baerly-storage` only"

Same end state, different import path:

```ts
export type { Table, Query, Predicate, OrderSpec } from "baerly-storage";
```

…with the same internal factory + delete the probe.

## Sequencing

The wire-bug fixes (`.order()` threaded through, PUT for
`.replace()`, `/v1/count` route) have already shipped on local
main — that work landed in tip ahead of this one. Folding
`ClientTable` into `Table<T>` is now purely a type-hierarchy
cleanup: the public-method shape is settled.

But: don't sequence this *before* A1. Folding the shape into
`Table<T>` while the package-name schism is unresolved freezes an
incomplete surface into the type hierarchy. A1 first, this second.

## Verify after fix

- `_ShapeParityProbe` deleted; build still passes.
- `examples/helpdesk-cloudflare/src/web/client.ts` and the other
  example imports continue to compile without explicit
  `ClientTable`/`ClientQuery` imports.
- `packages/client/src/client.ts` shrinks by the ~14 duplicated
  method declarations.
