# minimal-node

A baerly-storage app scaffolded with `@gusto/create-baerly-storage` for
the **Node** target — any host that runs `node server.js` (Railway,
Render, Fly without Docker, Heroku, a VM, a container scheduler, your
laptop). Runs zero-config on local filesystem storage out of the box;
promote to an S3-compatible bucket via `@gusto/baerly-storage/node` for
production. AWS S3 and Cloudflare R2 are the production-supported
targets; MinIO is the local conformance target, and other endpoints
require `baerly doctor --bucket` plus owner validation. Ships
`auth: "none"` so the day-1 happy path works with zero env vars; flip
to a shared secret or wire `bearerJwt` against your OIDC IdP before
deploy — see "Going to production" below.

**In production, the S3-compatible bucket is the durable state**
(locally, a `./.baerly-data` directory stands in). The Node process is
trusted app code with bucket credentials; it applies the
baerly-storage protocol, but it is not a database server. No daemon,
lock table, scheduler, or idle database bill; maintenance is automatic
and write-triggered.

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
├── .env.example              # storage selection (local-fs default) + PORT
├── baerly.config.ts          # app, tenant, target, domain
├── AGENTS.md                 # deeper guide: predicates, schemas,
│                             #   auth recipes, graduation
├── src/
│   ├── server/
│   │   └── index.ts          # baerlyNode({ config, storage, webRoot }).listen(PORT)
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
`http://localhost:5173/` and anything baerly-storage handles (e.g.
`GET /v1/healthz`) is served on the same origin — one process, one
port, SPA + HMR + `/v1/*` in one command. Storage is `LocalFsStorage`
rooted at `.baerly-data/`, so first-touch needs no S3 creds, no JWKS,
and no second process.

For production-shaped local runs (the built SPA served from
`dist/client/` alongside `/v1/*`):

```sh
pnpm build
pnpm start
```

`pnpm start` defaults to `localFsStorage()` (persists to
`./.baerly-data`, zero credentials, single-node only). To opt into
S3 or R2:

```sh
# AWS S3
BUCKET=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... pnpm start

# Cloudflare R2
R2_ACCOUNT_ID=... BUCKET=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... pnpm start
```

The server reads `BUCKET`, `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY` at startup; when those are absent it falls
back to `localFsStorage()` for local runs. **In a detected deployment
(`NODE_ENV=production` or a known PaaS) it refuses to start and requires
a bucket** — local-fs is local-dev only (single-process, no
cross-process CAS or crash durability). The default `auth: "none"`
posture needs no auth env vars. The default entrypoint also reads
optional `AWS_REGION` and `PORT`. There is no `WEB_ROOT` env var — the SPA
path is the hard-coded `webRoot: "dist/client"` in
`src/server/index.ts`. Auth, tenant, and maintenance env vars require
adopting the documented code/config recipe first.

Maintenance (compaction + GC) is automatic and in-band: it runs
inline on the rare write that crosses a maintenance trigger — no env
var, no tick, no `setInterval`, no operator scheduler. Two ops-plane
env vars tune it: `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` raises the
snapshot ceiling and `BAERLY_MAINTENANCE_DISABLE=1` is a kill switch.
For an explicit out-of-band sweep, call `runScheduledMaintenance`
from `@gusto/baerly-storage`.

After `pnpm build`, `pnpm start` serves the Vite-built SPA from
`dist/client/` on `http://localhost:8080/` and the baerly-storage HTTP
surface on `http://localhost:8080/v1/*` — single origin, no CORS.

`pnpm typecheck` runs `tsc -b --noEmit` across both project
references.

## Deploy

This scaffold runs anywhere `node server.js` runs. The `package.json`
exposes `build` (Vite SPA + TS check) and `start`
(`node --experimental-strip-types src/server/index.ts`); arrange your
host to run `pnpm install && pnpm build`, then `pnpm start` with the
storage/auth env vars exported or configured in the process manager.
A deployment must set a durable bucket (`BUCKET` + `AWS_*`, or
`R2_ACCOUNT_ID` + creds); the server fails loud rather than running on
local-fs, which is local-dev only. Self-hosting without a cloud bucket,
run MinIO on the box or use SQLite + Litestream.

Concrete shapes:

- **Managed PaaS** (Railway, Render, DO App Platform, Fly Machines
  without a Dockerfile, Heroku): push the repo to a connected GitHub
  repo, set env vars from `.env.example` in the dashboard, deploy.
  The platform's buildpack detects Node and runs the root scripts.
- **VM / bare-metal**: clone, install Node 24+, copy `.env.example`
  to `.env` as a template, then export those values or configure them
  in your process manager (Node does not load `.env` automatically).
  Run `pnpm install && pnpm build && pnpm start` under systemd, pm2,
  or your process manager of choice.
- **Container** (Docker, k8s, ECS, Fly Machines with a Dockerfile):
  scaffold with `pnpm create @gusto/baerly-storage@latest my-app --target=node --with=docker` to add
  a production Dockerfile, `.dockerignore`, and `healthcheck.js`
  alongside this shape, then `docker build .`.

Verify: `curl https://<your-service>/v1/healthz`.

## Next steps

1. **Read `AGENTS.md`** for the agent-facing guide — predicates,
   indexes, schemas, auth recipes (JWKS setup), write-triggered
   maintenance, and the graduation criteria. (Claude Code
   users: `@gusto/create-baerly-storage` mirrors `AGENTS.md` to `CLAUDE.md` at
   scaffold time.)
2. **Declare your first collection schema** in `baerly.config.ts`
   via `defineConfig({ collections: { ... } })`. The Node adapter
   passes that config to `Db.create({ storage, app, tenant, config })`,
   so schema validation is live and bad inserts return 400.
3. **Set up production auth** — follow `AGENTS.md` → "Going to
   production". Pattern B flips `auth: "shared-secret"` and reads
   `SHARED_SECRET` from `process.env`; Pattern C wires `bearerJwt`
   against your OIDC IdP via an env-aware factory `verifier:`
   override (`JWKS_URL` + `JWT_ISSUER` + `JWT_AUDIENCE`).
   Verify the bucket with `baerly doctor --bucket=<s3-uri>` and the
   deployed service with `curl https://<your-service>/v1/healthz`.

## When to graduate

baerly-storage is designed for the small-to-medium operating point.
Past these thresholds, S3 list-prefix latency and per-class operation
pricing starts to dominate, and you've outgrown the workload envelope — move to a database service:

- **~30 writes / minute / collection** — per-collection throughput estimate (CAS-livelock model)
- **>10 GB / tenant** — R2 free-tier storage cost line (a billing signal, not a protocol ceiling)
- **~100 collections / tenant** — soft fan-out guideline (linear cost, bench-grounded; nothing enforces it)

When you cross these signals, graduation is mechanical:
`baerly export --target=postgres` walks your log entries (already Debezium-style CDC change events) into a database service. If your
deploy target is Cloudflare Workers and you'll accept Cloudflare
lock-in, [D1](https://developers.cloudflare.com/d1/) is cheaper
per-write at M-size and is a natural next step. If you're on
AWS, on-prem, or want your data portable, managed Postgres is
the typical destination. Either way — graduation is a Baerly win,
not a churn event.

**Export to a database service** (swap `--target=` for `sqlite`,
`postgres`, or `d1`):

```sh
baerly export --target=postgres \
  --bucket=s3://minimal-node --app=minimal-node --tenant=<your-tenant> \
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
  server-to-server callers (CI and internal services). Flip
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
