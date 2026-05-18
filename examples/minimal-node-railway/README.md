# minimal-node-railway

A baerly app scaffolded with `create-baerly` for the **managed PaaS**
Node target — shaped for Railway, Render, DO App Platform, and Fly
Machines. Uses `@baerly/adapter-node` against an S3-compatible bucket
(AWS S3, R2 via S3-compat, Minio, etc.) with a `bearerJwt` →
`sharedSecret` fallback `Verifier` chain.

## What you got

```
minimal-node-railway/
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
├── .baerly/schema.lock.json  # declared collection schemas
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

`pnpm dev` runs `baerly dev`, which boots a Node listener on
`http://localhost:3000` backed by local filesystem storage — no
S3 creds needed. Use it for first-touch exploration.

For production-shaped local runs (S3, the verifier of your choice,
and the bundled SPA served from `dist/client/`):

```sh
pnpm build
BUCKET=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... SHARED_SECRET=... pnpm start
```

The server reads `BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
and either `JWKS_URL` (production) or `SHARED_SECRET` (parity with
`wrangler dev`) at startup. Optional: `R2_ACCOUNT_ID` (switches the
storage factory from `s3Storage` to `r2Storage`), `AWS_REGION`,
`PORT`, `TENANT`, `WEB_ROOT`, `MAINTENANCE_COLLECTIONS` (comma-
separated collection slugs — when set, `baerlyNode` runs one
compact+GC pass per `(tenant, collection)` pair on its
hourly tick; leave unset to skip the in-process loop and schedule
maintenance via your PaaS's cron instead).

After `pnpm build`, `http://localhost:8080/` serves the built SPA
out of `dist/client/` and `http://localhost:8080/v1/*` is the
baerly HTTP surface — single origin, no CORS.

`pnpm typecheck` runs `tsc -b --noEmit` across both project
references.

## Deploy

This scaffold is shaped for managed PaaS platforms that auto-build
from a `package.json` `start` script — **Railway**, **Render**, **DO
App Platform**, **Fly Machines**. No Dockerfile required; the
platform's buildpack will detect Node and use the root
`package.json`'s `build` + `start` scripts.

Steps (Railway, as a concrete example):

1. `railway init` (or push the repo to a connected GitHub repo).
2. Set env vars from `.env.example` in the Railway dashboard.
3. Deploy. The platform runs `pnpm install && pnpm build` and then
   `pnpm start` from the repo root.

Then verify: `curl https://<your-service>.up.railway.app/v1/healthz`.

For raw Docker or k8s, see the `node-docker` example instead — it
ships a distroless Dockerfile and is shaped for container registries.

## Next steps

1. **Read `AGENTS.md`** for the agent-facing guide — predicates,
   indexes, schemas, auth recipes (JWKS setup), the in-process
   maintenance loop, and the graduation criteria. (Claude Code
   users: `create-baerly` mirrors `AGENTS.md` to `CLAUDE.md` at
   scaffold time.)
2. **Declare your first collection schema** in `baerly.config.ts`
   via `defineConfig({ collections: { ... } })` and pass it to
   `Db.create({ ..., collections })`. Schema validation is live;
   bad inserts return 422.
3. **Set up production auth** — point `JWKS_URL` at your IdP's
   JWKS endpoint (`https://<issuer>/.well-known/jwks.json`) and
   set `JWT_ISSUER` + `JWT_AUDIENCE`. Remove the `sharedSecret`
   fallback before production.

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
  --bucket=minimal-node-railway --app=minimal-node-railway --tenant=<your-tenant> \
  --table=<collection-name> --output=./out.sql
```

The export is a **point-in-time** snapshot and honors any active
schema on the collection. Your data was already in your bucket and
your code is a portable HTTP server, so the graduation doesn't
require vendor cooperation.

## Production auth

The emitted `server.ts` chooses `bearerJwt()` when `JWKS_URL` is set,
else falls back to `sharedSecret()` for parity with `pnpm dev`. Set
`JWKS_URL` in production and remove the shared-secret branch.

## Pointers

- `baerly.config.ts` — app config (`app`, `tenant`, `target`, `domain`).
- `src/server/index.ts` — node:http listener entry.
- `src/web/main.ts`, `index.html` — SPA client entry built into `dist/client/`.
- `vite.config.ts` — Vite client build.
- `AGENTS.md` — agent-facing guide (mirrored to `CLAUDE.md` at scaffold time).
