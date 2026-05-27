# minimal-cloudflare

A baerly app scaffolded with `create-baerly` for the **Cloudflare
Workers** target. Single-bucket R2-backed deployment via the
`baerly-storage/cloudflare` adapter. Ships `auth: "none"` so the
day-1 happy path works with zero env vars; flip to Cloudflare
Access or a shared secret before deploy — see "Going to
production" below.

## What you got

```
minimal-cloudflare/
├── package.json              # one package, all deps
├── tsconfig.json             # project-references stub
├── tsconfig.app.json         # client TS project (src/web)
├── tsconfig.worker.json      # Worker TS project (src/server)
├── vite.config.ts            # Vite + @cloudflare/vite-plugin
├── wrangler.jsonc            # Worker manifest — R2 binding, assets, vars, triggers, limits, observability
├── index.html                # SPA shell — Vite's entry point
├── baerly.config.ts          # app, tenant, target, domain
├── AGENTS.md                 # deeper guide: predicates, schemas,
│                             #   auth recipes, graduation (Codex CLI)
├── CLAUDE.md                 # same content (Claude Code reads this)
├── src/
│   ├── server/
│   │   └── index.ts          # baerlyWorker((env) => ({ verifier }))
│   └── web/
│       └── main.ts           # SPA client entry — Workers Assets serves the build
└── README.md
```

## Run locally

```sh
pnpm install
pnpm dev
```

`pnpm dev` runs `vite`. The `@cloudflare/vite-plugin` runs your Worker
inside `workerd` next to the SPA dev server, so `GET /` hits the SPA
on `http://localhost:5173/` and anything the Worker handles
(e.g. `GET /v1/healthz`) is served on the same origin. First run
downloads the `workerd` binary.

`pnpm build` runs `tsc -b && vite build`; the SPA lands in
`dist/client/` for the `assets:` binding in `wrangler.jsonc` to ingest
on deploy.

`pnpm typecheck` runs `tsc -b --noEmit` across both TS project
references.

## Deploy

```sh
# One-command deploy. baerly reads `baerly.config.ts:target`, finds
# `wrangler.jsonc`, and runs:
#   wrangler deploy --x-provision --x-auto-create
# which auto-creates the declared R2 bucket(s) before the deploy.
# When the experimental flag is unavailable, baerly falls back to
# `wrangler r2 bucket create` + `wrangler deploy`.
baerly deploy

# Verify the deployed config — bindings, secrets, cron triggers.
baerly doctor --target=cloudflare
```

`baerly doctor --target=cloudflare` warns on `auth: "none"` for
deploy targets — see "Going to production" below to flip the
posture before shipping.

If you'd rather run the steps by hand: `pnpm build` → `wrangler r2
bucket create minimal-cloudflare` → `wrangler deploy` from this
directory. The `assets:` binding in `wrangler.jsonc` picks up
`dist/client/` automatically.

## Secrets

Public configuration (`APP`, `TENANT`) lives in
`wrangler.jsonc:vars`. The default `auth: "none"` posture
needs no secrets. If you adopt a "Going to production" recipe:

- **Pattern A (CF Access):** `CF_ACCESS_TEAM_DOMAIN` +
  `CF_ACCESS_AUDIENCE_TAG` go in `wrangler.jsonc:vars` (they're
  public identifiers, not secrets).
- **Pattern B (`auth: "shared-secret"`):** `SHARED_SECRET` is a
  secret — `.dev.vars` for `wrangler dev`, `wrangler secret put
  SHARED_SECRET` for production. Each secret is encrypted at rest
  and exposed on `env` at runtime.

## Next steps

1. **Read `AGENTS.md`** for the agent-facing guide — predicates,
   indexes, schemas, auth recipes, the maintenance cron, and the
   graduation criteria. Codex CLI reads `AGENTS.md`; Claude Code
   reads `CLAUDE.md`; both files are byte-identical so either
   surface lands you the same context.
2. **Declare your first collection schema** in `baerly.config.ts`
   via `defineConfig({ collections: { ... } })` and pass it to
   `Db.create({ ..., collections })`. Schema validation is live;
   bad inserts return 422.
3. **Set up production auth** — follow `AGENTS.md` → "Going to
   production". Pattern A wires CF Access via an env-aware factory
   `verifier:` override; Pattern B flips `auth: "shared-secret"`.
   `baerly doctor --target=cloudflare` reports any gaps.
4. **Check usage trends** — run `baerly doctor --target=cloudflare
   --usage` periodically. It estimates your current writes/minute
   per collection from recent log entries and warns when you're
   approaching the graduation ceiling described in the "When to
   graduate" section below.

## When to graduate

baerly is designed for the small-to-medium operating point. Past these
thresholds, S3 list-prefix latency and per-class operation pricing
start to dominate, and you're better off on a real database:

- **~30 writes / minute / collection**
- **~10 GB / tenant**
- **~100 collections / tenant**

When you cross the soft ceiling, the graduation target is **D1**
(Postgres, or SQLite via Litestream — whichever fits your runtime).
At the M-size operating point, D1 is roughly $5/month versus
baerly's ~$19/month; the pitch was always portability, not cost.

**Export to a real database** (swap `--target=` for `sqlite`,
`postgres`, or `d1`):

```sh
baerly export --target=postgres \
  --bucket=minimal-cloudflare --app=minimal-cloudflare --tenant=<your-tenant> \
  --table=<collection-name> --output=./out.sql
```

The export is a **point-in-time** snapshot and honors any active
schema on the collection. Your data was already in your bucket and
your code is a portable HTTP server, so the graduation doesn't
require vendor cooperation.

## Production auth

The scaffold ships `auth: "none"` so the day-1 happy path works
with zero env vars; every request resolves to `config.tenant`.
Before deploy, follow `AGENTS.md` → "Going to production":

- **Pattern A — CF Access (recommended).** Same artifact in dev and
  prod; the factory `verifier:` override engages when
  `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUDIENCE_TAG` are present in
  `wrangler.jsonc:vars`. The `cloudflareAccess()` preset
  (re-exported from `baerly-storage/auth`) reads the JWT off
  `Cf-Access-Jwt-Assertion`, validates it against your team's JWKS,
  and derives `tenantPrefix` from the email claim.
- **Pattern B — `auth: "shared-secret"`.** Single-tenant
  server-to-server callers. Flip `auth` in `baerly.config.ts` and
  set `SHARED_SECRET` via `wrangler secret put`.

## Pointers

- `baerly.config.ts` — app config (`app`, `tenant`, `target`, `domain`).
- `src/server/index.ts` — Worker fetch + scheduled handler.
- `wrangler.jsonc` — Cloudflare Worker manifest (R2 binding, `assets:`, vars, cron, observability).
- `vite.config.ts` — Vite + `@cloudflare/vite-plugin`.
- `AGENTS.md` / `CLAUDE.md` — agent-facing guide (byte-identical).
