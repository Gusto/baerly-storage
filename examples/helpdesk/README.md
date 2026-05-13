# Baerly Helpdesk — example app

A working CRUD helpdesk over baerly-storage. Two workspaces:

- `apps/server` — Node HTTP listener over `LocalFsStorage`.
- `apps/web` — React + Vite. Talks to the server via `@baerly/client`.
  The ticket list and detail views are live: edits from one browser
  tab appear in others over the `/v1/since` long-poll, surfaced
  through the `useChanges` React hook.

## Quick start (60 seconds)

From the repo root:

```sh
pnpm install
pnpm --filter helpdesk dev
```

Then open <http://localhost:5173>. Five demo tickets are seeded on
first run — `pnpm --filter helpdesk reset` wipes the bucket so the
next `dev` re-seeds.

Open a second tab; edit a ticket in tab 1; watch tab 2 update.

## The interesting parts

The whole server boot is one file:

```ts
// apps/server/src/index.ts
import { createServer } from "node:http";
import { resolve } from "node:path";
import { createListener } from "@baerly/adapter-node";
import { sharedSecret } from "@baerly/server/auth";
import { LocalFsStorage, ensureTable } from "@baerly/dev";

const storage = new LocalFsStorage({
  root: resolve(import.meta.dirname, "../../../.baerly-data"),
});
await ensureTable(storage, { app: "helpdesk", tenant: "helpdesk-demo", table: "tickets" });

createServer(
  createListener({
    app: "helpdesk",
    storage,
    verifier: sharedSecret({ secret: "dev-helpdesk-secret", tenantPrefix: "helpdesk-demo" }),
  }),
).listen(3000);
```

Reads and writes look the same on the client and the server — the
client just sends them over HTTP:

```ts
// apps/web/src/TicketForm.tsx (etc.)
await client.table<Ticket>("tickets").insert({ title, status, ... });
await client.table<Ticket>("tickets").where({ _id }).update({ status: "closed" });
await client.table<Ticket>("tickets").where({ status: "open" }).all();
```

Live updates are one hook — `useChanges` refetches whenever the
table's `/v1/since` cursor advances:

```tsx
// apps/web/src/TicketList.tsx
const { events } = useChanges(client, "tickets");
useEffect(() => {
  void (async () => setRows(await client.table<Ticket>("tickets").where({}).all()))();
}, [events, filter]);
```

## Bucket layout

Under `.baerly-data/` (`.gitignored`):

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

Point the web app at a `wrangler dev` Worker instead of the Node
server — no React code changes:

```sh
# Terminal 1: a CF-scaffolded baerly Worker on :8787
cd path/to/your/cf-worker && wrangler dev

# Terminal 2: web only, server URL overridden via env
HELPDESK_SERVER_URL=http://localhost:8787 pnpm --filter @helpdesk/web run dev
```

Use `pnpm create baerly` to scaffold a production-shaped Worker
(`@baerly/adapter-cloudflare` + R2 bindings + `cloudflareAccess` /
`sharedSecret` verifier).

## Files to read

- `types.ts` — shared `Ticket` interface.
- `apps/server/src/index.ts` — server boot (~25 lines).
- `apps/server/src/seed.ts` — idempotent demo data; in-process `Db`.
- `apps/web/src/client.ts` — `createBaerlyClient` construction.
- `apps/web/src/TicketList.tsx` — `useChanges` + status filter.
- `smoke.test.ts` — round-trip test that runs in CI.

## Troubleshooting

- **"401 Unauthorized" from the web app.** Bearer token mismatch.
  The web app reads `VITE_HELPDESK_SECRET`; the server reads
  `HELPDESK_SECRET`. Default both to `dev-helpdesk-secret`.
- **Port 3000 / 5173 in use.** Override
  `PORT=3100 pnpm --filter @helpdesk/server dev` and update
  `vite.config.ts`'s proxy target.
- **"current.json missing".** Stop everything, `pnpm --filter
  helpdesk reset`, then re-run `dev`.
