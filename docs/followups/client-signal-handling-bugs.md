# Client signal handling: two correctness bugs

**Severity: MEDIUM. Two small bugs in how the client handles
`AbortSignal`. Same review session as the per-call signal
threading work in `client-abort-signal-threading.md`.**

## 1. `healthz()` swallows `AbortError` as `false`

`packages/client/src/client.ts:241-251`:

```ts
async healthz(opts?: { signal?: AbortSignal }): Promise<boolean> {
  try {
    // ...request...
    return true;
  } catch {
    return false;
  }
}
```

The bare `catch` swallows everything. If the caller passes a
`signal` that aborts mid-flight, the fetch throws `AbortError`
and `healthz()` returns `false`. From the caller's perspective
that's indistinguishable from "the server is down."

So a polling health check that cancels on unmount:

```ts
useEffect(() => {
  const ac = new AbortController();
  client.healthz({ signal: ac.signal }).then((ok) => {
    if (ok) setHealthy(true);
    else setHealthy(false);  // <- fires on unmount-cancel
  });
  return () => ac.abort();
}, []);
```

…sets `healthy = false` on every cleanup that fires during the
in-flight request. Looks like a flaky server. Is actually a
flaky catch.

**Fix:** Re-throw `AbortError`, only swallow real network /
HTTP errors:

```ts
async healthz(opts?: { signal?: AbortSignal }): Promise<boolean> {
  try {
    // ...request...
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    if (err instanceof Error && err.name === "AbortError") throw err;
    return false;
  }
}
```

`AbortError` becomes the caller's problem (correct — they
asked for it via the signal). Anything else maps to "server
down."

## 2. `BaerlyClientOptions.signal` is constructor-scoped but named per-request

`packages/client/src/client.ts:80`:

```ts
interface BaerlyClientOptions {
  // ...
  /** Merged into every request the client makes. */
  signal?: AbortSignal;
}
```

The field name `signal` and the type `AbortSignal` strongly
suggest "cancel this individual request." The JSDoc admits the
truth: it's actually a *lifecycle* signal — when the user
aborts it, every future request the client makes throws
`AbortError` immediately.

That's a useful pattern (a single React component owning a
provider can cancel everything on unmount), but the naming is
misleading. A user reading the type sig will think `signal` is
per-request and `client.healthz({ signal: requestSignal })`
overrides it.

In fact both signals fire — they're chained — so the existence
of the constructor signal isn't *broken*, just confusing.

**Fix:** Rename to `lifecycleSignal` (or `globalSignal`):

```ts
interface BaerlyClientOptions {
  /** Aborts every in-flight and future request when fired.
      Per-request signals on individual methods are merged
      with this one. */
  lifecycleSignal?: AbortSignal;
}
```

Pair with the per-call signal landing in
`client-abort-signal-threading.md`: once every terminal accepts
`{ signal }`, the two-signal story has to be coherent. The
constructor signal becomes a "global override"; the per-call
signal is "I want to cancel *this* request." Document the
chaining (e.g. via `AbortSignal.any([global, local])` if the
runtime supports it).

## Why bundle these

Both touch signal handling. Both are part of the larger
"AbortSignal end-to-end" story raised in
`client-abort-signal-threading.md`. Land the three in one
coordinated change; otherwise you ship two refactors and have
to retest the signal plumbing twice.

## Verify after fix

- Add a test: caller-supplied signal aborts mid-`healthz()`,
  promise rejects with `AbortError` instead of resolving to
  `false`.
- Rename in one commit. The IDE refactor lands the
  `BaerlyClientOptions.signal` change as a non-breaking
  internal rename (the field is published, but pre-launch no
  external user is consuming it yet).
