# Client terminals silently lie: `.order()`, `.replace()`, `.count()`

**Severity: HIGH. These are the worst class of API bug — typed
fluent methods that compile, run, and silently produce the wrong
result. A scaffolded user has no signal anything is wrong.**

Three independent bugs in the same shape: the client surface
exposes a method whose contract the wire can't honor.

## 1. `.order()` is dead on the wire

`packages/client/src/client.ts:349-353` defines `order()` on
`ClientQuery`; it updates `state.order`. Then
`packages/client/src/client.ts:314-326`'s `listParams()` never
serializes `state.order` to query params, and the server's GET
list handler (`packages/server/src/http/router.ts:134-138`)
hard-codes `order: undefined` when calling `runAllWithMeta`.

So:

```ts
client.table("tickets")
  .order({ created_at: "desc" })
  .all();
```

…returns rows in *whatever order the snapshot/log walk produces* —
which is stable but unrelated to `created_at`. The agent gets
plausible output and ships.

## 2. `.replace()` is JSON-merge-patch — same as `.update()`

`client.ts:403-420`'s `replace()` and `client.ts:387-400`'s
`update()` both send `PATCH /v1/t/:table/:id` with a `{ patch }`
body. The server has one PATCH route
(`router.ts:164-184`); no PUT route exists.

The replace JSDoc (`client.ts:411-413`) admits: "PATCH with a
full document body behaves as a replace under RFC 7386 merge-
patch (every field present overwrites)." But merge-patch
*preserves* keys absent from the patch. A user calling
`replace(newDoc)` to **clear a field** gets the old field
silently retained.

## 3. `.count()` downloads every row

`client.ts:375-385`'s `count()` calls `listPath()` (the GET list
endpoint) and returns `data.length`. No dedicated `/v1/count`
route exists in `packages/server/src/http/`. And `listParams()`
doesn't set a default `limit` — so `count()` on a 10M-row table
fetches all 10M rows into a JS array, takes `.length`, and throws
the array away.

The agent calls `client.table("tickets").count()` to render
"showing 12 of N" and silently burns megabytes of egress.

## Why bundle these

All three are the same defect class: typed client surface, server
can't satisfy it. The decision is uniform — for each method:

**Either**

- Add the missing server capability (real order serialization,
  real PUT route, real `/v1/count` route)

**Or**

- Remove the method from the client surface until the server side
  lands

Shipping methods that silently mis-execute is the worst outcome.

## Recommended cuts

| Method | Recommendation | Reason |
|---|---|---|
| `.order()` | **Add to wire.** `runAllWithMeta` already accepts `order`. Thread through `listParams` + router. Low cost, real value. |
| `.replace()` | **Delete until PUT lands.** A PUT route is a real protocol decision (overwrite semantics on a log-based store needs careful thought re: log entry type). Merge-patch-pretending-to-be-replace is worse than no method. |
| `.count()` | **Add `/v1/count` route.** Walk the snapshot + log without materialising bodies; return scalar. Or — narrower — accept a `limit` parameter and document "this is best-effort up to `limit`." Either beats silently downloading everything. |

## Cross-references

- The `_ShapeParityProbe` in `packages/client/src/client.test.ts:192-199`
  pins `ClientTable` as a structural superset of `Table` — so if
  any method is removed from `Table` (or server-side), the probe
  flags it. Keep the probe.
- Finding E4 (analyst's: "fold `ClientTable` into `Table<T>`
  directly") is a related design question. Worth revisiting *after*
  the three methods above are decided — folding before the wire
  decisions land would freeze an incomplete shape into the type
  hierarchy.
- E18 (`delete-404-code-mismatch.md`) is a sibling bug in the same
  file — fix in the same review session.

## Verify after fix

- Set up a smoke test for each: insert rows, call the method,
  assert the wire effect matches the typed promise.
- Add a regression test for the `_ShapeParityProbe` to fail
  loudly when a server-side cap is removed before the client
  method is.
