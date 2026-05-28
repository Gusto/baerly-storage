---
title: Authentication
audience: operator
summary: The `config.auth` graduated postures and the no-built-in-authorization caveat. Preset reference and Verifier-shape rationale live elsewhere.
last-reviewed: 2026-05-28
tags: [auth, operations]
related: ["../adr/005-verifier-function-shape.md", "../adr/001-tenant-cas-isolation.md", "client-auth.md"]
---

# Authentication

baerly has two seams for configuring auth, in this order of
precedence:

- **`verifier:` on the adapter factory** — a `Verifier` value
  overrides everything else and is the seam each scaffold's
  `AGENTS.md` → "Going to production" uses for env-aware dev/prod.
- **`config.auth` in `baerly.config.ts`** — the graduated posture
  the adapter synthesizes a verifier from when no override is
  present. Values today: `"none"` (no header check; pins to
  `config.tenant`) and `"shared-secret"` (reads `SHARED_SECRET`
  from the runtime env).

Scaffolds default to `auth: "none"` so day-1 happy path works with
zero env vars. `baerly doctor --target=<cloudflare|node>` warns on
`"none"` for deploy targets, FAILs on `"shared-secret"` without
`SHARED_SECRET` reachable from the runtime env.

## Verifier presets

The three shipped presets (`sharedSecret`, `bearerJwt`,
`cloudflareAccess`) and the `tenantPrefix:` pinning option are
canonically documented in
[`dist/API.md`](../../packages/server/API.md) → "Verifier presets".
Read that first.

## Why a function?

The Verifier shape's three properties and four rejected alternatives
are in [ADR-005](../adr/005-verifier-function-shape.md).

## Browser callers

See [client-auth.md](./client-auth.md) for the SPA recipe — dev
proxy in dev, CF Access / OIDC in prod, never `SHARED_SECRET` in
the bundle.

## Authorization

Beyond tenant pinning, there is no built-in authorization — an
authenticated caller can read and write anything under their tenant
prefix, including the manifest. Use-cases that need finer policy
(per-collection ACLs, row-level rules, manifest-change validation)
wrap the adapter `fetch` in a server they control and enforce policy
before passthrough. If you're using S3 + IAM directly, scope STS
tokens to a sub-path per user/team.
