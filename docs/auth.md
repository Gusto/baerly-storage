---
title: Authentication
audience: operator
summary: "Built-in Verifier presets (shared secret, bearer JWT, CF Access, AWS SigV4, IP allowlist), tenant pinning, and the authorization caveat."
last-reviewed: 2026-05-13
tags: [auth, operations]
related: ["adr/0014-auth-verifier-interface.md", "adr/0018-tenant-cas-isolation.md", "extending.md"]
---

# Authentication

`@baerly/server/auth` ships five `Verifier` presets. Each one
authenticates the caller and returns a `tenantPrefix`, which the
server uses to pin the request to one tenant's keyspace.

- `sharedSecret` — `Authorization: Bearer <secret>` with
  constant-time compare. Single-tenant; the simplest preset to
  stand up.
- `bearerJwt` — JWT over JWKS with `iss` / `aud` / `alg` allowlist;
  reads the tenant from a configurable claim.
- `cloudflareAccess` — thin shim over `bearerJwt` that consumes
  CF Access's `Cf-Access-Jwt-Assertion` header.
- `awsIamSigV4` — verifies SigV4-signed requests against a list of
  IAM principals; each principal pins one tenant.
- `allowlistIp` — CIDR-based source-IP allowlist for use behind a
  trusted proxy. Compose with `sharedSecret` / `bearerJwt` via
  `andAll` for defense in depth.

Source:
[`packages/server/src/auth/presets/`](../packages/server/src/auth/presets/).
Design rationale:
[ADR-0014](adr/0014-auth-verifier-interface.md).

## Authorization

Beyond tenant pinning, there is no built-in authorization — an
authenticated caller can read and write anything under their
tenant prefix, including the manifest. Use-cases that need finer
policy (per-collection ACLs, row-level rules, manifest-change
validation) wrap `createListener` in a server they control and
enforce policy before passthrough. If you're using S3 + IAM
directly, scope STS tokens to a sub-path per user/team.
