# Baerly Helpdesk — example app

A working CRUD helpdesk over baerly-storage. Single Vite process:

- The React app (under `src/`) renders the ticket list and detail
  views. Edits from one browser tab appear in others over the
  `/v1/since` long-poll, surfaced through the `useLiveQuery` /
  `useLiveDocument` React hooks.
- The Baerly HTTP listener is mounted as Vite middleware via
  `baerlyDev()` from `@baerly/dev/vite`, so the app and `/v1/*` API
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
import { baerlyDev } from "@baerly/dev/vite";
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

`baerlyDev` (from `@baerly/dev`) constructs `LocalFsStorage`, runs
`ensureTable` for each declared table, optionally seeds, and mounts
`createListener` as Vite middleware ahead of the SPA fallback. App
plus `/v1/*` API share one origin, one process — no proxy, no
separate server boot.

Reads and writes look the same on the client and the server — the
client just sends them over HTTP:

```ts
// src/TicketForm.tsx (etc.)
await client.table<Ticket>("tickets").insert({ title, status, ... });
await client.table<Ticket>("tickets").where({ _id }).update({ status: "closed" });
await client.table<Ticket>("tickets").where({ status: "open" }).all();
```

Live updates are one hook — `useLiveQuery` re-runs `.where(...).all()`
whenever the server emits log events for the table, and is a no-op
on idle long-poll cycles:

```tsx
// src/TicketList.tsx
const { rows, loading, error } = useLiveQuery<Ticket>(
  client,
  "tickets",
  filter === "all" ? {} : { status: filter },
);
```

For a single document, `useLiveDocument` does the same with `.first()`
and only refetches when an event touches *that* row:

```tsx
// src/TicketDetail.tsx
const { row, loading, error } = useLiveDocument<Ticket>(client, "tickets", id);
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
  `@baerly/server/auth`.
- **No multi-tenancy.** One tenant (`helpdesk-demo`), one bearer
  token. Production verifiers resolve `tenantPrefix` from the
  request's credentials.
- **No router.** Three views; one `useState` discriminated union.
  Bring your own router.
- **No data lib.** `@baerly/client` returns plain promises. Pair
  with TanStack Query / SWR in production.

## Cloudflare swap

For a deployable, R2-backed version of this same app — same React
UI, same `Ticket` schema, same long-poll live updates — see
`examples/helpdesk-cloudflare/` (a single Cloudflare Worker that
hosts both `/v1/*` and the built Vite bundle via Workers Assets).
Use `pnpm create baerly` to scaffold a production-shaped Worker
(`@baerly/adapter-cloudflare` + R2 bindings + `cloudflareAccess` /
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
