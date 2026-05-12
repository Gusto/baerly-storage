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
│   │   ├── wrangler.toml     # name, R2 binding, vars, [triggers]
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

1. Create the R2 bucket: `wrangler r2 bucket create {{appName}}`.
2. Set the shared secret: `wrangler secret put SHARED_SECRET`.
3. Deploy: `pnpm -F server deploy` (which runs `wrangler deploy`).

A future `baerly deploy --target=cloudflare` will package these
three steps; for now they're manual.

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
- `apps/server/wrangler.toml` — Cloudflare Worker manifest.
- `AGENTS.md` — agent-facing guide for the next contributor.
