# {{appName}}

A baerly app scaffolded with `create-baerly` for the **Cloudflare
Workers** target. Single-bucket R2-backed deployment with the
`@baerly/adapter-cloudflare` adapter and a `sharedSecret` `Verifier`
out of the box.

## What you got

```
{{appName}}/
├── package.json              # pnpm workspace root
├── pnpm-workspace.yaml       # apps/*
├── tsconfig.json
├── baerly.config.ts          # app, tenant, target, domain
├── AGENTS.md                 # agent-facing repo guide
├── .baerly/schema.lock.json  # reserved for future schema feature
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
{{installCmd}}
{{runDev}}
```

`pnpm dev` (or your PM's equivalent) runs `wrangler dev` against the
local R2 emulator. The first invocation downloads the `workerd`
binary.

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
{{appName}}` → `wrangler deploy` from `apps/server/`.

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
- `AGENTS.md` — agent-facing guide for the next contributor.
