# helpdesk-cloudflare

Ticket CRUD app on Cloudflare. R2-backed storage, `cloudflareAccess` →
`sharedSecret` verifier fallback, React + Vite frontend served by the
Worker via Workers Assets. The production-shaped sibling of
`examples/helpdesk` (which is a dev-only teaching fixture on
`LocalFsStorage`).

## Quick start

```sh
cd helpdesk-cloudflare
pnpm install
wrangler secret put SHARED_SECRET    # any string for dev
pnpm dev                              # vite (:5173) + wrangler dev (:8787) in parallel
```

Open <http://localhost:5173>. The Vite dev server proxies `/v1/*` to
wrangler on `:8787`; in production the Worker serves both the API and the
static bundle on the same origin.

## How it's wired

- `apps/server/src/worker.ts` — verifier selector + `/v1/*` routing +
  SPA fallback through `env.ASSETS`.
- `apps/server/wrangler.jsonc` — R2 binding (`BUCKET`), Assets binding
  (`ASSETS`), maintenance cron, observability vars.
- `apps/web/` — Vite SPA. The client calls the Worker same-origin in
  production; in dev it proxies `/v1/*` to `:8787`.

## Deploy

```sh
pnpm deploy            # vite build, then wrangler deploy (R2 auto-provisioned)
```

For Cloudflare Access:

```sh
wrangler secret put CF_ACCESS_TEAM_DOMAIN
wrangler secret put CF_ACCESS_AUDIENCE_TAG
```

Then put Cloudflare Access in front of the Worker route.

## Differences from `examples/helpdesk`

|                | `helpdesk` (dev-only)         | `helpdesk-cloudflare` (deployable) |
|----------------|-------------------------------|------------------------------------|
| Storage        | `LocalFsStorage`              | R2 via `@baerly/adapter-cloudflare` |
| Auth           | hard-coded `sharedSecret`     | CF Access → `sharedSecret` fallback |
| Hosting        | `node:http` server            | Cloudflare Worker + Workers Assets |
| Multi-tenant   | no (pinned to `helpdesk-demo`)| yes (verifier resolves tenant per request) |

## Next steps

- Custom domain: set `domain` in `baerly.config.ts` and re-run `pnpm deploy`.
- Tune log volume: `LOG_LEVEL` (`debug | info | warn | error`) and
  `LOG_SAMPLE` (0..1) in `wrangler.jsonc`.
- Declare schemas in `.baerly/schema.lock.json` for runtime
  insert/update/replace validation (see `@baerly/server` JSDoc).
