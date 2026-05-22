# helpdesk-cloudflare

Ticket CRUD app on Cloudflare. R2-backed storage, `cloudflareAccess` →
`sharedSecret` verifier fallback, React + Vite frontend served by the
Worker via Workers Assets. A reference example of a schema-bound
app (status / priority / assignee enums on the `Ticket` schema) —
browse it for a fully-fleshed-out app, scaffold from
`react-cloudflare` if you want a starter to build on.

## Quick start

```sh
cd helpdesk-cloudflare
pnpm install
cp .dev.vars.example .dev.vars        # ships SHARED_SECRET=dev-shared-secret, matching the client fallback
pnpm dev                              # vite (:5173) — `@cloudflare/vite-plugin` runs the Worker inside workerd in the same process
```

Open <http://localhost:5173>. The Vite dev server and the Worker run
in the same Vite process via `@cloudflare/vite-plugin` — `/v1/*` is
served by the Worker inside `workerd`, the SPA is served from
`src/web/`, both on the same origin. In production the deployed
Worker serves both the API and the static bundle on the same origin
via Workers Assets.

## How it's wired

- `src/server/index.ts` — verifier selector + `/v1/*` routing +
  SPA fallback through `env.ASSETS`.
- `wrangler.jsonc` — R2 binding (`BUCKET`), Assets binding
  (`ASSETS`) pointing at `dist/client/`, maintenance cron,
  observability vars.
- `src/web/` — React SPA. The client calls the Worker same-origin
  (`baseUrl: ""`) in both dev and prod.
- `vite.config.ts` — `@vitejs/plugin-react` + `@cloudflare/vite-plugin`.
- `types.ts` — shared `Ticket` interface + status/priority constants.

## Deploy

```sh
# Set the shared secret (only needed for the sharedSecret() Verifier
# branch; skip when you're going straight to Cloudflare Access).
wrangler secret put SHARED_SECRET

pnpm build              # tsc -b && vite build  → emits dist/client/
pnpm deploy             # wrangler deploy (R2 auto-provisioned)
```

For Cloudflare Access:

```sh
wrangler secret put CF_ACCESS_TEAM_DOMAIN
wrangler secret put CF_ACCESS_AUDIENCE_TAG
```

Then put Cloudflare Access in front of the Worker route.

## Secrets

Public configuration (`APP`, `TENANT`, `LOG_LEVEL`, `LOG_SAMPLE`)
lives in `wrangler.jsonc:vars`. Secrets — anything the verifier
needs (`SHARED_SECRET`, `CF_ACCESS_*`) — live separately:

- **Local dev:** `cp .dev.vars.example .dev.vars`, fill in the
  values, and `wrangler dev` reads it. `.dev.vars` is gitignored.
- **Production:** `wrangler secret put SHARED_SECRET` (one secret
  per command — value piped or prompted). Each secret is encrypted
  at rest and exposed on `env` at runtime.

`.dev.vars.example` is the catalog of every secret the Worker
expects. Update both files in lockstep when you add a new secret.

## Next steps

- Custom domain: set `domain` in `baerly.config.ts` and re-run `pnpm deploy`.
- Tune log volume: `LOG_LEVEL` (`debug | info | warn | error`) and
  `LOG_SAMPLE` (0..1) in `wrangler.jsonc`.
- Declare schemas in `baerly.config.ts` under `collections.<name>.schema`
  (any StandardSchema v1 validator — Zod, Valibot, ArkType) for runtime
  insert/update/replace validation. See `AGENTS.md` → "Schemas (live feature)".
