---
title: AGENTS.md — agent guidance for {{appName}}
audience: agent
summary: How to develop and deploy {{appName}}, a baerly app.
tags: [agent-entry, baerly]
---

# AGENTS.md

Guidance for AI coding agents working in this repo. This is a
baerly app — a vendorless document database that runs over any
S3-compatible storage API.

## What this is

`{{appName}}` is a baerly app scaffolded with `create-baerly`.
The Worker-side server lives in `apps/server/`; the optional client
lives in `apps/web/`. Configuration lives in `baerly.config.ts`.

Public API docs: https://docs.baerly.dev/ (the JSDoc on
`@baerly/server`'s `Db` and `Table` is the canonical reference;
read it via your editor's TS LS or via the published types).

## Toolchain

- **Package manager:** pnpm. The emitted repo pins
  `packageManager: pnpm@10.31.0`.
- **Test runner:** vitest.
- **Type checker:** TypeScript 5.6+. (The baerly-storage monorepo
  itself uses TypeScript 7 via `@typescript/native-preview`; this
  template tracks the broadly-compatible TS major so scaffolded
  apps work with the wider ecosystem.)

## Verification

| Command            | What it does                                                          | Runtime          |
| ------------------ | --------------------------------------------------------------------- | ---------------- |
| `{{runTypecheck}}` | TS typecheck across both apps                                         | seconds          |
| `{{runDev}}`       | Run the server locally — `wrangler dev` against the local R2 emulator | seconds to start |
| `pnpm test`        | Run all tests across both apps                                        | seconds          |

## Where the code is

| Path                         | What it is                                                                           |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `apps/server/src/worker.ts`  | Server entry — `baerlyWorker({ verifier })`                                          |
| `apps/server/wrangler.jsonc` | Cloudflare Worker manifest — name, R2 binding, vars, triggers, limits, observability |
| `apps/web/`                  | Optional client; SPA shell. Remove if not needed.                                    |
| `baerly.config.ts`           | App config — `app`, `tenant`, `target`, `domain`                                     |
| `.baerly/schema.lock.json`   | Reserved for collection schemas (future feature)                                     |

## When editing X, read Y

- **Auth setup** — `apps/server/src/worker.ts` wires a `Verifier`.
  Read the JSDoc on `sharedSecret` / `bearerJwt` /
  `cloudflareAccess` / `awsIamSigV4` / `allowlistIp` exported from
  `@baerly/server`.
- **Schema / query** — read the JSDoc on `Db.table(...)` from
  `@baerly/server`. The shape is `db.table<Doc>(name).where({
predicate }).all()`.
- **Deploy** — `baerly deploy --target=cloudflare` runs
  `wrangler deploy --x-provision --x-auto-create` (Wrangler 4.10+)
  to auto-create the declared R2 buckets and ship the Worker. When
  the experimental flag is unavailable it falls back to
  `wrangler r2 bucket create` + `wrangler deploy`. The fallback is
  also what `baerly doctor --target=cloudflare --fix` exercises.

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
- `apps/server/src/worker.ts` — server entry.
- `apps/server/wrangler.jsonc` — Cloudflare Worker manifest.
- `package.json` — root scripts + pnpm workspace.
