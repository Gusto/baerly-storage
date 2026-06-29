---
title: Browser → server auth
audience: integrator
summary: Browser-to-server auth recipes for dev/prod Cloudflare and Node postures.
last-reviewed: 2026-06-28
tags: [client, auth, integration]
related: ["./auth.md"]
---

# Browser → server auth

> **Scope.** This guide owns the **browser → server** posture: why
> scaffolds default to `auth: "none"`, the dev→prod verifier flip, and
> the SPA-secret invariant. For the canonical **verifier preset
> reference and production verify recipes** (the operator's server-side
> view), see [auth.md](auth.md).

Browser clients call `/v1/*`; the server applies auth, chooses a
tenant prefix, then performs storage I/O. A tenant prefix is the
storage namespace baerly-storage will read and write under. A verifier
is the request-auth function that returns that prefix or rejects the
request. With `auth: "none"`, no `Authorization` header is required and
the prefix is `config.tenant`.

This guide explains how the scaffolds keep that path open in dev and
how production replaces the dev default with a real verifier. Scaffold
`AGENTS.md` files keep target-specific production variants next to
runnable code, but an integrator should not need to leave this guide to
understand the auth shape.

## Why every quadrant defaults to `auth: "none"`

New scaffolds need `/v1/*` to work before you choose an identity
provider. They avoid starter credentials because frontend `VITE_*`
values are public.

Concretely, all four scaffolds ship `auth: "none"` in
`baerly.config.ts`. A request with no `Authorization` header resolves
to `config.tenant`. That default is not a production auth story; it
keeps first run credential-free. Moving to prod is a deliberate
env-gated verifier, not a hidden credential that was present from the
beginning.

## Auth posture matrix

|           | Cloudflare target                                                                       | Node target                                                                              |
| --------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Dev**   | `auth: "none"` default. No bearer injection — SPA hits `/v1/*` plain.                  | `auth: "none"` default. No bearer injection — SPA hits `/v1/*` plain.                   |
| **Prod**  | **Pattern A** — `cloudflareAccess` verifier resolved from CF Access JWT assertion      | **Pattern C** — `bearerJwt` verifier over JWKS, token minted by your OIDC IdP            |
| **Shared-secret (services + dev)** | **Pattern B** — `auth: "shared-secret"` + `baerlyDevAuth` when browser dev calls need bearer injection | **Pattern B** — `auth: "shared-secret"` + process `SHARED_SECRET`; `baerlyDev({ secret })` can inject it during Vite dev |

Pattern A and Pattern C are the production browser-auth shapes: the
browser authenticates with a real IdP, and the server verifies the
result. Pattern B proves only possession of one shared string. Use it
for CI, internal services, or local dev plumbing. **Pattern B is never
for end-user browser auth in prod.**

## What changes at the dev→prod flip

In dev, the server can accept plain browser fetches because the
scaffold is intentionally single-tenant: `auth: "none"` pins every
request to `config.tenant`. In prod, the browser still does not receive
a baerly-storage secret. What changes is the server factory gets a
`verifier:`.

More precisely, `verifier:` on `baerlyWorker` or `baerlyNode` takes
precedence over `config.auth` when present. The safe recipe has three
parts:

- keep `auth: "none"` in `baerly.config.ts` for dev;
- create the `verifier:` only when the real auth env vars are present;
- set `BAERLY_AUTH_REQUIRED=1` in production and throw if those vars
  are missing.

`BAERLY_AUTH_REQUIRED` is an application-level guard in the snippets
below; the library does not read it for you. Same code artifact ships
to dev and prod, and the deploy environment decides whether fallback
to no auth is allowed.

Do not rely only on `NODE_ENV === "production"` or a hostname check.
Use a specific env var that causes the fail-closed behavior. Before
deploying, verify an unauthenticated `/v1/c/...` request fails.

## Pattern A: Cloudflare Access production

Protect the Worker route with Cloudflare Access. After a successful
Access login, Cloudflare sends the request on to the Worker with an
Access JWT assertion; `cloudflareAccess` verifies that assertion inside
the Worker. The browser does not add an `Authorization` header for
baerly-storage.

