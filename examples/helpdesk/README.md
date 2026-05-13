# Baerly Helpdesk — example app

A minimal CRUD helpdesk. Two workspaces:

- `apps/server` — Node HTTP server (`@baerly/adapter-node`) wrapping
  a local-filesystem `Storage`.
- `apps/web` — React UI (Vite dev server) talking to the server via
  `@baerly/client`. Live ticket list updates via the `useChanges`
  long-poll hook.

## Quick start (90 seconds)

From the repo root:

```sh
pnpm install
pnpm --filter helpdesk dev
```

Then open <http://localhost:5173>. The first time you boot, click
"+ New ticket" to add one — or run `pnpm --filter helpdesk seed` in a
second terminal to pre-fill five demo tickets.

Open a second tab to <http://localhost:5173>. Add a ticket in the
first tab; watch it appear in the second. That's `useChanges` talking
to `/v1/since`.

## What you just ran

| Process       | URL                                             | What it does                                              |
| ------------- | ----------------------------------------------- | --------------------------------------------------------- |
| `apps/server` | <http://localhost:3000>                         | Node HTTP server. Persists tickets to `.baerly-data/`.    |
| `apps/web`    | <http://localhost:5173>                         | Vite dev server. Proxies `/v1/*` to `:3000`.              |

The bucket layout under `.baerly-data/`:

```
app/helpdesk/tenant/helpdesk-demo/manifests/tickets/
├── content/<sha256>.json     ← document bodies (content-addressed)
├── current.json              ← the CAS pointer
└── log/<seq>.json            ← per-mutation log entries
```

## Resetting the demo

```sh
pnpm --filter helpdesk reset
pnpm --filter helpdesk dev
```

Wipes `.baerly-data/`. Server bootstraps a fresh `current.json` on
next boot.

## What's NOT here

- **No auth UI.** The example uses a hard-coded bearer token
  (`dev-helpdesk-secret`). Real apps wire a `Verifier` to a JWT / OIDC
  IdP (Phase 8 ships `sharedSecret()`, `bearerJwt()`,
  `cloudflareAccess()`).
- **No user management.** The example has one tenant
  (`helpdesk-demo`) and one bearer token. Multi-tenant apps resolve
  `tenantPrefix` from the request's credentials.
- **No routing library.** Three views; one `useState` discriminated
  union. Bring your own router.
- **No data lib.** `@baerly/client` returns plain promises. Use
  `useEffect`, TanStack Query, SWR — your call.

## Cloudflare swap (one flag)

Phase 8 also ships a Cloudflare deploy target. Swap the local Node
server for a `wrangler dev` Worker:

```sh
# Terminal 1: in a CF-scaffolded Worker entry, run wrangler dev
# on port 8787.
cd path/to/your/cf-worker && wrangler dev

# Terminal 2: point the helpdesk web at the Worker.
HELPDESK_SERVER_URL=http://localhost:8787 \
  pnpm --filter @helpdesk/web run dev
```

The web app's Vite proxy reads `HELPDESK_SERVER_URL`; no React code
changes. (Wiring an in-repo Cloudflare target for the helpdesk is
deferred — a future `examples/helpdesk-cloudflare/` would land it.)

## Files to read

- `apps/server/src/index.ts` — server boot. ~60 LOC; every line
  matters.
- `apps/web/src/TicketList.tsx` — `useChanges` consumption.
- `apps/web/src/client.ts` — `createBaerlyClient` construction.
- `smoke.test.ts` — round-trip test that runs in CI.

## Troubleshooting

- **"current.json missing".** Server didn't bootstrap. Delete
  `.baerly-data/` and re-run `pnpm --filter helpdesk dev`.
- **"401 Unauthorized" from the web app.** Bearer token mismatch. The
  web app reads `VITE_HELPDESK_SECRET`; the server reads
  `HELPDESK_SECRET`. Default both to `dev-helpdesk-secret`.
- **Port 3000 / 5173 in use.** Override
  `PORT=3100 pnpm --filter @helpdesk/server dev` and update
  `vite.config.ts`'s proxy target.
