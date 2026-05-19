# Client React hooks: state-shape correctness

**Severity: MEDIUM. Four related defects in the hooks' result
shapes and lifecycle. All ship today; all are agent-trap-shaped.
Bundle together — they touch the same files and the same
test cases will fall out.**

## 1. `useLiveDocument` conflates "loading" and "missing"

`packages/client/src/use-live-document.ts:14-19` returns:

```ts
{ row: T | undefined, loading: boolean, error: Error | undefined }
```

After the first read returns `[]` (no document with this id),
`row === undefined` and `loading === false`. The "loading first
time" state has the same `row` value. So:

```tsx
const { row } = useLiveDocument(client, "tickets", id);
if (!row) return <NotFound />;
```

…renders `<NotFound />` during the brief loading window. The
JSDoc admits the conflation but pushes disambiguation onto the
consumer.

**Fix:** Promote the discriminator to a `status` enum:

```ts
type LiveDocResult<T> =
  | { status: "loading" }
  | { status: "ok"; row: T }
  | { status: "missing" }
  | { status: "error"; error: Error };
```

Or, less invasive: add `notFound: boolean` alongside `loading`.
The enum form is more honest about the four-way state.

## 2. Boolean-state naming inconsistency across hooks

Three hooks, three different "in-flight" field names:

| Hook | Field |
|---|---|
| `useChanges` | `polling: boolean` |
| `useLiveQuery` | `loading: boolean` |
| `useLiveDocument` | `loading: boolean` |

React 19 + TanStack Query settled on `isPending` for in-flight
mutations and `isLoading` for initial fetches. The codebase
uses neither convention; instead splits between `polling` and
`loading` for the same conceptual state.

**Fix (coupled with item 3 below):** Drop `polling` from
`useChanges` entirely (item 3). Standardise the remaining two on
`isPending` if we converge on React 19 conventions, or `isLoading`
if we want the more conservative name. Pick one; pin it in a
short style note in `packages/client/src/index.ts`'s JSDoc.

## 3. `polling` on `UseChangesResult` is unread and useless

`packages/client/src/use-changes.ts:25` exposes `polling: boolean`.
`polling === true` for ~24 of every 25 seconds (long-poll
wall-clock). Grep finds zero consumers in `packages/client/src/`.

So the field:

- Is unread by the downstream hooks (`use-live-query.ts`,
  `use-live-document.ts`).
- Is useless as a UI spinner — it's true 96% of the time.
- Adds noise to the result shape every consumer has to ignore.

**Fix:** Drop `polling` from `UseChangesResult`. Drop `error`
too if a deeper audit confirms no consumer reads it. (Per
`use-changes-naming-and-contract.md` Option A, the whole
`useChanges` shape collapses into a `useInvalidationTick(): number`
— in which case both `polling` and `error` go in the same touch.)

## 4. `useLiveQuery` resets cursor when `enabled` flips on

`packages/client/src/use-live-query.ts:98` deps:

```ts
[client, table, predicateKey, cursor, enabled]
```

When the consumer toggles `enabled: false → true`, the effect
re-runs. `cursor` initializes (line 70) from the `since` prop —
default `""`. So flipping `enabled` back on replays history from
the beginning, refetching every event the hook has already seen.

**Fix:** Persist the cursor across `enabled` flips via a
`useRef`:

```ts
const cursorRef = useRef(since);
// inside effect:
const { cursor: newCursor, events } = useChanges(client, table, {
  since: cursorRef.current,
  enabled,
});
cursorRef.current = newCursor;
```

…and drop `cursor` from the effect's deps array (only re-run
when client / table / predicate / enabled change, not when the
cursor advances).

Either fix or document the replay behaviour explicitly in the
hook JSDoc. The current shape silently makes "disable for a
second, re-enable" a moderately expensive operation.

## Why bundle these

All four touch `packages/client/src/use-live-{query,document}.ts`
and `packages/client/src/use-changes.ts`. Same review session,
same set of tests to update.

## Cross-references

- `use-changes-naming-and-contract.md` (Batch 3) — items 2 and 3
  may collapse if Option A there lands.
- `client-abort-signal-threading.md` (Batch 3) — rewriting the
  effects in those hooks for `AbortController` is the natural place
  to also fix items 1 and 4.
