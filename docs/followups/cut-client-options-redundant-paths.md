# Cut `BaerlyClientOptions.lifecycleSignal` and async `headers` callback

**Severity: MEDIUM. Pre-launch cut. Two redundant-ceremony options
on `BaerlyClient` — ADR-002 violation.**

Both options have a single canonical alternative already on the
type. Keeping them means two type-valid paths for the same
capability.

- `/Users/eric.baer/workspace/baerly-storage/packages/client/src/client.ts:104`
  (`lifecycleSignal` decl)
- `/Users/eric.baer/workspace/baerly-storage/packages/client/src/client.ts:286-298`
  (lifecycleSignal wiring)
- `/Users/eric.baer/workspace/baerly-storage/packages/client/src/client.ts:82-85`
  (`headers` async-callback union)

## The case for cutting

### `lifecycleSignal`

Every terminal already takes a per-call `{ signal }`
(`TerminalOptions`). `BaerlyProvider` lives for the lifetime of
the app; no LLM-authored prototype tears down a client and needs
to mass-cancel inflight requests. Two type-valid paths for abort:
per-call signal vs. lifecycle signal.

The deferred changes-iterator memo's §4 lens applies: "escape
hatches for power users via lower-level primitives." If a
sophisticated cancellation case ever materializes, it belongs
in the `fetch` option's interceptor seam — not on the public
options shape.

### `headers` async-callback form

`headers` accepts `Headers | Record<string,string> | (() =>
Promise<...>)`. The async-function form is for "resolve the header
per-call (e.g. fresh JWT from an IdP)."

Per-call async JWT refresh is production ceremony — short-lived
tokens, IdP rotation, OAuth refresh-token loops. The audience
("$20/mo ChatGPT subscriber with a dream") ships
`Authorization: Bearer <static-shared-secret>` and rotates by
re-deploying.

The `fetch` option already covers the sophisticated case — one
of its own `@example` blocks is literally `withRetry(withLogging)`.
Three type-valid paths for "rotate auth" (static record, async
function, fetch interceptor) → keep static; drop the async
form.

## What to do

1. Remove `lifecycleSignal` from `BaerlyClientOptions` + wiring.
2. Narrow `headers` to `Headers | Record<string, string>` — drop
   the async-function form.
3. Update JSDoc `@example` blocks for both.
4. Audit `BaerlyProvider` / React wrappers for any consumer of
   `lifecycleSignal`. The Provider already owns its own cleanup
   surface; no change needed beyond removing the option.

## What gets harder after

- A user with a real fresh-JWT-per-call need writes a `fetch`
  interceptor. **Acceptable** — the interceptor is the canonical
  seam.
- A user mass-cancelling inflight requests writes one
  `AbortController` and threads it. **Acceptable** — same shape
  the kernel already uses everywhere else.

## Related cuts

- One of three ADR-002 violations in the audit. Pairs with
  `cut-api-db-create-overrides.md` and
  `cut-api-query-replace-by-predicate.md`.
