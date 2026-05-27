# Cut `consistency("eventual")` modifier

**Severity: MEDIUM. Pre-launch cut. Optional knob with zero
in-repo callers; leaks into wire-format docs the LLM must keep
in context.**

A read-consistency knob on `Table<T>` and `Query<T>` plus an
`?consistency=eventual` HTTP mirror. Zero non-test in-repo
callers; only example AGENTS.md docs reference it.

- `/Users/eric.baer/workspace/baerly-storage/packages/protocol/src/table-api.ts:346,386`
  (declarations on `Table<T>` and `Query<T>`)
- `/Users/eric.baer/workspace/baerly-storage/packages/server/src/query.ts:730-747`
  (impl)
- `/Users/eric.baer/workspace/baerly-storage/packages/server/src/query.ts:113-178`
  (the `currentJsonCache` slot threaded through `TableReadContext` —
  exists to make the `eventual` path's caching meaningful)

## The case for cutting

The knob pays for itself only when "one Class B op per read"
matters more than last-write-wins. That tradeoff is explicit
graduation-tier optimization — the workload-shape signal that
the M-size cost-model line cites as the reason to switch to D1
(`docs/about/cost-model.md` §"L workload").

Thesis criterion #4 (LLM-legible API): the surface should be the
smallest `.d.ts` an LLM can hold in context. An `eventual`
modifier on every read verb is JSDoc weight on every method that
no prototype-tier author will read past once.

The HTTP mirror (`?consistency=eventual`) leaks into wire-format
docs (the per-scaffold AGENTS.md "HTTP wire format" sections) —
multiplying the surface area the audience must understand to
write a curl request that works.

`strong` is the only path any prototype-tier author should be
on. The thesis explicitly commits to "Strong consistency under
contention" (architecture §) as the design center.

## What to do

1. Remove the `consistency` parameter from `Table<T>` and
   `Query<T>` methods in `packages/protocol/src/table-api.ts`.
2. Remove the impl branch in `packages/server/src/query.ts`.
3. Drop the `currentJsonCache` slot from `TableReadContext` —
   the only reason it exists is to make the `eventual` path's
   per-`Db` caching meaningful.
4. Remove `?consistency=eventual` handling from the HTTP router.
5. Update per-scaffold AGENTS.md to drop the consistency
   modifier from the wire-format docs.
6. Update `packages/server/API.md`.

## What gets harder after

- A user who wanted to save a `current.json` GET per read can't.
  **Acceptable** — they're at the workload ceiling; graduate.
- The per-`Db` cache machinery (now ~65 LoC of dead context
  threading) goes away. **Net win** — simpler `TableReadContext`.

## Notes

If a real audience consumer ever asks for it post-launch (cite
the deferred-spec memo's "If the question reopens" pattern), the
right shape is probably a per-`Db` flag, not a per-call modifier
— but defer until that signal exists.

## Related cuts

- **`docs-cost-model-trim.md`** — the M-size $/mo table cites
  `consistency("eventual")` as the optimization that closes the
  gap with D1. With the knob cut, that paragraph dies too.
