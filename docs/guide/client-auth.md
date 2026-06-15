---
title: Browser → server auth
audience: integrator
summary: Browser-to-server auth recipes and the four dev/prod × Cloudflare/Node postures.
last-reviewed: 2026-06-13
tags: [client, auth, integration]
related: ["./auth.md", "../adr/005-verifier-function-shape.md"]
---

# Browser → server auth

baerly's design center is "trusted multi-instance, browser is a
typed HTTP client." The browser sends `/v1/*` HTTP requests; the
server runs the verifier and pins the tenant. This page gives the
minimal production recipes and explains why the four quadrants share
one seam. Scaffold `AGENTS.md` files keep target-specific production
variants next to runnable code, but an integrator should not need to
leave this guide to understand the auth shape.

## Why every quadrant defaults to `auth: "none"`

The scaffolds ship `auth: "none"` in `baerly.config.ts` so day-1
hits `/v1/*` with no `Authorization` header and every request
resolves to `config.tenant`. This is the same default across all
four quadrants for one structural reason: the most common
beginner failure mode in this category is "paste `SHARED_SECRET`
into a `VITE_*` env var thinking the leading `VITE_` makes it
private." A non-zero default credential at scaffold time invites
that mistake. `auth: "none"` makes the first happy path work
without any credential at all; the dev→prod transition is then a
deliberate flip rather than an undefended initial state.

## The four-quadrant matrix

|           | Cloudflare target                                                                       | Node target                                                                              |
| --------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Dev**   | `auth: "none"` default. No bearer injection — SPA hits `/v1/*` plain.                  | `auth: "none"` default. No bearer injection — SPA hits `/v1/*` plain.                   |
| **Prod**  | **Pattern A** — `cloudflareAccess` verifier resolved from CF Access JWT cookie         | **Pattern C** — `bearerJwt` verifier over JWKS, token minted by your OIDC IdP            |
| **Shared-secret (either + dev)** | **Pattern B** — `auth: "shared-secret"` + `baerlyDevAuth` in `vite.config.ts` for browser calls | **Pattern B** — `auth: "shared-secret"` + `SHARED_SECRET` in `.env` |

Pattern A and Pattern C are the production-fit shapes — they take a
real identity from a real IdP. Pattern B is the server-to-server
shape (CI and internal services) and the only shape where dev
needs a special Vite plugin (`baerlyDevAuth`) to inject the bearer
server-side for browser calls. **Pattern B is never for end-user
browser auth in prod.**

## Pattern A: Cloudflare Access production

Protect the Worker route with Cloudflare Access, then verify the
Access JWT inside the Worker. The browser does not add an
`Authorization` header; Cloudflare Access sets the cookie/header before
the request reaches the Worker.

```ts
import { cloudflareAccess } from "@gusto/baerly-storage/auth";
import { baerlyWorker, type BaerlyEnv } from "@gusto/baerly-storage/cloudflare";
import config from "../../baerly.config.ts";

// Extends BaerlyEnv (carries the required BUCKET/APP bindings); the
// Access vars are optional so the dev artifact type-checks with them
// unset.
interface AppEnv extends BaerlyEnv {
  readonly CF_ACCESS_TEAM_DOMAIN?: string;
  readonly CF_ACCESS_AUDIENCE_TAG?: string;
  readonly BAERLY_AUTH_REQUIRED?: string;
}

export default baerlyWorker<AppEnv>((env) => {
  const accessReady =
    env.CF_ACCESS_TEAM_DOMAIN !== undefined &&
    env.CF_ACCESS_AUDIENCE_TAG !== undefined;
  if (env.BAERLY_AUTH_REQUIRED === "1" && !accessReady) {
    throw new Error("Cloudflare Access env is required in production");
  }
  return {
    config,
    ...(accessReady && {
      verifier: cloudflareAccess({
        // teamDomain is the bare team SUBDOMAIN (e.g. "acme"), not a full
        // domain: the preset derives https://<teamDomain>.cloudflareaccess.com.
        teamDomain: env.CF_ACCESS_TEAM_DOMAIN!,
        audienceTag: env.CF_ACCESS_AUDIENCE_TAG!,
        tenantPrefix: config.tenant,
      }),
    }),
  };
});
```

Set:

| Value | Where |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | Worker env/vars; the bare `<team>` part of `https://<team>.cloudflareaccess.com`. |
| `CF_ACCESS_AUDIENCE_TAG` | Worker env/vars; Cloudflare Access application audience tag. |
| `BAERLY_AUTH_REQUIRED` | Set to `1` in production so missing Access env fails closed. |

Verify:

```sh
curl -fsS https://<worker-host>/v1/healthz
curl -i https://<worker-host>/v1/c/tickets
curl -fsS -H "cookie: CF_Authorization=$CF_AUTHORIZATION_COOKIE" \
  https://<worker-host>/v1/c/tickets
curl -fsS \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  https://<worker-host>/v1/c/tickets
```

