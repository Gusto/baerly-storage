# minimal-node

A baerly app scaffolded with `@gusto/create-baerly-storage` for the **Node** target —
any host that runs `node server.js` (Railway, Render, Fly without
Docker, Heroku, a VM, a container scheduler, your laptop). Uses
`@gusto/baerly-storage/node` against an S3-compatible bucket (AWS S3, R2 via
S3-compat, Minio, etc.). Ships `auth: "none"` so the day-1 happy
path works with zero env vars; flip to a shared secret or wire
`bearerJwt` against your OIDC IdP before deploy — see "Going to
production" below.

To ship a production Dockerfile alongside, scaffold with
`--with=docker` — the add-on writes a multi-stage distroless Dockerfile,
`.dockerignore`, and `healthcheck.js` into this same shape.

## What you got

```
minimal-node/
├── package.json              # one package, all deps
├── tsconfig.json             # project-references stub
├── tsconfig.app.json         # client TS project (src/web)
├── tsconfig.server.json      # Node server TS project (src/server)
├── vite.config.ts            # Vite SPA build → dist/client/
├── index.html                # SPA shell — Vite's entry point
├── .env.example              # storage creds, verifier, observability
├── baerly.config.ts          # app, tenant, target, domain
├── AGENTS.md                 # deeper guide: predicates, schemas,
│                             #   auth recipes, graduation
├── src/
│   ├── server/
│   │   └── index.ts          # baerlyNode({ app, storage, verifier, webRoot, maintenance? }).listen(PORT)
│   └── web/
│       └── main.ts           # SPA client entry — bundled into dist/client/
└── README.md
```

## Run locally

```sh
pnpm install
pnpm dev
```

`pnpm dev` runs `vite`. `baerlyDev()` from `@gusto/baerly-storage/dev/vite`
mounts the Node HTTP listener as Connect middleware on the same Vite
process that serves the SPA, so `GET /` hits the SPA on
`http://localhost:5173/` and anything baerly handles (e.g.
`GET /v1/healthz`) is served on the same origin — one process, one
port, SPA + HMR + `/v1/*` in one command. Storage is `LocalFsStorage`
rooted at `.baerly-data/`, so first-touch needs no S3 creds, no JWKS,
and no second process.

For production-shaped local runs (S3 and the bundled SPA served
from `dist/client/`):

```sh
pnpm build
BUCKET=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... pnpm start
```

The server reads `BUCKET`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` at startup. The default `auth: "none"`
posture needs no auth env vars; if you adopt Pattern B / C from
"Going to production" below, also set `SHARED_SECRET` (Pattern B)
or `JWKS_URL` + `JWT_ISSUER` + `JWT_AUDIENCE` (Pattern C). Optional:
`R2_ACCOUNT_ID` (switches the storage factory from `s3Storage` to
`r2Storage`), `AWS_REGION`, `PORT`, `TENANT`, `WEB_ROOT`,
`MAINTENANCE_COLLECTIONS` (comma-separated collection slugs — when
set, `baerlyNode` runs one compact+GC pass per `(tenant, collection)`
pair on its hourly tick; leave unset to skip the in-process loop and
schedule maintenance externally — a PaaS cron, k8s CronJob, systemd
timer).

After `pnpm build`, `http://localhost:8080/` serves the built SPA
out of `dist/client/` and `http://localhost:8080/v1/*` is the
baerly HTTP surface — single origin, no CORS.

`pnpm typecheck` runs `tsc -b --noEmit` across both project
references.

## Deploy

This scaffold runs anywhere `node server.js` runs. The `package.json`
exposes `build` (Vite SPA + TS check) and `start`
(`node --experimental-strip-types src/server/index.ts`); arrange your
host to run `pnpm install && pnpm build`, then `pnpm start`.

Concrete shapes:

- **Managed PaaS** (Railway, Render, DO App Platform, Fly Machines
  without a Dockerfile, Heroku): push the repo to a connected GitHub
  repo, set env vars from `.env.example` in the dashboard, deploy.
  The platform's buildpack detects Node and runs the root scripts.
