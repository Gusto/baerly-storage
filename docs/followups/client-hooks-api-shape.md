# Client React hooks: API call-shape decisions

**Severity: MEDIUM. Two design decisions about the React surface.
Not bugs — but pre-1.0 is the last chance to set this without
breaking users.**

## 1. Hooks take positional args; modern React conventions use options bags

Today:

```ts
useLiveQuery(client, table, predicate?, opts?)
useLiveDocument(client, table, id, opts?)
useChanges(client, table, opts?)
```

Four positional args, third optional, leaves call sites like:

```ts
useLiveQuery(client, "tickets", undefined, { enabled: isOpen });
```

…where `undefined` is load-bearing. TanStack Query, SWR, and
React 19 hooks settled on a single options-bag argument long
ago. A user porting from any of those gets a different shape
here for no benefit.

### Two coherent shapes

**Option A — pure options bag:**

```ts
useLiveQuery({ client, table, where?, enabled?, since? })
useLiveDocument({ client, table, id, enabled?, since? })
useChanges({ client, table, since?, enabled? })
```

**Option B — context-injected client + options bag** (TanStack
style):

```tsx
<BaerlyProvider client={client}>
  <App />
</BaerlyProvider>

// inside App:
useLiveQuery({ table: "tickets", where: { status: "open" } });
```

Every existing example imports `client` from a module-scoped
file (`examples/helpdesk/src/web/client.ts` etc.) — so adopting
Option B requires updating the example wiring once, then the
DX is significantly better at every call site.

### Recommendation

**Option B.** The provider pattern is what React users expect for
a data layer; passing `client` through every hook is the older
ergonomic. The provider takes ~10 lines to write and ships
better DX forever.

If Option B feels like too much surface for day-1, ship Option A
first — that's a smaller diff that keeps the door open. But
commit *to one*; the current positional shape is the worst of
both worlds.

## 2. No `useInsert` / `useUpdate` / `useDelete` — examples model the wrong pattern

`packages/client/src/index.ts` exports no mutation hooks. The
examples reflect that gap:

```tsx
// examples/helpdesk/src/TicketDetail.tsx:45 (approx)
onClick={async () => {
  await client.table("tickets").where({ _id: id }).delete();
  // no in-flight state, no optimistic update, no error toast
}}
```

A user who's seen any React-data-layer library will assume the
right pattern is:

```tsx
const { mutate, isPending, error } = useDelete(...);
<button disabled={isPending} onClick={() => mutate(id)} />
```

…and reach for it. Today: no such hook exists. So the example
sets the wrong precedent and every consuming app rolls its own
mutation state.

### Fix — pick one

**Option A — ship a thin `useMutation`-style hook trio:**

```ts
function useInsert<T>(...): { mutate: (doc: T) => Promise<T>; isPending: boolean; error?: Error }
function useUpdate<T>(...): { mutate: (id: string, patch: Partial<T>) => Promise<T>; isPending: boolean; error?: Error }
function useDelete<T>(...): { mutate: (id: string) => Promise<{ deleted: 0 | 1 }>; isPending: boolean; error?: Error }
```

Plus the matching `client-terminals-silently-lie.md` wire-fix
for `.replace()` (or skip `useReplace` until the PUT route lands).

**Option B — commit to the imperative pattern in docs.**

Document explicitly: "Mutations are imperative. Track `isPending`
yourself with `useState`. We don't ship mutation hooks." Update
examples to demonstrate the canonical imperative shape (which
they currently don't — they're sloppy).

### Recommendation

**Option A.** The hook trio is ~60 lines total and dramatically
improves the DX of every mutation in user code. TanStack Query
chose this for good reasons.

If we don't ship them, *update the examples* — today they model
neither pattern well (the imperative call has no in-flight state
tracking at all).

## Why bundle these

Both items decide the shape of the React surface. They should
land in one design pass, with one set of example rewrites, so
the public API has internal consistency.

## Cross-references

- The provider pattern (Option 1B) is the natural place to also
  thread `client.subscribe()` so child hooks share a single
  poll-loop. Mention if/when consolidating WebSocket / SSE
  variants of the long-poll comes up.
- The mutation hooks ride on top of the `client-abort-signal-threading.md`
  signal work — give each `mutate` an `AbortController` per call
  so React can cancel via cleanup.
