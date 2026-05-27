---
title: Browser → server auth
audience: integrator
summary: How the SPA in your scaffolded app authenticates to the Worker / Node server in dev and prod.
last-reviewed: 2026-05-24
tags: [client, auth, integration]
related: ["./auth.md", "./client-middleware.md"]
---

# Browser → server auth

baerly's design center is "trusted multi-instance, browser is a typed
HTTP client." The browser sends `/v1/*` HTTP requests; the server
runs the verifier and pins the tenant. The browser never owns the
bearer token — anything that lands in `import.meta.env.*` lands in
the static SPA bundle, which is served to every visitor.

The scaffolds default to `auth: "none"` in `baerly.config.ts`, so
the SPA can hit `/v1/*` with no `Authorization` header on day one
and every request resolves to `config.tenant`. The sections below
describe how the browser → server seam stays clean once you flip
the posture (Pattern A / B / C in each scaffold's `AGENTS.md` →
"Going to production").

## Dev (any target), default `auth: "none"`

No bearer to inject. The SPA calls
`createBaerlyClient({ baseUrl: "" })` with no `Authorization`
header; the dev plugin synthesizes a `noAuthVerifier` from
`config.auth`, the adapter pins the tenant to `config.tenant`, and
the request succeeds. Bundle stays clean.

## Dev, `auth: "shared-secret"` (Pattern B)

Once you flip `auth` to `"shared-secret"`, the Vite dev plugin
needs the bearer for browser calls. `baerlyDevAuth` (re-exported
from `@gusto/baerly-storage/dev/vite`) is the seam: a `configureServer`
middleware that injects `Authorization: Bearer ${secret}` on every
`/v1/*` request **server-side**. The browser fetches plain
`/v1/healthz`; Vite mutates the request headers before forwarding
to the in-process Worker (CF templates) or to the Node listener
mounted on the same Vite process (Node templates).

The wiring in each scaffold's `vite.config.ts` (per its `AGENTS.md`
→ "Going to production" Pattern B recipe):

```ts
import { baerlyDevAuth, loadDevVars } from "@gusto/baerly-storage/dev/vite";

const { SHARED_SECRET } = loadDevVars(".dev.vars", "SHARED_SECRET");
// …
plugins: [
  // …existing plugins,
  ...(SHARED_SECRET !== undefined
    ? [baerlyDevAuth({ secret: SHARED_SECRET })]
    : []),
],
```

`src/web/client.ts` (or `main.ts`) still calls
`createBaerlyClient({ baseUrl: "" })` with no `Authorization`
header. The secret stays out of the bundle. `baerlyDevAuth` is
`apply: "serve"`, so `vite build` skips it entirely — no code path
puts the secret into the produced `dist/client/`.

## Prod, Cloudflare target (Pattern A)

Wire **Cloudflare Access** in front of the Worker route. Browsers
authenticate against the Access app and CF sets a
`Cf-Access-Jwt-Assertion` cookie; the Worker's
`cloudflareAccess({ teamDomain, audienceTag })` verifier reads it
and derives `tenantPrefix` from the email claim.

The scaffold's "Going to production" Pattern A keeps
`config.auth: "none"` and supplies the verifier via the factory's
`verifier:` override (the adapter resolves the factory `verifier:`
first, so `cloudflareAccess` silently supersedes `config.auth` in
prod):

```ts
// src/server/index.ts — minimal-cloudflare
import { baerlyWorker, type BaerlyEnv } from "@gusto/baerly-storage/cloudflare";
import { cloudflareAccess } from "@gusto/baerly-storage/auth";
import config from "../../baerly.config.ts";

interface AppEnv extends BaerlyEnv {
  readonly CF_ACCESS_TEAM_DOMAIN?: string;
  readonly CF_ACCESS_AUDIENCE_TAG?: string;
}

export default baerlyWorker<AppEnv>((env) => ({
  config,
  ...(env.CF_ACCESS_TEAM_DOMAIN !== undefined &&
    env.CF_ACCESS_AUDIENCE_TAG !== undefined && {
      verifier: cloudflareAccess({
        teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
        audienceTag: env.CF_ACCESS_AUDIENCE_TAG,
      }),
    }),
}));
```

Set both env vars in `wrangler.jsonc:vars` for prod (they're public
identifiers, not secrets). Dev `wrangler dev` sees them as
`undefined`, the spread short-circuits, and `config.auth: "none"`
runs.

## Prod, Node target (Pattern C)

Use `bearerJwt({ jwks, issuer, audience })` against your OIDC
provider. The SPA acquires the token via your auth flow (Auth0,
Cognito, Okta, etc.) and sends `Authorization: Bearer <jwt>`. The
verifier validates against JWKS and pins the tenant from a claim.
The factory `verifier:` override engages only when `JWKS_URL` is
set, so dev (no env vars) keeps `config.auth: "none"`.

## `SHARED_SECRET` in prod

`sharedSecret()` is for **server-to-server** callers only — CI
jobs, scheduled-task runners, internal services. Never put the
token in a browser bundle, build-time env var, or static asset.
If the SPA needs to talk to the API in prod, use CF Access (CF)
or OIDC (Node). Do not ship `SHARED_SECRET` to the browser in any
form.