- **VM / bare-metal**: clone, install Node 24+, copy `.env.example`
  to `.env`, run `pnpm install && pnpm build && pnpm start` under
  your process manager of choice (systemd, pm2, etc.).
- **Container** (Docker, k8s, ECS, Fly Machines with a Dockerfile):
  scaffold with `pnpm create @gusto/baerly-storage@latest --target=node --with=docker` to add
  a production Dockerfile, `.dockerignore`, and `healthcheck.js`
  alongside this shape, then `docker build .`.

Verify: `curl https://<your-service>/v1/healthz`.

## Next steps

1. **Read `AGENTS.md`** for the agent-facing guide — predicates,
   indexes, schemas, auth recipes (JWKS setup), the in-process
   maintenance loop, and the graduation criteria. (Claude Code
   users: `@gusto/create-baerly-storage` mirrors `AGENTS.md` to `CLAUDE.md` at
   scaffold time.)
2. **Declare your first collection schema** in `baerly.config.ts`
   via `defineConfig({ collections: { ... } })` and pass it to
   `Db.create({ ..., collections })`. Schema validation is live;
   bad inserts return 422.
3. **Set up production auth** — follow `AGENTS.md` → "Going to
   production". Pattern B flips `auth: "shared-secret"` and reads
   `SHARED_SECRET` from `process.env`; Pattern C wires `bearerJwt`
   against your OIDC IdP via an env-aware factory `verifier:`
   override (`JWKS_URL` + `JWT_ISSUER` + `JWT_AUDIENCE`).
   `baerly doctor --target=node` reports any gaps.

## When to graduate

baerly is designed for the small-to-medium operating point. Past these
thresholds, S3 list-prefix latency and per-class operation pricing
start to dominate, and you're better off on a real database:

- **~30 writes / minute / collection**
- **~10 GB / tenant**
- **~100 collections / tenant**

When you cross the soft ceiling, graduation is mechanical:
`baerly export --target=postgres` walks your log entries (already
Postgres-logical-replication-shaped) into a real DB. If your
deploy target is Cloudflare Workers and you'll accept Cloudflare
lock-in, [D1](https://developers.cloudflare.com/d1/) is cheaper
per-write at M-size and is a natural next step. If you're on
AWS, on-prem, or want your data portable, managed Postgres is
the typical destination. Either way — graduation is a Baerly win,
not a churn event.

**Export to a real database** (swap `--target=` for `sqlite`,
`postgres`, or `d1`):

```sh
baerly export --target=postgres \
  --bucket=minimal-node --app=minimal-node --tenant=<your-tenant> \
  --collection=<collection-name> --output=./out.sql
```

The export is a **point-in-time** snapshot and honors any active
schema on the collection. Your data was already in your bucket and
your code is a portable HTTP server, so the graduation doesn't
require vendor cooperation.

## Production auth

The scaffold ships `auth: "none"` so the day-1 happy path works
with zero env vars; every request resolves to `config.tenant`.
Before deploy, follow `AGENTS.md` → "Going to production":

- **Pattern B — `auth: "shared-secret"`.** Single-tenant
  server-to-server callers (CI, cron, internal services). Flip
  `auth` in `baerly.config.ts` and put `SHARED_SECRET` in
  `process.env` (your PaaS / secret manager).
- **Pattern C — JWKS-backed JWT (recommended for multi-tenant).**
  Same artifact in dev and prod; the factory `verifier:` override
  engages when `JWKS_URL` is set. `bearerJwt()` (re-exported from
  `@gusto/baerly-storage/auth`) validates against your IdP's JWKS endpoint
  (`https://<issuer>/.well-known/jwks.json`) with `JWT_ISSUER` +
  `JWT_AUDIENCE` and pins the tenant from a claim.

## Pointers

- `baerly.config.ts` — app config (`app`, `tenant`, `target`, `domain`).
- `src/server/index.ts` — node:http listener entry.
- `src/web/main.ts`, `index.html` — SPA client entry built into `dist/client/`.
- `vite.config.ts` — Vite client build.
- `AGENTS.md` — agent-facing guide (mirrored to `CLAUDE.md` at scaffold time).
