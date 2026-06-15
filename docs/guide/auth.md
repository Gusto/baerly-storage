---
title: Authentication
audience: operator
summary: Production auth recipes for Cloudflare and Node, plus tenant pinning and authorization boundaries.
last-reviewed: 2026-06-13
tags: [auth, operations]
related: ["../adr/005-verifier-function-shape.md", "../adr/001-tenant-cas-isolation.md", "client-auth.md", "operations.md"]
---

# Authentication

Baerly auth has one job: decide whether a request may reach `/v1/*`,
and which tenant prefix that request is pinned to. The verifier returns
`{ tenantPrefix, identity }`; the HTTP adapter constructs
`Db.create({ tenant: tenantPrefix, ... })` from that result.

There are two configuration seams, in precedence order:

1. **`verifier:` on `baerlyWorker` / `baerlyNode`.** Use this for
   production. It can read runtime env and pick `cloudflareAccess`,
   `bearerJwt`, `sharedSecret`, or your own function.
2. **`config.auth` in `baerly.config.ts`.** Use this for the
   scaffold posture. `"none"` pins every request to `config.tenant`;
   `"shared-secret"` synthesizes `sharedSecret({ secret:
   env.SHARED_SECRET, tenantPrefix: config.tenant })`.

`auth: "none"` is for local dev and trusted internal callsites. Do
not deploy a public `/v1/*` route with it.

In production, fail closed: gate the `verifier:` override on an explicit
env var (e.g. `BAERLY_AUTH_REQUIRED=1`) so missing auth config throws at
startup instead of silently serving `auth: "none"`. Don't rely on
`NODE_ENV` or a hostname check. [client-auth.md](client-auth.md) shows
the full fail-closed pattern for both targets.

## Cloudflare Production

Preferred: put Cloudflare Access in front of the Worker and verify the
Access JWT inside the Worker.

```ts
// src/server/index.ts
import { baerlyWorker } from "@gusto/baerly-storage/cloudflare";
import type { BaerlyEnv } from "@gusto/baerly-storage/cloudflare";
import { cloudflareAccess } from "@gusto/baerly-storage/auth";
import config from "../../baerly.config.ts";

interface Env extends BaerlyEnv {
  CF_ACCESS_TEAM_DOMAIN: string;
  CF_ACCESS_AUDIENCE_TAG: string;
}

export default baerlyWorker<Env>((env) => ({
  config,
  verifier: cloudflareAccess({
    // teamDomain is the bare team SUBDOMAIN (e.g. "acme"), not a full
    // domain: the preset derives https://<teamDomain>.cloudflareaccess.com.
    teamDomain: env.CF_ACCESS_TEAM_DOMAIN,
    audienceTag: env.CF_ACCESS_AUDIENCE_TAG,
    tenantPrefix: config.tenant, // single-tenant app
  }),
}));
```

Checklist:

- Protect the data routes with Cloudflare Access. To keep
  `GET /v1/healthz` public, scope the Access policy to `/v1/c/*`,
  `/v1/count`, and `/v1/since` only — if Access fronts the whole
  hostname it challenges healthz before the Worker sees it (the Worker
  still treats healthz as anonymous).
- Set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUDIENCE_TAG` in
  `wrangler.jsonc:vars` or runtime env.
- Use `tenantPrefix: config.tenant` for single-tenant apps. Vanilla
  CF Access tokens carry user identity, not a Baerly tenant claim.
- Run `baerly doctor --target=cloudflare` before deploy.

Where values come from:

| Value | Source |
|---|---|
| `CF_ACCESS_TEAM_DOMAIN` | The Access team subdomain in `https://<team>.cloudflareaccess.com`; store only `<team>`. |
| `CF_ACCESS_AUDIENCE_TAG` | Cloudflare Zero Trust -> Access -> Applications -> your app -> Audience tag. |
| Access token | Browser: `CF_Authorization` cookie. Worker verifier input: `Cf-Access-Jwt-Assertion`, injected by Access after auth. Service-token check: `CF-Access-Client-Id` + `CF-Access-Client-Secret`. |

Verify fail-closed behavior:

