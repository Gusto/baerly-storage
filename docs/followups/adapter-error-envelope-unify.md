# Adapters ship divergent 500 envelopes for the same `BaerlyError`

**Severity: MEDIUM. Real cross-adapter behaviour divergence. A
user comparing Cloudflare and Node error envelopes side-by-side
will see different bytes for the same thrown server error — and
will rightfully ask which one is canonical.**

## What diverges

`packages/adapter-cloudflare/src/worker.ts:316` and the
verifier-null branch of the same file inline
`errorEnvelope(...)` / `flushUnauthorizedAndRespond(obsCtx, req)`
for envelope construction.

`packages/adapter-node/src/server.ts:273-280` runs caught
exceptions through `mapError(err)` and writes
`JSON.stringify(envelope)` to the response.

Two paths, two envelope shapes:

- **CF** wires observability context into the envelope (the
  `obsCtx` it carries through `flushUnauthorizedAndRespond`).
- **Node** uses `mapError` directly and emits the pure
  `BaerlyError`-shape envelope without observability decoration.

For a real-world example: throw the same `BaerlyError("Internal",
"boom")` from inside a route handler in both adapters. The two
500 responses won't be byte-identical. A user writing a uniform
client-side error renderer has to handle two shapes.

## Why this matters now

Today there are no external users, so the divergence is
recoverable. Once a third-party client library or app pins
expectations to one adapter's envelope shape, the other adapter's
divergence becomes a breaking-change blocker.

## Fix

Use `mapError` consistently in both adapters' top-level catch:

1. In `packages/adapter-cloudflare/src/worker.ts`, route both the
   verifier-null branch and the catch arm through `mapError(err)`
   plus a single envelope-write helper.
2. Decide whether observability context belongs *inside* the
   envelope or *alongside* it (as a separate header / log line).
   The current CF behaviour bundles them; the Node behaviour
   keeps them separate. Pick one — the cleaner choice is
   "envelope is pure error data; observability is a log
   concern" (i.e., adopt Node's shape on CF too).

The `mapError` function lives in the server kernel
(`packages/server/src/http/`); it already handles the
`BaerlyError` → `{ code, message, ... }` mapping. The unifying
move is to *call it* from CF.

## Regression test

Add a single test that asserts byte-identical 500 envelopes for
the same thrown `BaerlyError` across both adapters:

```ts
test("CF and Node return byte-identical 500 for the same BaerlyError", async () => {
  const err = new BaerlyError("Internal", "boom");
  const cfRes = await runCFRoute(() => { throw err });
  const nodeRes = await runNodeRoute(() => { throw err });
  expect(await cfRes.text()).toBe(await nodeRes.text());
});
```

The test fails today; it passes after the fix; it stays as a gate
on future divergence.

## Cross-references

- `client-delete-404-code-mismatch.md` is a sibling
  envelope-confusion bug on the client side. Once both adapters
  emit a clean `code === "NotFound"` for missing-doc deletes, the
  client's DELETE-404 catch arm becomes correct without further
  changes.
- `mapError` cleanup may want to live in
  `@baerly/server/http/error-envelope` (or wherever the existing
  helper sits) — coordinate with any A4 barrel-trim work.
