# node-docker

A baerly app scaffolded with `create-baerly` for the **self-hosted
Node** target. Uses `@baerly/adapter-node` against an S3-compatible
bucket (AWS S3, R2 via S3-compat, Minio, etc.) with a `bearerJwt` →
`sharedSecret` fallback `Verifier` chain.

## What you got

```
node-docker/
├── package.json              # pnpm workspace root
├── tsconfig.json
├── baerly.config.ts          # app, tenant, target, domain
├── AGENTS.md                 # deeper guide: predicates, schemas,
│                             #   auth recipes, graduation
├── .baerly/schema.lock.json  # declared collection schemas
├── apps/
│   ├── server/               # node:http listener — baerly host
│   │   ├── package.json
│   │   ├── Dockerfile        # multi-stage; distroless runtime
│   │   ├── .dockerignore
│   │   ├── healthcheck.js    # used by Dockerfile HEALTHCHECK
│   │   ├── .env.example
│   │   └── src/server.ts     # createListener({ verifier })
│   └── web/                  # optional SPA shell — delete if unused
│       ├── package.json
│       └── index.html
└── README.md
```

## Run locally

```sh
pnpm install
BUCKET=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... SHARED_SECRET=... pnpm dev
```

The server reads `BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
and either `JWKS_URL` (production) or `SHARED_SECRET` (parity with
`wrangler dev`) at startup. Optional: `S3_ENDPOINT`, `AWS_REGION`,
`PORT`, `TENANT`.

`pnpm typecheck` runs `tsc --noEmit` across both apps.

## Deploy

This scaffold ships a multi-stage distroless `Dockerfile` and is
shaped for raw container deploys: **Docker on a VPS**, **Fly Machines**,
**DO Container Registry**, **k8s**, **ECS**. Build, push, run:

```sh
docker build -t node-docker:latest -f apps/server/Dockerfile .
docker run -p 8080:8080 --env-file apps/server/.env node-docker:latest
```

The Dockerfile uses `gcr.io/distroless/nodejs24-debian12` (no shell,
non-root user UID 65532), so the `HEALTHCHECK` shells out to the
bundled `apps/server/healthcheck.js` rather than `curl`/`wget`.

Then verify: `curl http://localhost:8080/v1/healthz`.

For managed PaaS platforms (Railway, Render, DO App Platform), see
the `node-railway` example — no Dockerfile needed; auto-build will
detect Node from `package.json`.

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
   fallback before production. `baerly doctor --target=node-docker`
   runs a 3-second JWKS reachability check.
4. **Check usage trends** — run `baerly doctor --target=node-docker
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
  --bucket=node-docker --app=node-docker --tenant=<your-tenant> \
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
- `apps/server/src/server.ts` — node:http listener entry.
- `apps/server/Dockerfile` — container build (multi-stage).
- `AGENTS.md` — agent-facing guide (mirrored to `CLAUDE.md` at scaffold time).
