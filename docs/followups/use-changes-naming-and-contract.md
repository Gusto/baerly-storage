# `useChanges` exposes the wrong semantics for its name

**Severity: MEDIUM-to-HIGH. Discoverability footgun. Agents and
users alike read "useChanges" and assume it accumulates change
events; the actual contract is "latest non-empty batch only," and
the JSDoc has to spell out a workaround.**

`packages/client/src/use-changes.ts:30-47`'s JSDoc:

> "Each render sees the latest non-empty batch only. This hook
> does NOT accumulate events across polls. If you need a running
> log of all events, fold them yourself via `useReducer`."

So the hook is named like a change *stream* but behaves like an
edge-trigger that overwrites itself. Two real consequences:

## Existing consumers want a different thing

Both downstream React hooks use `useChanges` for one purpose: a
"tick when a refetch is warranted" signal.

- `packages/client/src/use-live-query.ts:58` reads only the
  `cursor` field from the `useChanges` result — to detect "log
  advanced; re-run the query."
- `packages/client/src/use-live-document.ts:53-68` reads `events`
  but only via `findLast` to detect "did *my* doc-id appear?" —
  never processes the events as a sequence.

Neither needs raw event batches. They need a monotonic tick.

## `polling` and `error` fields on `UseChangesResult` are unread

`use-changes.ts:19-28` exposes a `UseChangesResult` with at least
`polling` and `error` fields. Neither consumer reads either field.
`polling` is `true` for ~24 of every 25 seconds (long-poll
wall-clock), so it's useless as a spinner signal anyway.

## Two coherent shapes; pick one

### Option A — Hide `useChanges`, expose `useInvalidationTick`

The current load-bearing contract is "tick when log advances."
Make that the public surface and hide raw events:

```ts
/** Returns a monotonic integer that increments when the
    cursor advances. Subscribe in your effect deps. */
function useInvalidationTick(
  client: BaerlyClient,
  table: string,
  predicate?: Predicate
): number
```

Implement on top of the current polling internals. `useLiveQuery`
/ `useLiveDocument` consume the tick directly. Drop the
`UseChangesResult` shape with `polling`/`error` cosmetic noise.

**Smallest surface. Honest naming.**

### Option B — Make `useChanges` accumulate, with explicit opt-out

If raw events are sometimes useful, make accumulation the default:

```ts
function useChanges(client, table, predicate?, opts?: {
  accumulate?: boolean;  // default true
  dedupBy?: "lsn" | "id";  // default "lsn"
}): { events: ChangeEvent[]; cursor: Cursor };
```

`accumulate: false` becomes the opt-in for the edge-trigger
behaviour that exists today.

**Larger surface. Preserves an escape hatch for users who really
want a change stream.**

## Recommendation

**Option A.** Today's consumers don't need raw events; the hook's
only real use case is invalidation. Naming it `useChanges` is
misleading and the JSDoc has to spend three sentences explaining
the gotcha. `useInvalidationTick` is what the hook *actually
does*; rename it and stop owning the conceptual debt.

If a real use case for raw events appears later (e.g. a feed UI
that wants to render `+3 new tickets`), revisit with Option B
then. Pre-launch, take the smaller surface.

## Cross-references

- E10/E11 (analyst's): "boolean-state naming inconsistency" and
  "polling/error from useChanges unused" — both subsumed by Option
  A (drop `polling`/`error` entirely, standardise on `isPending`).
- The `client-abort-signal-threading.md` rewrite of
  `use-live-query` / `use-live-document` is the natural place to
  switch from `useChanges` to `useInvalidationTick`.

## Verify after rename

- Update the example `examples/helpdesk/src/web/` (or whichever)
  to use the new name.
- The `_ShapeParityProbe` should fail if `useChanges` is exported
  without a corresponding `Changes`-shaped type — re-purpose to
  pin the new tick contract.
