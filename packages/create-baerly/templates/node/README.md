# {{appName}}

A baerly app scaffolded with `create-baerly` for the **self-hosted
Node** target. Uses `@baerly/adapter-node` against an S3-compatible
bucket (AWS S3, R2 via S3-compat, Minio, etc.) with a `bearerJwt` →
`sharedSecret` fallback `Verifier` chain.

## What you got

```
{{appName}}/
├── package.json              # pnpm workspace root
├── pnpm-workspace.yaml       # apps/*
├── tsconfig.json
├── baerly.config.ts          # app, tenant, target, domain
├── AGENTS.md                 # agent-facing repo guide (Codex CLI)
├── CLAUDE.md                 # agent-facing repo guide (Claude Code)
                              #   — byte-identical sibling of AGENTS.md
├── .baerly/schema.lock.json  # reserved for future schema feature
├── apps/
│   ├── server/               # node:http listener — baerly host
│   │   ├── package.json
│   │   ├── Dockerfile        # multi-stage; tini + tsx entrypoint
│   │   └── src/server.ts     # createListener({ verifier })
│   └── web/                  # optional SPA shell — delete if unused
│       ├── package.json
│       └── index.html
└── README.md
```

## Run locally

```sh
{{installCmd}}
BUCKET=... AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... SHARED_SECRET=... {{runDev}}
```

The server reads `BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
and either `JWKS_URL` (production) or `SHARED_SECRET` (parity with
`wrangler dev`) at startup. Optional: `S3_ENDPOINT`, `AWS_REGION`,
`PORT`, `TENANT`.

`pnpm typecheck` runs `tsc --noEmit` across both apps.

## Deploy

1. Build the container: `docker build -t {{appName}} -f apps/server/Dockerfile .`.
2. Configure your S3 credentials + `SHARED_SECRET` / `JWKS_URL` as env vars.
3. Run: `docker run -e BUCKET=... -e SHARED_SECRET=... -p 8080:8080 {{appName}}`.

A future `baerly deploy --target=node` will package these steps;
for now they're manual.

## Production auth

The emitted `server.ts` chooses `bearerJwt()` when `JWKS_URL` is
set, else falls back to `sharedSecret()` for parity with `pnpm dev`.
Production setups should always set `JWKS_URL` and remove the
shared-secret branch.

## Pointers

- `baerly.config.ts` — app config (`app`, `tenant`, `target`, `domain`).
- `apps/server/src/server.ts` — node:http listener entry.
- `apps/server/Dockerfile` — container build (multi-stage).
- `AGENTS.md` — agent-facing guide for the next contributor.
