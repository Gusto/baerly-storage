# minimal-cloudflare

A baerly app scaffolded with `create-baerly` for the **Cloudflare
Workers** target. Single-bucket R2-backed deployment with the
`@baerly/adapter-cloudflare` adapter and a `sharedSecret` `Verifier`
out of the box.

## What you got

```
minimal-cloudflare/
├── package.json              # pnpm workspace root
├── pnpm-workspace.yaml       # apps/*
├── tsconfig.json
├── baerly.config.ts          # app, tenant, target, domain
├── AGENTS.md                 # deeper guide: predicates, schemas,
│                             #   auth recipes, graduation (Codex CLI)
├── CLAUDE.md                 # same content (Claude Code reads this)
├── .baerly/schema.lock.json  # declared collection schemas
├── apps/
│   ├── server/               # Cloudflare Worker — baerly host
│   │   ├── package.json
│   │   ├── wrangler.jsonc    # name, R2 binding, vars, triggers, limits, observability
│   │   └── src/worker.ts     # baerlyWorker({ verifier })
│   └── web/                  # optional SPA shell — delete if unused
│       ├── package.json
│       └── index.html
└── README.md
```

## Run locally

```sh
pnpm install
pnpm dev
```

`pnpm dev` (or your PM's equivalent) runs `baerly dev` — a Node HTTP
listener on `:3000` backed by `LocalFsStorage`. No wrangler download
required for first-touch. For CF parity (Workerd + the local R2
emulator), run `pnpm dev:wrangler`; the first invocation downloads
the `workerd` binary.

`pnpm typecheck` runs `tsc --noEmit` across both apps.

## Deploy

```sh
# Set the shared secret (only needed for the sharedSecret() Verifier
# branch; skip when you're going straight to Cloudflare Access).
wrangler secret put SHARED_SECRET

# One-command deploy. baerly reads `baerly.config.ts:target`, finds
# `apps/server/wrangler.jsonc`, and runs:
#   wrangler deploy --x-provision --x-auto-create
# which auto-creates the declared R2 bucket(s) before the deploy.
# When the experimental flag is unavailable, baerly falls back to
# `wrangler r2 bucket create` + `wrangler deploy`.
baerly deploy

# Verify the deployed config — bindings, secrets, cron triggers.
baerly doctor --target=cloudflare
```

If you'd rather run the steps by hand: `wrangler r2 bucket create
minimal-cloudflare` → `wrangler deploy` from `apps/server/`.

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
3. **Set up production auth** — wire CF Access in front of your
   Worker route, then add `CF_ACCESS_TEAM_DOMAIN` +
   `CF_ACCESS_AUDIENCE_TAG` to `apps/server/wrangler.jsonc:vars`.
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

The emitted `worker.ts` uses `sharedSecret()` for parity with
`wrangler dev`. For production behind Cloudflare Access, swap to
`cloudflareAccess()` (re-exported from `@baerly/server`) and wire
Access in front of the Worker route. The preset reads the JWT off
`Cf-Access-Jwt-Assertion`, validates it against your team's JWKS,
and derives `tenantPrefix` from the email claim.

## Pointers

- `baerly.config.ts` — app config (`app`, `tenant`, `target`, `domain`).
- `apps/server/src/worker.ts` — Worker fetch + scheduled handler.
- `apps/server/wrangler.jsonc` — Cloudflare Worker manifest.
- `AGENTS.md` / `CLAUDE.md` — agent-facing guide (byte-identical).
