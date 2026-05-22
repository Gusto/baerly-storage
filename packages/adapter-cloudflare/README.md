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
- **`baerlyWorker((env) => options)`** — env-lazy factory; resolves once on first `fetch` / `scheduled` and caches for the isolate. Returns the `fetch(req, env, ctx)` module-default export. `options.verifier` is **required** — every non-healthz
  request runs the verifier first. Single-tenant dev wires
  `singleTenantDevVerifier(env.TENANT)` explicitly. The
  forward-compatible `handler` hook lets callers ship custom routes
  ahead of the default router.
- **`singleTenantDevVerifier(tenantPrefix)`** — dev-only convenience
  `Verifier` that resolves every request to one tenant. Never use
  in multi-tenant production.

Internal-only for now (`"private": true`). Public API surface is the
JSDoc on `src/*.ts`.
