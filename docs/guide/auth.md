---
title: Authentication
audience: operator
summary: Production auth recipes for Cloudflare and Node, plus tenant pinning and authorization boundaries.
last-reviewed: 2026-07-02
tags: [auth, operations]
related: ["../adr/001-tenant-cas-isolation.md", "client-auth.md", "operations.md"]
---

# Authentication

> **Scope.** This is the canonical reference for **server-side verifier
> configuration and production verification** — the operator's view. For
> the **browser → server** posture (dev defaults, the dev→prod flip, and
> the SPA-secret invariant), see [client-auth.md](client-auth.md).

For data routes (`/v1/c/*`, `/v1/count`, and `/v1/since`), auth runs
before storage I/O. It answers two questions: is this request accepted,
and which tenant prefix may the request use? A tenant prefix is the
storage namespace for the request. Once the verifier returns it, the
adapter constructs `Db.create({ tenant: tenantPrefix, ... })`, so every
later read and write lands under that prefix.

A `Verifier` is the async function that makes that decision:
`(req: Request) => Promise<VerifierResult | null>`. The dispatcher
invokes it exactly once per request, before any `Storage` I/O. There is
no middleware chain and no later auth decision inside the dispatcher.

It returns `{ tenantPrefix, identity }` for accepted requests, `null`
for unauthenticated requests (HTTP 401 +
`BaerlyError{code:"Unauthorized"}`), or throws `BaerlyError` for broken
auth configuration or dependencies (500 operator fault). That
null-vs-throw split keeps credential-fishing traffic from being
reported as operator faults. The kernel treats `identity` as opaque; it
uses `tenantPrefix` for isolation and does not turn identity claims into
row-level permissions. The `tenantPrefix` derives from auth, never from
the URL — a URL-encoded tenant would be a forgery surface (see
[ADR-001](../adr/001-tenant-cas-isolation.md)).

The function shape is deliberate: class hierarchies tree-shake worse;
middleware assumes per-request state the stateless server does not keep;
a closed enum would force every new scheme through the kernel's release
cycle. It is async so JWKS / SigV4 / RPC presets need no workaround.
The kernel leaves multi-verifier composition to deployments; user-space
`firstOf` / `allOf` sugar can compose later without kernel policy.

Auth config resolves in this order:

1. **`verifier:` on `baerlyWorker` / `baerlyNode`.** Use this for
   production. It can read runtime env and pick `cloudflareAccess`,
   `bearerJwt`, `sharedSecret`, or your own function.
2. **`config.auth` in `baerly.config.ts`.** Use this for the
   generated app's default or fallback config. `"none"` pins every
   request to `config.tenant`; `"shared-secret"` reads `SHARED_SECRET`
   from runtime env and synthesizes `sharedSecret({ secret,
   tenantPrefix: config.tenant })`.

`auth: "none"` is for local dev and trusted internal callsites. Do
not deploy a public data route with it.

In production, fail closed: read required auth env before constructing
the verifier, so missing config throws instead of serving
`auth: "none"`. If one artifact runs in dev and prod, gate verifier
setup on an explicit env var (e.g. `BAERLY_AUTH_REQUIRED=1`). Do not
rely on `NODE_ENV` or a hostname check. [client-auth.md](client-auth.md)
shows that full pattern for both targets.

## Cloudflare Production

Preferred: use Cloudflare Access in front of the Worker; the verifier
checks the injected JWT assertion before storage I/O.

```ts
// src/server/index.ts
import { baerlyWorker } from "@gusto/baerly-storage/cloudflare";
import type { BaerlyEnv } from "@gusto/baerly-storage/cloudflare";
import { cloudflareAccess } from "@gusto/baerly-storage/auth";
import config from "../../baerly.config.ts";

interface Env extends BaerlyEnv {
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUDIENCE_TAG?: string;
}

const requiredEnv = (value: string | undefined, name: string): string => {
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
};

export default baerlyWorker<Env>((env) => {
  const teamDomain = requiredEnv(
    env.CF_ACCESS_TEAM_DOMAIN,
    "CF_ACCESS_TEAM_DOMAIN",
  );
  const audienceTag = requiredEnv(
    env.CF_ACCESS_AUDIENCE_TAG,
    "CF_ACCESS_AUDIENCE_TAG",
  );
  return {
    config,
    verifier: cloudflareAccess({
      // teamDomain is the bare team SUBDOMAIN (e.g. "acme"), not a full
      // domain: the preset derives https://<teamDomain>.cloudflareaccess.com.
      teamDomain,
      audienceTag,
      tenantPrefix: config.tenant, // single-tenant app
    }),
  };
});
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
  CF Access tokens carry user identity, not a baerly-storage tenant claim.
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

# Should be public only if your Access policy excludes /v1/healthz.
curl -fsS https://<worker-host>/v1/healthz

# Should fail without Cloudflare Access auth.
curl -i https://<worker-host>/v1/c/tickets

# Browser-authenticated check: use a captured CF_Authorization cookie
# from an Access login.
curl -fsS \
  -H "cookie: CF_Authorization=$CF_AUTHORIZATION_COOKIE" \
  https://<worker-host>/v1/c/tickets

# Service-token check: send credentials for a service token allowed by
# the Access policy. Access validates them and injects the JWT for
# the Worker.
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

Set the secret:

```sh
wrangler secret put SHARED_SECRET
baerly doctor --target=cloudflare
```

Never put `SHARED_SECRET` in a SPA bundle or a `VITE_*` variable. For
browser production auth, use Cloudflare Access or an OIDC/JWKS
verifier.

## Node Production

Preferred: use bearer JWTs from your OIDC provider; the Node server
verifies them before storage I/O.

```ts
// src/server/index.ts
import { baerlyNode, s3Storage } from "@gusto/baerly-storage/node";
import { bearerJwt } from "@gusto/baerly-storage/auth";
import config from "../../baerly.config.ts";

