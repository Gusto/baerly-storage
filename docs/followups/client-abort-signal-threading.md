# Client terminals don't accept per-call `AbortSignal`

**Severity: HIGH. React hooks have to fall back to a
`cancelled` boolean to avoid stale-state-after-unmount; effect
cleanup can't actually cancel the in-flight HTTP request.**

`first` / `all` / `count` / `insert` / `update` / `replace` /
`delete` take no options bag in
`packages/client/src/client.ts:140-151`. Only `since()` (line
200) and `healthz()` (lines 241-246) accept `{ signal?:
AbortSignal }`.

So the React hooks pay tax:

- `packages/client/src/use-live-query.ts:74` — `let cancelled =
  false; ...; if (!cancelled) setState(...)`.
- `packages/client/src/use-live-document.ts:76` — same pattern.

This is the established React idiom *only* when the underlying
API doesn't support cancellation. The flag prevents
`setState`-after-unmount warnings but **doesn't cancel the
fetch**. The browser/runtime keeps pulling bytes, the response
JSON is parsed, and the result is discarded.

For the canonical use case ("cancel this specific list when the
predicate changes"), the user has no escape hatch. Their only
options:

- A client-wide `signal` on construction (`BaerlyClientOptions.signal`,
  per `packages/client/src/client.ts:128`) — but that cancels
  *every* in-flight request, not the one they want.
- Manually rewrap with their own `fetch` wrapper. Defeats the
  point of the typed client.

## Fix

Add `{ signal?: AbortSignal }` as an optional last argument on
every terminal:

```ts
// before
first(): Promise<T | undefined>
all():   Promise<T[]>
count(): Promise<number>
insert(doc: T):                            Promise<T>
update(id: string, patch: Partial<T>):     Promise<T>
replace(id: string, doc: T):               Promise<T>
delete(id: string):                        Promise<{ deleted: 0 | 1 }>

// after
first(opts?:                                 { signal?: AbortSignal }): Promise<T | undefined>
all(opts?:                                   { signal?: AbortSignal }): Promise<T[]>
count(opts?:                                 { signal?: AbortSignal }): Promise<number>
insert(doc: T,           opts?:              { signal?: AbortSignal }): Promise<T>
update(id: string,       patch: Partial<T>,  opts?: { signal?: AbortSignal }): Promise<T>
replace(id: string,      doc: T,             opts?: { signal?: AbortSignal }): Promise<T>
delete(id: string,       opts?:              { signal?: AbortSignal }): Promise<{ deleted: 0 | 1 }>
```

The request layer (`packages/client/src/client.ts`'s
`request`/`fetch` helper) already passes a `signal` to the
underlying `fetch()` for `since` and `healthz` — extend the same
plumbing.

## Then: rewrite the hooks

`use-live-query.ts` and `use-live-document.ts` drop the `cancelled`
boolean and use an `AbortController` per effect run:

```ts
useEffect(() => {
  const controller = new AbortController();
  (async () => {
    try {
      const rows = await client.table(table).where(predicate).all({ signal: controller.signal });
      setState({ rows, loading: false });
    } catch (err) {
      if (err.name !== "AbortError") setState({ error: err, loading: false });
    }
  })();
  return () => controller.abort();
}, [client, table, predicateKey]);
```

Cancels the in-flight HTTP request on effect cleanup. No
stale-state-after-unmount. No wasted bytes.

## Verify after fix

- Add a test: spawn 10 sequential `.all()` calls with a single
  `AbortController` that aborts mid-flight. Assert each
  intermediate call rejects with `AbortError` *and* that the
  underlying fetch was actually aborted (e.g. via a request
  counter on a mock fetch).
- The React hooks should pass an existing "rapid predicate-change"
  test without flaking, with `AbortError` rejections silenced.

## Cross-references

- E16 (analyst's): `healthz()` swallows `AbortError` as `false` —
  related sloppy error-handling around aborts. Pick up in the same
  review session.
- E17 (analyst's): `BaerlyClientOptions.signal` is named as if
  per-request but is constructor-scoped. Rename to
  `lifecycleSignal` when the per-call signals land — the two
  signals serve different purposes and the naming should reflect
  that.
