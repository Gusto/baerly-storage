---
title: AGENTS.md — agent guidance for {{appName}}
audience: agent
summary: How to develop and deploy {{appName}}, a baerly app.
last-reviewed: <year>-<month>-<day>
tags: [agent-entry, baerly]
---

# AGENTS.md

Guidance for AI coding agents working in this repo. This is a
baerly app — a vendorless document database that runs over any
S3-compatible storage API.

## What this is

`{{appName}}` is a baerly app scaffolded with `create-baerly`.
The Node-side server lives in `apps/server/`; the optional client
lives in `apps/web/`. Configuration lives in `baerly.config.ts`.

Public API docs: https://docs.baerly.dev/ (the JSDoc on
`@baerly/server`'s `Db` and `Table` is the canonical reference;
read it via your editor's TS LS or via the published types).

## Toolchain

- **Package manager:** pnpm. The emitted repo pins
  `packageManager: pnpm@10.31.0`.
- **Test runner:** vitest.
- **Type checker:** TypeScript 5.6+.

## Verification

| Command | What it does | Runtime |
|---|---|---|
| `{{runTypecheck}}` | TS typecheck across both apps | seconds |
| `{{runDev}}` | Run the server locally — `tsx watch src/server.ts` | seconds to start |
| `pnpm test` | Run all tests across both apps | seconds |

## Where the code is

| Path | What it is |
|---|---|
| `apps/server/src/server.ts` | Server entry — `createListener({ verifier })` |
| `apps/server/Dockerfile` | Multi-stage container build (tini + tsx entrypoint) |
| `apps/web/` | Optional client; SPA shell. Remove if not needed. |
| `baerly.config.ts` | App config — `app`, `tenant`, `target`, `domain` |
| `.baerly/schema.lock.json` | Reserved for collection schemas (future feature) |

## When editing X, read Y

- **Auth setup** — `apps/server/src/server.ts` wires a `Verifier`.
  Read the JSDoc on `sharedSecret` / `bearerJwt` /
  `cloudflareAccess` / `awsIamSigV4` / `allowlistIp` exported from
  `@baerly/server`. The emitted default chooses `bearerJwt` when
  `JWKS_URL` is set and falls back to `sharedSecret` otherwise.
- **Schema / query** — read the JSDoc on `Db.table(...)` from
  `@baerly/server`. The shape is `db.table<Doc>(name).where({
  predicate }).all()`.
- **Deploy** — `baerly deploy --target=node` runs the right command
  (`docker build` + `docker push` + your orchestrator). Today it's
  manual: build the image from `apps/server/Dockerfile` and run.

## Anti-patterns

- ❌ Widening branded types from `@baerly/protocol` (`Ref`,
  `ManifestKey`). The types prevent confusion bugs.
- ❌ Reaching into `node_modules/@baerly/protocol/src/` directly —
  consume the published exports.
- ❌ Mutating `VerifierResult.tenantPrefix` between the verifier
  and `Db.create`. The dispatcher pins the tenant from the
  verifier's return value.

## Pointers

- `baerly.config.ts` — app config.
- `apps/server/src/server.ts` — server entry.
- `apps/server/Dockerfile` — container build.
- `package.json` — root scripts + pnpm workspace.
