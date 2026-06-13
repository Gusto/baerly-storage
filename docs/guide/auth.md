---
title: Authentication
audience: operator
summary: Production auth recipes for Cloudflare and Node, plus tenant pinning and authorization boundaries.
last-reviewed: 2026-06-12
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

- Protect the Worker route with Cloudflare Access.
- Set `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUDIENCE_TAG` in
  `wrangler.jsonc:vars` or runtime env.
- Use `tenantPrefix: config.tenant` for single-tenant apps. Vanilla
  CF Access tokens carry user identity, not a Baerly tenant claim.
- Run `pnpm baerly doctor --target=cloudflare` before deploy.

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
pnpm baerly doctor --target=cloudflare
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

There is no `baerly doctor --target=node` backend today. For Node,
verify the bucket CAS prerequisite directly:

```sh
pnpm baerly doctor --bucket=s3://baerly-prod
curl -fsS https://<your-host>/v1/healthz
```

## Verifier Presets

The full preset reference lives in
[`dist/API.md`](../../packages/server/API.md) -> "Verifier presets".
The short version:

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
[`dist/API.md`](../../packages/server/API.md) shows that pattern.