```sh
baerly doctor --target=cloudflare

# Should be public and pre-auth only if your Access policy excludes
# /v1/healthz.
curl -fsS https://<worker-host>/v1/healthz

# Should fail without Cloudflare Access auth.
curl -i https://<worker-host>/v1/c/tickets

# Browser-authenticated check: use a captured CF_Authorization cookie
# from an Access login.
curl -fsS \
  -H "cookie: CF_Authorization=$CF_AUTHORIZATION_COOKIE" \
  https://<worker-host>/v1/c/tickets

# Service-token check: send the Access service credentials to
# Cloudflare; Access validates them and injects the JWT for the Worker.
curl -fsS \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  https://<worker-host>/v1/c/tickets
```

Shared secret is acceptable for service-to-service calls or a private
preview behind another gate:

```ts
// baerly.config.ts
import { defineConfig } from "@gusto/baerly-storage/config";

export default defineConfig({
  app: "tickets",
  tenant: "main",
  target: "cloudflare",
  auth: "shared-secret",
  collections: { tickets: {} },
});
```

Then set the secret with:

```sh
wrangler secret put SHARED_SECRET
baerly doctor --target=cloudflare
```

Never put `SHARED_SECRET` in a SPA bundle or a `VITE_*` variable. For
browser production auth, use Cloudflare Access or an OIDC/JWKS
verifier.

## Node Production

Preferred: verify bearer JWTs from your OIDC provider.

```ts
// src/server/index.ts
import { baerlyNode, s3Storage } from "@gusto/baerly-storage/node";
import { bearerJwt } from "@gusto/baerly-storage/auth";
import config from "../../baerly.config.ts";

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
  verifier: bearerJwt({
    jwks: process.env["JWKS_URL"]!,
    issuer: process.env["JWT_ISSUER"]!,
    audience: process.env["JWT_AUDIENCE"]!,
    tenantPrefix: config.tenant, // or tenantClaim: "tenant"
  }),
});

await handle.listen(Number(process.env["PORT"] ?? 8080));
```

Use `tenantClaim` when your IdP issues one tenant per token. Use
`tenantPrefix` when the app is single-tenant or tenancy is enforced
outside Baerly. They are mutually exclusive.

Required runtime env for the AWS S3 snippet:

| Env var | Purpose |
|---|---|
| `BUCKET` | AWS S3 bucket name. Use `r2Storage`, `minioStorage`, or `gcsStorage` with their own endpoint/env shape for other providers. |
| `AWS_REGION` | Bucket region; default in the snippet is `us-east-1`. |
| `AWS_ACCESS_KEY_ID` | S3-compatible access key. |
| `AWS_SECRET_ACCESS_KEY` | S3-compatible secret key. |
| `JWKS_URL` | OIDC JWKS endpoint. |
| `JWT_ISSUER` | Expected `iss` claim. |
| `JWT_AUDIENCE` | Expected `aud` claim. |

There is no `baerly doctor --target=node` backend today. For Node,
verify the bucket CAS prerequisite directly:

```sh
baerly doctor --bucket=s3://baerly-prod
curl -fsS https://<your-host>/v1/healthz

# Should fail without a bearer token.
curl -i https://<your-host>/v1/c/tickets

# Should succeed with a token from your IdP.
curl -fsS -H "Authorization: Bearer $JWT" \
  https://<your-host>/v1/c/tickets
```

## Verifier Presets

The full preset reference lives in
[`packages/server/API.md`](../../packages/server/API.md), published as
`node_modules/@gusto/baerly-storage/dist/API.md`, under "Verifier
presets". The short version:

| Preset | Header/source | Tenant source |
|---|---|---|
| `sharedSecret` | `Authorization: Bearer <secret>` | Required `tenantPrefix` |
| `bearerJwt` | `Authorization: Bearer <jwt>` over JWKS | `tenantClaim` or `tenantPrefix` |
| `cloudflareAccess` | `Cf-Access-Jwt-Assertion` | `tenantClaim` or `tenantPrefix` |

`tenantPrefix` must be non-empty and contain no `/`. Do not mutate it
after the verifier returns; it is the storage isolation boundary.

## Authorization Boundary

Baerly does not ship row-level authorization. Once a caller is
authenticated and pinned to a tenant, it can read and write any
collection under that tenant through `/v1/*`.

For finer policy, put a custom route in front of the kernel:

- run your own auth / ACL check;
- stamp trusted fields server-side;
- call `Db` directly for allowed writes;
- block direct client writes to protected collections before falling
  through to `baerlyWorker` / `baerlyNode`.

The trusted-fields recipe in
[`packages/server/API.md`](../../packages/server/API.md) shows that
pattern.
