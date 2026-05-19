# Baerly Helpdesk — example app

A working CRUD helpdesk over baerly-storage. Single Vite process:

- The React app (under `src/`) renders the ticket list and detail
  views. The root is wrapped in `<BaerlyProvider>`; edits from one
  browser tab appear in others over the `/v1/since` long-poll,
  surfaced through the `useLiveQuery` / `useLiveDocument` React
  hooks.
- The Baerly HTTP listener is mounted as Vite middleware via
  `baerlyDev()` from `baerly-storage/dev/vite`, so the app and `/v1/*` API
  share an origin (`:5173`) and a single process.

## Quick start (60 seconds)

```sh
cd examples/helpdesk
pnpm install
pnpm dev
```

Then open <http://localhost:5173>. Five demo tickets are seeded on
first run — `pnpm seed` re-runs the seed against the existing
`.baerly-data/` (the plugin also seeds on every dev start), and
`pnpm reset` wipes the data dir so the next `dev` re-seeds from
scratch.

Open a second tab; edit a ticket in tab 1; watch tab 2 update.

## The interesting parts

Open `vite.config.ts` — the whole dev backend is one plugin call:

```ts
// vite.config.ts
import { baerlyDev } from "baerly-storage/dev/vite";
import { seedTickets } from "./src/server/seed.ts";

export default defineConfig({
  plugins: [
    react(),
    baerlyDev({
      app: "helpdesk",
      tenant: "helpdesk-demo",
      secret: process.env.HELPDESK_SECRET ?? "dev-helpdesk-secret",
      dataDir: resolve(import.meta.dirname, ".baerly-data"),
      tables: ["tickets"],
      seed: seedTickets,
    }),
  ],
  server: { port: 5173 },
});
```

`baerlyDev` (from `baerly-storage/dev/vite`) constructs `LocalFsStorage`, runs
`ensureTable` for each declared table, optionally seeds, and mounts
`createListener` as Vite middleware ahead of the SPA fallback. App
plus `/v1/*` API share one origin, one process — no proxy, no
separate server boot.

Wrap the app once at the root — every Baerly hook reads the client
from this context:

```tsx
// src/App.tsx
<BaerlyProvider client={client}>
  <App />
</BaerlyProvider>
```

Reads are declarative — `useLiveQuery` re-runs `.where(...).all()`
whenever the server emits log events for the table, and is a no-op
on idle long-poll cycles:

```tsx
// src/TicketList.tsx
const result = useLiveQuery<Ticket>({
  table: "tickets",
  where: filter === "all" ? {} : { status: filter },
});
if (result.status === "loading") return <p>Loading…</p>;
if (result.status === "error") return <p>Error: {result.error.message}</p>;
return <ul>{result.rows.map((t) => <li key={t._id}>{t.title}</li>)}</ul>;
```

For a single document, `useLiveDocument` does the same with `.first()`
and only refetches when an event touches *that* row:

```tsx
// src/TicketDetail.tsx
const result = useLiveDocument<Ticket>({ table: "tickets", id });
if (result.status === "loading") return <p>Loading…</p>;
if (result.status === "missing") return <p>Not found.</p>;
if (result.status === "error") return <p>Error: {result.error.message}</p>;
return <h2>{result.row.title}</h2>;
```

Mutations get matching hooks (`useInsert`, `useUpdate`, `useReplace`,
`useDelete`) — each exposes `mutate`, `isPending`, `error`, `reset`,
and aborts its in-flight call on a fresh `mutate()` or on unmount:

```tsx
// src/TicketForm.tsx
const { mutate: addTicket, isPending, error } = useInsert<Ticket>({ table: "tickets" });

<form onSubmit={async (e) => { e.preventDefault(); await addTicket(draft); onDone(); }}>
  <button disabled={isPending}>{isPending ? "Saving…" : "Create"}</button>
  {error && <p style={{ color: "crimson" }}>{error.message}</p>}
</form>
```

For one-shot imperative access (a custom export, a manual read inside
an event handler), drop down to the client directly via `useBaerlyClient`:

```ts
const client = useBaerlyClient();
const row = await client.table<Ticket>("tickets").where({ _id }).first();
```

## Bucket layout

Under `.baerly-data/`:

```
app/helpdesk/tenant/helpdesk-demo/manifests/tickets/
├── content/<sha256>.json   ← document bodies (content-addressed)
├── current.json            ← the CAS pointer
└── log/<seq>.json          ← per-mutation log entries
```

The same layout is what `S3HttpStorage` / `r2BindingStorage` lay down
in an S3 / R2 bucket. The data is yours; the format is mechanical.

## What's NOT here

- **No auth UI.** The example uses a hard-coded bearer token via
  `sharedSecret()`. Real apps swap it for `bearerJwt({ jwks })` or
  `cloudflareAccess({ teamDomain, audienceTag })` — both ship from
  `baerly-storage/auth`.
- **No multi-tenancy.** One tenant (`helpdesk-demo`), one bearer
  token. Production verifiers resolve `tenantPrefix` from the
  request's credentials.
- **No router.** Three views; one `useState` discriminated union.
  Bring your own router.
- **No data lib.** `baerly-storage/client` returns plain promises. Pair
  with TanStack Query / SWR in production.

## Cloudflare swap

For a deployable, R2-backed version of this same app — same React
UI, same `Ticket` schema, same long-poll live updates — see
`examples/helpdesk-cloudflare/` (a single Cloudflare Worker that
hosts both `/v1/*` and the built Vite bundle via Workers Assets).
Use `pnpm create baerly` to scaffold a production-shaped Worker
(`baerly-storage/cloudflare` + R2 bindings + `cloudflareAccess` /
`sharedSecret` verifier).

## Files to read

Start with `vite.config.ts` (the `baerlyDev()` middleware mount —
the entire dev backend in one plugin call), then `src/TicketList.tsx`
(the `useLiveQuery` live-updates hook). `types.ts`,
`src/server/seed.ts`, `src/client.ts`, and `smoke.test.ts` fill in
the rest.

## Troubleshooting

- **Port 5173 in use.** Override `server.port` in `vite.config.ts`,
  or run `PORT=5174 pnpm dev` if you've wired the env through.
- **"current.json missing".** Stop `pnpm dev`, `pnpm reset`, then
  re-run `pnpm dev`.
