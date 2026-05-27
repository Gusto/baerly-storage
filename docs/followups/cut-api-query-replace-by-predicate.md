# Cut `Query<T>.replace(doc)` (predicate-aware single-row replace)

**Severity: HIGH. Pre-launch cut. Pure redundant ceremony to
`Table<T>.replace(id, doc)` — ADR-002 violation.**

`Query<T>.replace(doc)` is a bulk-mutation-shaped verb that throws
`Conflict` if the predicate doesn't match exactly one row. Documented
as "intentionally narrow."

- `/Users/eric.baer/workspace/baerly-storage/packages/protocol/src/table-api.ts:462`
  (wire contract)
- `/Users/eric.baer/workspace/baerly-storage/packages/server/src/query.ts:597-638`
  (impl)
- `/Users/eric.baer/workspace/baerly-storage/tests/fixtures/table-api-cascade.ts:306,312,319`
  (only sub-tests using it; they exist to test the verb itself)

## The case for cutting

Thesis §4: "the kernel ships two type-valid paths for the same
operation … the fix is making one of the paths not type-check."

`Table<T>.replace(id, doc)` is the by-id canonical form. The
predicate-aware version (`Query<T>.replace(doc)`) only accepts
predicates with cardinality exactly 1 — so the kernel knows this
is single-row work. The verb is just an awkward by-predicate
spelling of by-id replace.

This is the exact pattern the recent get-by-id-split-enforcement
work corrected on the read path (see memory entry
`get-by-id-split-enforcement shipped`): `_id` excluded from
`Path<T>` to forbid `where({ _id }).first()` and force `Table<T>.byId`.
The write path needs the same enforcement.

`Query<T>.replace(doc)` also pairs poorly with `Query<T>.update(patch)`
and `Query<T>.delete()`, which *are* genuinely bulk. Three sibling
verbs where two are bulk and one is "bulk-shape but cardinality=1"
teaches the agent that bulk-and-not-bulk are siblings — the wrong
mental model.

The only callsites are `table-api-cascade.ts` sub-tests written to
prove the verb works.

## What to do

1. Remove `replace(doc)` from `Query<T>` in
   `packages/protocol/src/table-api.ts`.
2. Remove the impl in `packages/server/src/query.ts`.
3. Delete the corresponding `table-api-cascade.ts` sub-tests.
4. Audit JSDoc `@example` blocks for any reference. The router
   must keep handling the wire `PUT /:id` for `Table<T>.replace` —
   that surface is fine.
5. Update `packages/server/API.md`.

## What gets harder after

- A user who wants "replace the one row matching this predicate"
  has to first find its id. **Acceptable** — `const { _id } =
  await table.where(...).first(); await table.replace(_id, doc);`
  is the explicit two-step. Cheap. Clear.

## Related cuts

- This is one of three ADR-002 violations in the audit. Pairs with
  `cut-api-db-create-overrides.md` (schemas/indexes override) and
  `cut-client-options-redundant-paths.md` (lifecycleSignal +
  headers callback). All three should land together so ADR-002
  rereads coherently.
