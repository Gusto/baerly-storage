# `@baerly/adapter-cloudflare`

Cloudflare Workers adapter for Baerly. Ships two `Storage` flavors and a
`fetch(req, env, ctx)` Worker mount.

## What's here

- **`r2BindingStorage(bucket)`** — fast-path `Storage` backed by an R2
  binding. Bypasses SigV4 entirely; the binding speaks an in-cell
  protocol. Pick this when the Worker and bucket live in the same
  Cloudflare account.
- **`S3HttpStorage`** — re-exported from `@baerly/protocol` for the
  HTTP fallback. Use when running against AWS S3, GCS, or cross-account
  R2 — anywhere the binding isn't available.
- **`baerlyWorker(options?)`** — `fetch(req, env, ctx)` module-default
  export. Phase 3 ships only `GET /v1/healthz`; the
  forward-compatible `handler` hook lets callers ship custom routes
  before Phase 6's full `Routes` contract lands.

Internal-only for now (`"private": true`). Public API surface is the
JSDoc on `src/*.ts`.