```ts
import { cloudflareAccess } from "@gusto/baerly-storage/auth";
import { baerlyWorker, type BaerlyEnv } from "@gusto/baerly-storage/cloudflare";
import config from "../../baerly.config.ts";

// Access vars stay optional so the same artifact type-checks in dev.
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
| `BAERLY_AUTH_REQUIRED` | Application env/var consumed by this snippet; set to `1` in production so missing Access env fails closed. |

**Verify** the deploy fails closed and authenticated requests succeed
with the curl recipe in
[auth.md → Cloudflare Production](auth.md#cloudflare-production):
`/v1/healthz`, an unauthenticated `/v1/c/*` that must fail closed, then a
cookie- or service-token-authenticated request that returns
`{ data, _meta }`. The health check is `200` only when your Access policy
excludes `/v1/healthz`; otherwise Access may challenge it before the
Worker sees it. The cookie value comes from an interactive Access login;
the client id/secret pair comes from an Access service token your policy
allows.

## Pattern C: Node JWKS production

For Node, the SPA sends its OIDC bearer token as
`Authorization: Bearer $JWT`. `bearerJwt` verifies signature, issuer,
and audience against JWKS, the provider's public key set, before
storage I/O.

```ts
import { bearerJwt } from "@gusto/baerly-storage/auth";
import { baerlyNode, s3Storage } from "@gusto/baerly-storage/node";
import config from "../../baerly.config.ts";

const jwksUrl = process.env["JWKS_URL"];
const jwtIssuer = process.env["JWT_ISSUER"];
const jwtAudience = process.env["JWT_AUDIENCE"];
const jwtReady =
  jwksUrl !== undefined && jwtIssuer !== undefined && jwtAudience !== undefined;

if (process.env["BAERLY_AUTH_REQUIRED"] === "1" && !jwtReady) {
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
  ...(jwtReady && {
    verifier: bearerJwt({
      jwks: jwksUrl,
      issuer: jwtIssuer,
      audience: jwtAudience,
      tenantPrefix: config.tenant,
    }),
  }),
});
```

Choose one tenant source. Keep `tenantPrefix: config.tenant` when the
app is single-tenant or tenancy is enforced outside baerly-storage.
Replace it with `tenantClaim: "<claim-name>"` when the token carries
the tenant. If you omit both `tenantPrefix` and `tenantClaim`,
`bearerJwt` reads the default `"tenant"` claim.

**Verify** with the Node curl recipe in
[auth.md → Node Production](auth.md#node-production): `baerly doctor
--bucket`, `/v1/healthz`, an unauthenticated `/v1/c/*` that must fail
closed, then a bearer-authenticated request.

## Pattern B: shared secret for dev and services

Shared-secret auth is for CI, internal services, and local dev
plumbing, not end-user browser production.

If a browser dev server needs to hit shared-secret-protected `/v1/*`,
inject the bearer server-side and keep the SPA's `fetch()` calls plain.
On Cloudflare Vite dev, use the focused `baerlyDevAuth` plugin. In
Node's all-in-one dev server, `baerlyDev({ secret })` performs the same
server-side injection while mounting `/v1/*`.

```ts
// baerly.config.ts
auth: "shared-secret", // flip from "none"
```

```ts
// vite.config.ts
import { baerlyDevAuth, loadDevVars } from "@gusto/baerly-storage/dev/vite";

const { SHARED_SECRET } = loadDevVars(".dev.vars", "SHARED_SECRET");

export default {
  plugins: [
    ...(SHARED_SECRET !== undefined
      ? [baerlyDevAuth({ secret: SHARED_SECRET })]
      : []),
  ],
};
```

The server or Worker reads `SHARED_SECRET`; the Vite plugin only adds
the matching bearer to browser dev requests.

Service verification:

```sh
curl -fsS -H "Authorization: Bearer $SHARED_SECRET" \
  https://<host>/v1/c/tickets
```

## The one invariant

A SPA bundle is public to its users. Any value placed in
`import.meta.env.*`, build-time env vars, or static assets can be
inspected after the page loads. Therefore: **Never put `SHARED_SECRET`
in the SPA bundle.**

The shared-secret posture is for server-to-server callers and dev
middleware only. For browser → server auth in prod, use Pattern A (CF)
or Pattern C (Node). The dev-mode Vite plugins inject the bearer
*server-side* so the SPA can keep plain `Authorization`-less `fetch()`
calls and the secret stays out of the bundle even during dev.

If a code review ever surfaces a `SHARED_SECRET` import in any
`src/web/**` file, that's a security defect, not a style issue —
the secret is now in every visitor's browser the moment the SPA
loads.

## Where scaffold-specific recipes live

Open the scaffold matching your target and posture; jump to the
"Going to production" section:

- Cloudflare + Pattern A or B: `examples/minimal-cloudflare/AGENTS.md` or `examples/react-cloudflare/AGENTS.md`.
- Node + Pattern B or C: `examples/minimal-node/AGENTS.md` or `examples/react-node/AGENTS.md`.

Those scaffold recipes stay byte-identical across paired scaffolds (the
drift fence in `tests/integration/agents-md-drift.test.ts` enforces
this) and give you a runnable starting point. They ship the minimal
verifier shape: the `verifier:` override is gated on the relevant
runtime env var being present, with no fail-closed throw. Cloudflare
examples check `env.CF_ACCESS_*`; Node examples check
`process.env["JWKS_URL"]`.

The `BAERLY_AUTH_REQUIRED=1` guard shown above is the production
hardening this guide recommends layering on top: it turns "auth env
missing" from a silent fallback to `auth: "none"` into a Node startup
error or Worker first-invocation error. Use these snippets as the
complete fail-closed verifier reference.