const requiredEnv = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const handle = baerlyNode({
  config,
  storage: s3Storage({
    bucket: requiredEnv("BUCKET"),
    region: process.env["AWS_REGION"] ?? "us-east-1",
    credentials: {
      accessKeyId: requiredEnv("AWS_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("AWS_SECRET_ACCESS_KEY"),
    },
  }),
  verifier: bearerJwt({
    jwks: requiredEnv("JWKS_URL"),
    issuer: requiredEnv("JWT_ISSUER"),
    audience: requiredEnv("JWT_AUDIENCE"),
    tenantPrefix: config.tenant, // or tenantClaim: "tenant"
  }),
});

await handle.listen(Number(process.env["PORT"] ?? 8080));
```

Use `tenantClaim` when your IdP issues one tenant per token; use
`tenantPrefix` when the app is single-tenant or tenancy is enforced
outside baerly-storage. They are mutually exclusive.

Required runtime env for the AWS S3 snippet:

| Env var | Purpose |
|---|---|
| `BUCKET` | AWS S3 bucket name. Use `r2Storage` for Cloudflare R2. MinIO is a local/dev conformance target; GCS S3-interop is unsupported for database use today. |
| `AWS_REGION` | Bucket region; default in the snippet is `us-east-1`. |
| `AWS_ACCESS_KEY_ID` | S3-compatible access key. |
| `AWS_SECRET_ACCESS_KEY` | S3-compatible secret key. |
| `JWKS_URL` | OIDC JWKS endpoint. |
| `JWT_ISSUER` | Expected `iss` claim. |
| `JWT_AUDIENCE` | Expected `aud` claim. |

There is no `baerly doctor --target=node` backend today. For Node,
verify the bucket CAS (compare-and-swap) prerequisite directly:

```sh
baerly doctor --bucket=s3://<bucket>
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

When supplied, fixed `tenantPrefix` must be non-empty and contain no
`/`; claim-derived tenant values must also be non-empty and `/`-free
or the verifier rejects the request. Do not mutate the verifier result
after it returns; the tenant prefix is the storage isolation boundary.

## Authorization Boundary

Do not treat authentication as row-level authorization. baerly-storage
authentication chooses a tenant. Once a caller is authenticated and
pinned to a tenant, it can read and write any collection under that
tenant through `/v1/*`.

For finer policy, intercept protected collection routes before they
reach `baerlyWorker` / `baerlyNode`:

- run your own auth and ACL check;
- stamp trusted fields server-side;
- call `Db` directly for allowed writes;
- block direct client writes to protected collections before falling
  through to the default `/v1/*` handler.

Reads are symmetric — and easy to overlook. `GET /v1/c/:collection`
returns the **entire collection** unless you constrain it: there is no
default row cap, and an authenticated non-owner sees every row under the
tenant. Two consequences for your interceptor:

- **Scope the rows.** Inject a predicate keyed to the verified identity
  (`where owner_id = <verified sub>`) before delegating. Prefer a
  predicate that hits a declared index — the engine then resolves
  matched rows via an index walk instead of folding the whole
  collection. A bare `?limit` clamp only bounds what is returned: the
  engine still folds the whole collection into memory before applying
  the limit, so a limit alone caps exposure but not read cost.
- **Do not reject `?limit` to "force" a cap.** It backfires — a request
  with no `?limit` takes the *uncapped* path and returns everything.
  Clamp instead: `limit = min(requested ?? MAX, MAX)`.

The trusted-fields recipe in
[`packages/server/API.md`](../../packages/server/API.md) shows the
write half of this pattern.
