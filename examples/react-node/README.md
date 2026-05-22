# react-node

A baerly app scaffolded with `create-baerly` for the **Node** target —
any host that runs `node server.js` (Railway, Render, Fly without
Docker, Heroku, a VM, a container scheduler, your laptop). Uses
`baerly-storage/node` against an S3-compatible bucket (AWS S3, R2 via
S3-compat, Minio, etc.) with a `bearerJwt` → `sharedSecret` fallback
`Verifier` chain, plus a React + Vite SPA and a one-collection `notes`
schema you extend.

To ship a production Dockerfile alongside, scaffold with
`--with=docker` — the add-on writes a multi-stage distroless Dockerfile,
`.dockerignore`, and `healthcheck.js` into this same shape.

## What you got

```
react-node/
├── package.json              # one package, all deps
├── tsconfig.json             # project-references stub
├── tsconfig.app.json         # client TS project (src/web)
├── tsconfig.server.json      # Node server TS project (src/server)
├── vite.config.ts            # Vite + @vitejs/plugin-react + baerlyDev()
├── index.html                # SPA shell — Vite's entry point
├── .env.example              # storage creds, verifier, observability
├── baerly.config.ts          # app, tenant, target, NoteSchema
├── types.ts                  # `Note` type inferred from the Zod schema
├── AGENTS.md                 # deeper guide: hooks, schema, auth, deploy
├── CLAUDE.md                 # same content (Claude Code reads this)
├── src/
│   ├── server/
│   │   └── index.ts          # baerlyNode({ app, storage, verifier, webRoot, maintenance? }).listen(PORT)
│   └── web/
│       ├── main.tsx          # React entry
│       ├── App.tsx           # Provider + view router
│       ├── client.ts         # BaerlyClient bound to this config
│       ├── NoteList.tsx      # useLiveQuery
│       ├── NoteDetail.tsx    # useLiveDocument + useDelete
│       └── NoteForm.tsx      # useInsert + useUpdate
└── README.md
```

## Run locally

```sh
pnpm install
pnpm dev
```

`pnpm dev` runs `vite`. `baerlyDev()` from `baerly-storage/dev/vite`
mounts the Node HTTP listener as Connect middleware on the same Vite
process that serves the SPA, so `GET /` hits the SPA on
`http://localhost:5173/` and anything baerly handles (e.g.
`GET /v1/healthz`, `POST /v1/notes`) is served on the same origin —
one process, one port, SPA + HMR + `/v1/*` in one command. Storage is
`LocalFsStorage` rooted at `.baerly-data/`, so first-touch needs no
S3 creds, no JWKS, and no second process.

Open <http://localhost:5173>. Type a note, hit Create. Open a second
tab — edits in one tab appear in the other over the `/v1/since`
long-poll.

For production-shaped local runs (S3, the verifier of your choice,
and the bundled SPA served from `dist/client/`):

```sh
pnpm build
BUCKET=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... SHARED_SECRET=... pnpm start
```

The server reads `BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
and either `JWKS_URL` (production) or `SHARED_SECRET` (parity with
`pnpm dev`) at startup. Optional: `R2_ACCOUNT_ID` (switches the
storage factory from `s3Storage` to `r2Storage`), `AWS_REGION`,
`PORT`, `TENANT`, `WEB_ROOT`, `MAINTENANCE_COLLECTIONS` (comma-
separated collection slugs — when set, `baerlyNode` runs one
compact+GC pass per `(tenant, collection)` pair on its
hourly tick; leave unset to skip the in-process loop and schedule
maintenance externally — a PaaS cron, k8s CronJob, systemd timer).

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
  scaffold with `create-baerly --target=node --with=docker` to add
  a production Dockerfile, `.dockerignore`, and `healthcheck.js`
  alongside this shape, then `docker build .`.

Verify: `curl https://<your-service>/v1/healthz`.

## Extend the schema

Edit `baerly.config.ts`. The `Note` row type in `types.ts` is
inferred from `NoteSchema` — adding a field there propagates to
the UI through `import type { Note }`.

```typescript
export const NoteSchema = z.object({
  _id: z.string(),
  body: z.string().min(1),
  created_at: z.string(),
  // Add fields here:
  tags: z.array(z.string()).optional(),
});
```

## Production auth

The emitted `src/server/index.ts` chooses `bearerJwt()` when `JWKS_URL`
is set, else falls back to `sharedSecret()` for parity with `pnpm dev`.
Point `JWKS_URL` at your IdP's JWKS endpoint
(`https://<issuer>/.well-known/jwks.json`) and set `JWT_ISSUER` +
`JWT_AUDIENCE`. Remove the shared-secret branch before production.
See `AGENTS.md` → "Production auth" for the swap.

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
  --bucket=react-node --app=react-node --tenant=<your-tenant> \
  --table=<collection-name> --output=./out.sql
```

The export is a **point-in-time** snapshot and honors any active
schema on the collection. Your data was already in your bucket and
your code is a portable HTTP server, so the graduation doesn't
require vendor cooperation.

## Pointers

- `baerly.config.ts` — app config + Zod schema.
- `src/server/index.ts` — `node:http` listener entry (`baerlyNode`).
- `src/web/NoteList.tsx` — `useLiveQuery` live-updates hook.
- `vite.config.ts` — Vite + React + `baerlyDev()` dev middleware.
- `AGENTS.md` / `CLAUDE.md` — agent-facing guide (byte-identical).
