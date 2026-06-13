---
title: Operations runbook
audience: operator
summary: Production preflight, auth, backup, observability, capacity, and route checks.
last-reviewed: 2026-06-12
tags: [operations, runbook, production]
related: [auth.md, backups.md, observability.md, "../about/graduation.md", "../about/cost-model.md"]
---

# Operations runbook

This is the production checklist for a Baerly app. It is intentionally
short; detailed recipes live in the linked guides.

## Preflight

For Cloudflare:

```sh
pnpm baerly doctor --target=cloudflare
pnpm baerly doctor --bucket=s3://<bucket-or-r2-s3-compat-uri>
curl -fsS https://<your-worker>/v1/healthz
```

For Node:

```sh
pnpm baerly doctor --bucket=s3://<bucket>
curl -fsS https://<your-host>/v1/healthz
```

There is no `baerly doctor --target=node` backend today. The bucket
probe is the portable safety check: it verifies the backend honors
`If-Match` and `If-None-Match: "*"`, which the protocol requires.

## Auth

Use `auth: "none"` only for local development or trusted internal
code paths. Production `/v1/*` routes need a verifier:

| Target | Production default |
|---|---|
| Cloudflare | `cloudflareAccess({ teamDomain, audienceTag, tenantPrefix })` |
| Node | `bearerJwt({ jwks, issuer, audience, tenantClaim })` or fixed `tenantPrefix` |
| Service-to-service | `sharedSecret({ secret, tenantPrefix })` |

Never ship `SHARED_SECRET` to a browser bundle. For details and code
blocks, see [auth.md](auth.md) and [client-auth.md](client-auth.md).

## Backups

Run `baerly admin dump` on every production collection and store the
result off-host:

```sh
pnpm baerly admin dump \
  --bucket=s3://baerly-prod \
  --app=<app> \
  --tenant=<tenant> \
  --collection=<collection> \
  > <dated>.ndjson
```

Use temp files, `0600` permissions, checksum sidecars, and a restore
drill. The hardened script and restore commands are in
[backups.md](backups.md).

## Observability

At minimum, collect the canonical JSON log line and alert on:

| Signal | Why it matters | First action |
|---|---|---|
| 5xx rate or `outcome:"error"` | User-visible API failure | Inspect `error.code` and storage status. |
| `db.r2.put.412_total` sustained | CAS contention | Check writes/min per collection; consider graduation. |
| `db.compaction.deferred_total` | Snapshot over fold ceiling | Read [graduation.md](../about/graduation.md); raise cap only on a host that can fold it. |
| Class A ops spike | Cost regression or hot write path | Run `baerly cost --bucket=<bucket-uri> --collection=<collection>`; inspect write amp. |
| Object count growing while writes are steady | GC not draining or contention above envelope | Run `admin fsck`; inspect maintenance logs. |

Sink wiring and field reference are in
[observability.md](observability.md) and
[`dist/API.md`](../../packages/server/API.md) -> "Observability".

## Capacity

The design envelope is:

- roughly 30 sustained logical writes/min/collection;
- roughly 10 GB/tenant;
- roughly 100 collections/tenant.

For Node/self-hosted buckets, run:

```sh
pnpm baerly admin usage \
  --target=node \
  --bucket=s3://baerly-prod \
  --app=<app> \
  --tenant=<tenant>
```

Cloudflare usage scanning is not wired yet from the Node CLI because
the CLI cannot reach a Workers R2 binding directly. Use canonical logs
for trend history and `baerly cost --bucket=<bucket-uri>
--collection=<collection>` for current operation-cost projection when
you have R2 S3-compatible credentials.

Graduation thresholds and the fold-cost derivation live in
[graduation.md](../about/graduation.md). Cost math lives in
[cost-model.md](../about/cost-model.md).

## Route Quick Reference

| Route | Meaning |
|---|---|
| `GET /v1/healthz` | Anonymous liveness check. |
| `GET /v1/c/:collection` | List rows; accepts JSON-encoded `where`, `order`, `limit`. |
| `GET /v1/c/:collection/:id` | Read one row. |
| `POST /v1/c/:collection` | Insert one row. |
| `PATCH /v1/c/:collection/:id` | Merge-patch one row. |
| `PUT /v1/c/:collection/:id` | Replace one row. |
| `DELETE /v1/c/:collection/:id` | Delete one row. |
| `GET /v1/since?collection=<name>&cursor=<opaque>` | Long-poll change feed. |
