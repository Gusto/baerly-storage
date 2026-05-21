---
title: Browser → server auth
audience: integrator
summary: How the SPA in your scaffolded app authenticates to the Worker / Node server in dev and prod.
last-reviewed: 2026-05-20
tags: [client, auth, integration]
related: ["./auth.md", "./client-middleware.md"]
---

# Browser → server auth

baerly's design center is "trusted multi-instance, browser is a typed
HTTP client." The browser sends `/v1/*` HTTP requests; the server
runs the verifier and pins the tenant. The browser never owns the
bearer token — anything that lands in `import.meta.env.*` lands in
the static SPA bundle, which is served to every visitor.

The scaffold templates use this split:

## Dev (any target)

Vite's `baerlyDevAuth` plugin (re-exported from
`baerly-storage/dev/vite`) attaches a `configureServer` middleware
that injects `Authorization: Bearer ${secret}` on every `/v1/*`
request **server-side**. The browser fetches plain
`/v1/healthz`; Vite mutates the request headers before forwarding
to the in-process Worker (CF templates) or proxying to the Node
server (Node templates).

- **`minimal-cloudflare`, `helpdesk-cloudflare`** —
  `loadDevVars(".dev.vars")` reads `SHARED_SECRET`;
  `baerlyDevAuth({ secret })` uses it. `process.env.SHARED_SECRET`
  is consulted as a fallback for CI / shell-export flows.
- **`minimal-node`** — `loadDevVars(".env")` + `process.env`
  fallback; same plugin.
- **`helpdesk`** — the `baerlyDev()` plugin owns the secret and the
  request boundary; injection happens inside the plugin. No extra
  wiring in `vite.config.ts`.

In all four, `src/web/client.ts` (or `main.ts`) calls
`createBaerlyClient({ baseUrl: "" })` with no `Authorization`
header. The secret stays out of the bundle.

The dev-auth plugin is `apply: "serve"`, so `vite build` skips it
entirely. No code path puts the secret into the produced
`dist/client/`.

## Prod, Cloudflare target

Wire **Cloudflare Access** in front of the Worker route. Browsers
authenticate against the Access app and CF sets a
`Cf-Access-Jwt-Assertion` cookie; the Worker's
`cloudflareAccess({ teamDomain, audienceTag })` verifier reads it
and derives `tenantPrefix` from the email claim.

```ts
// src/server/index.ts — minimal-cloudflare
import { cloudflareAccess } from "baerly-storage/auth";

const verifier =
  env.CF_ACCESS_TEAM_DOMAIN !== undefined && env.CF_ACCESS_AUDIENCE_TAG !== undefined
    ? cloudflareAccess({
        teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
        audienceTag: env.CF_ACCESS_AUDIENCE_TAG,
      })
    : /* fallback for server-to-server callers (CI, cron) */ sharedSecret({ ... });
```

`baerly doctor --target=cloudflare` warns if a deployed Worker has
`SHARED_SECRET` set without `CF_ACCESS_*` configured — because in
that configuration the SPA can't authenticate without leaking the
token.

## Prod, Node target

Use `bearerJwt({ jwks, issuer, audience })` against your OIDC
provider. The SPA acquires the token via your auth flow (Auth0,
Cognito, Okta, etc.) and sends `Authorization: Bearer <jwt>`. The
verifier validates against JWKS and pins the tenant from a claim.

## `SHARED_SECRET` in prod

`sharedSecret()` is for **server-to-server** callers only — CI
jobs, scheduled-task runners, internal services. Never put the
token in a browser bundle, build-time env var, or static asset.
If the SPA needs to talk to the API in prod, use CF Access (CF)
or OIDC (Node). Do not ship `SHARED_SECRET` to the browser in any
form.
