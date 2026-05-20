# Adapter collections wiring (corrects A9)

**Status: pre-launch gap, not just polish.**

## The bug

`baerly.config.ts` lets you declare:

```ts
defineConfig({
  collections: {
    tickets: { schema: TicketSchema, indexes: [...] },
  },
});
```

Neither `baerlyWorker` (`packages/adapter-cloudflare/src/worker.ts`)
nor `baerlyNode` / `createListener` / `createFetchHandler`
(`packages/adapter-node/src/server.ts`) accepts `collections` or
the config. Both call `Db.create({ storage, app, tenant, metrics })`
with no `schemas` / `indexes` map passed. The day-1
`examples/helpdesk-cloudflare/baerly.config.ts` declares
`tickets: { schema: TicketSchema }` and `examples/helpdesk-cloudflare/src/server/index.ts`
never imports the config — so the declared schema **does not run**
on server-side commits.

Same hole exists for declared indexes: declaring them in
`baerly.config.ts` has zero effect through the adapter path.

## Why A9 mis-framed this

A9 (now-deleted `errors-and-types.md` §1) claimed adapters
"duplicate the flatten code" that turns `BaerlyConfig.collections`
into `schemas: Map` + `indexes: Map`. They don't — there is no
flatten code in either adapter. The real bug is the inverse:
**no path** from `baerly.config.ts` to `Db.create({ schemas,
indexes })` exists in the recommended (adapter) user flow.

## Proposed fix

Each adapter accepts the `BaerlyConfig` (or just its `collections`
field) and pipes it through to `Db.create`. Choice of shape:

1. **Adapters accept `config: BaerlyConfig`.** Internally flatten
   `collections[*].schema` / `collections[*].indexes` into the maps
   `Db.create` consumes today. Most ergonomic — user passes the
   value `defineConfig` returned. Keeps `Db.create`'s map-based
   internals untouched.
2. **Adapters accept `collections: BaerlyConfig["collections"]`
   directly.** Slightly less ergonomic but avoids forcing
   `BaerlyConfig`'s other fields (`app`, `tenant`, `target`,
   `domain`) into the adapter contract (which today own these
   separately).
3. **Refactor `Db.create` to accept `collections` directly + adapters
   pipe through.** Single shape end-to-end, but churns ~20 test
   sites that pass `schemas: Map` / `indexes: Map` today.

(1) is least disruptive and matches what an app author would expect.
(3) is design-purist but the adapter wiring is the user-visible win;
the internal `Db.create` shape change can come later or never.

## Verify before fixing

- Audit the helpdesk-cloudflare example's runtime behavior: write
  an invalid ticket via the HTTP API and confirm the server accepts
  it today (schema doesn't fire). That's the failing test the fix
  should pass.
- Same exercise for index emission: declare `indexes:
  [{ name: "by_status", on: "status" }]` in
  `baerly.config.ts`, do a few inserts, and check whether the index
  prefix appears in the bucket. Today it should not.

## Scope

Pre-launch. The publish surface advertises declared schemas and
indexes as core features; both are silently disabled through the
recommended adapter path. Either fix or remove from the public
surface before publishing.