The health check is `200` only when your Access policy excludes
`/v1/healthz`; otherwise Cloudflare Access may challenge it before the
Worker sees it. The unauthenticated collection request should fail
closed. The cookie and service-token requests should return
`{ data, _meta }`.

## Pattern C: Node JWKS production

Your SPA obtains a bearer token from the same OIDC provider the rest of
your app uses. The Baerly server verifies that token over JWKS.

```ts
import { bearerJwt } from "@gusto/baerly-storage/auth";
import { baerlyNode, s3Storage } from "@gusto/baerly-storage/node";
import config from "../../baerly.config.ts";

if (
  process.env["BAERLY_AUTH_REQUIRED"] === "1" &&
  (process.env["JWKS_URL"] === undefined ||
    process.env["JWT_ISSUER"] === undefined ||
    process.env["JWT_AUDIENCE"] === undefined)
) {
  throw new Error("JWKS_URL, JWT_ISSUER, and JWT_AUDIENCE are required in production");
}

const handle = baerlyNode({
  config,
  storage: s3Storage({
    bucket: process.env["BUCKET"]!,
    region: process.env["AWS_REGION"] ?? "us-east-1",
    credentials: {
      accessKeyId: process.env["AWS_ACCESS_KEY_ID"]!,
      secretAccessKey: process.env["AWS_SECRET_ACCESS_KEY"]!,
    },
  }),
  // Keep `auth: "none"` in baerly.config.ts for dev. In production set
  // BAERLY_AUTH_REQUIRED=1 so missing JWKS env fails closed.
  ...(process.env["JWKS_URL"] !== undefined && {
    verifier: bearerJwt({
      jwks: process.env["JWKS_URL"],
      issuer: process.env["JWT_ISSUER"]!,
      audience: process.env["JWT_AUDIENCE"]!,
      tenantPrefix: config.tenant,
    }),
  }),
});
```

Use `tenantClaim: "tenant"` instead when your IdP issues one tenant
per token.

```sh
baerly doctor --bucket=s3://<bucket>
curl -fsS https://<node-host>/v1/healthz
curl -i https://<node-host>/v1/c/tickets
curl -fsS -H "Authorization: Bearer $JWT" \
  https://<node-host>/v1/c/tickets
```

## Pattern B: shared secret for dev and services

Shared secret is for server-to-server calls and local development,
not end-user browser production. If a browser dev server needs to hit
shared-secret-protected `/v1/*`, inject the bearer server-side with the
Vite plugin; never expose `SHARED_SECRET` through `VITE_*`.

```ts
// vite.config.ts
import { baerlyDevAuth } from "@gusto/baerly-storage/dev/vite";

export default {
  plugins: [
    baerlyDevAuth({
      secret: process.env["SHARED_SECRET"] ?? "dev-shared-secret",
    }),
  ],
};
```

Service verification:

```sh
curl -fsS -H "Authorization: Bearer $SHARED_SECRET" \
  https://<host>/v1/c/tickets
```

## What changes at the dev→prod flip

The Cloudflare and Node targets handle the transition with the same
mechanism: the factory `verifier:` argument overrides `config.auth`
when present. The safe recipe shape: keep `auth: "none"` in
`baerly.config.ts` for dev, gate the `verifier:` override on the real
auth env var, and set `BAERLY_AUTH_REQUIRED=1` in production so missing
auth env throws instead of falling back to no auth. Same code artifact
ships to dev and prod; the deploy environment decides whether the
fallback is allowed.

Do not rely only on `NODE_ENV === "production"` or a hostname check.
Use a specific env var that *causes* the fail-closed behavior, then run
the negative curl before deploy.

## The one invariant

**Never put `SHARED_SECRET` in the SPA bundle**, in
`import.meta.env.*`, in build-time env vars, or in static assets.
The shared-secret posture is for server-to-server callers only.
For browser → server auth in prod, use Pattern A (CF) or Pattern C
(Node). The dev-mode `baerlyDevAuth` plugin injects the bearer
*server-side* in the Vite middleware specifically so the SPA can
keep its plain `Authorization`-less `fetch()` calls and the secret
stays out of the bundle even during dev.

If a code review ever surfaces a `SHARED_SECRET` import in any
`src/web/**` file, that's a security defect, not a style issue —
the secret is now in every visitor's browser the moment the SPA
loads.

## Where scaffold-specific recipes live

Open the scaffold matching your target and posture; jump to the
"Going to production" section:

- Cloudflare + Pattern A or B: `examples/minimal-cloudflare/AGENTS.md` or `examples/react-cloudflare/AGENTS.md`.
- Node + Pattern B or C: `examples/minimal-node/AGENTS.md` or `examples/react-node/AGENTS.md`.

The recipes are hardened against real agent usage and stay byte-
identical across paired scaffolds (the drift fence in
`tests/integration/agents-md-drift.test.ts` enforces this). Read
those for code; read this file when you need to understand *why*
the seam is shaped this way before making a non-default decision.
