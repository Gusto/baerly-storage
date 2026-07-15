# `@baerly/adapter-cloudflare`

Cloudflare Workers adapter for Baerly. Ships two `Storage` flavors and a
`fetch(req, env, ctx)` Worker mount.

## What's here

- **`r2BindingStorage(bucket)`** — fast-path `Storage` backed by an R2
  binding. Bypasses SigV4 entirely; the binding speaks an in-cell
  protocol. Pick this when the Worker and bucket live in the same
  Cloudflare account.
- **HTTP S3 fallback** — use `S3HttpStorage` from
  `@gusto/baerly-storage/node` when a Node host talks to AWS S3, Minio,
  or cross-account R2 over the S3-compatible HTTP API (GCS uses the
  native `gcsStorage` adapter instead — its S3-interop path can't
  linearize the log). Workers should prefer `r2BindingStorage` when an
  R2 binding is available.
- **`baerlyWorker((env) => options)`** — env-lazy factory; resolves
  once on first `fetch` / `scheduled` and caches for the isolate.
  Returns the `fetch(req, env, ctx)` module-default export. When
  `options.verifier` is omitted the adapter synthesizes one from
  `config.auth` (declare `auth: "none"` in `baerly.config.ts` for the
  dev-time, pin-every-request-to-`config.tenant` posture; declare
  `auth: "shared-secret"` or pass a custom `Verifier` for production).
  The forward-compatible `handler` hook lets callers ship custom
  routes ahead of the default router.

Internal-only for now (`"private": true`). Public API surface is the
JSDoc on `src/*.ts`.
