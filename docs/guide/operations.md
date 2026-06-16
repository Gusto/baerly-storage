---
title: Operations runbook
audience: operator
summary: Production preflight, auth, backup, observability, capacity, and route checks.
last-reviewed: 2026-06-13
tags: [operations, runbook, production]
related: [auth.md, backups.md, observability.md, "../about/graduation.md", "../about/cost-model.md"]
---

# Operations runbook

This is the production checklist for a Baerly app. Fill these in once
and keep the same values through every command:

```sh
APP=acme
TENANT=main
BUCKET_URI=s3://baerly-prod
COLLECTION=tickets
BASE_URL=https://api.example.com
```

## Before first deploy

### Bucket and deploy checks

Run the target-specific deploy check, then the portable bucket check.
`baerly doctor --bucket` writes and deletes a throwaway sentinel to
prove the bucket honors `If-Match` and `If-None-Match: "*"`, which the
protocol requires.

The bucket probe validates storage semantics only; it does not migrate
or validate an existing Baerly prefix. Buckets written by the old
pre-single-write `current.json` schema must be dumped under the old
build and restored/reseeded under the current schema (`schema_version:
3`), not reused in place.

```sh
# Cloudflare only: wrangler config, R2 binding, secrets, Access shape.
baerly doctor --target=cloudflare

# All targets: live CAS probe against the production bucket.
baerly doctor --bucket="$BUCKET_URI"
```

There is no `baerly doctor --target=node` backend today; the bucket
probe is the Node safety check.

### Auth

Then verify HTTP behavior. `GET /v1/healthz` is anonymous inside the
Baerly adapter; if an outer Cloudflare Access policy protects the whole
hostname, Access may challenge it before the Worker sees it.

```sh
curl -fsS "$BASE_URL/v1/healthz"

# Must fail closed without production auth.
curl -i "$BASE_URL/v1/c/$COLLECTION"

# Shared-secret / generic bearer verifier.
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/v1/c/$COLLECTION"

# Cloudflare Access service token verifier.
curl -fsS \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  "$BASE_URL/v1/c/$COLLECTION"
```

Use `auth: "none"` only for local development or trusted internal
code paths. Production `/v1/*` routes need one of:

| Target             | Production default                                                           |
| ------------------ | ---------------------------------------------------------------------------- |
| Cloudflare         | `cloudflareAccess({ teamDomain, audienceTag, tenantPrefix })`                |
| Node               | `bearerJwt({ jwks, issuer, audience, tenantClaim })` or fixed `tenantPrefix` |
| Service-to-service | `sharedSecret({ secret, tenantPrefix })`                                     |

Never ship `SHARED_SECRET` to a browser bundle. Full recipes are in
[auth.md](auth.md) and [client-auth.md](client-auth.md).

## Backups

Run `baerly admin dump` for every production collection and store the
result off-host. The default is the hardened wrapper in
[backups.md](backups.md): root-readable env file, temp file plus atomic
rename, `0600` files, SHA-256 sidecar, off-host retention, and restore
drill.

Use the direct command only for one-off manual dumps:

```sh
baerly admin dump \
  --bucket="$BUCKET_URI" \
  --app="$APP" \
  --tenant="$TENANT" \
  --collection="$COLLECTION" \
  > "$COLLECTION.ndjson"
```

## Weekly checks

```sh
baerly inspect \
  --bucket="$BUCKET_URI" \
  --app="$APP" \
  --tenant="$TENANT" \
  --collection="$COLLECTION"

baerly cost \
  --bucket="$BUCKET_URI" \
  --app="$APP" \
  --tenant="$TENANT" \
  --collection="$COLLECTION"

baerly admin fsck \
  --bucket="$BUCKET_URI" \
  --app="$APP" \
  --tenant="$TENANT" \
  --collection="$COLLECTION"
```

For Node/self-hosted buckets, also run the all-collection writes/min
scan:

```sh
baerly admin usage \
  --target=node \
  --bucket="$BUCKET_URI" \
  --app="$APP" \
  --tenant="$TENANT"
```

Cloudflare usage scanning is not wired yet from the Node CLI because
the CLI cannot reach a Workers R2 binding directly. Use canonical logs
for trend history and `baerly cost` with R2 S3-compatible credentials
for current operation-cost projection.

## Incidents

At minimum, collect the canonical JSON log line and alert on:

| Signal                                       | Why it matters                               | First action                                                                                                                                                                                                                                                                 |
| -------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5xx rate or `outcome:"error"`                | User-visible API failure                     | Filter logs by `error.code`; check bucket auth, S3 status, and recent deploys. Run the healthz and authenticated collection curls above.                                                                                                                                     |
| `db.r2.put.412_total` sustained              | Conditional-write contention                 | Check writes/min for `$COLLECTION`; add app-edge retry for bursts, split hot collections if possible, graduate if sustained.                                                                                                                                                 |
| `db.compaction.deferred_total`               | Snapshot over fold ceiling                   | Read the rate-limited `console.warn`; it names whether bytes or rows tripped. Run `baerly inspect` for `live_log_tail`, `materialised_rows`, and snapshot key. Raise `BAERLY_MAINTENANCE_MAX_FOLD_BYTES` only on paid CF / Node with enough memory, otherwise graduate tier. |
| Class A ops spike                            | Cost regression or hot write path            | Run `baerly cost`; inspect write amp, index count, retries, and compaction CAS losses.                                                                                                                                                                                       |
| Object count growing while writes are steady | GC not draining or contention above envelope | Run `baerly admin fsck`; inspect `db.compaction.cas_lost_total`, deferred warnings, and write contention.                                                                                                                                                                    |

Sink wiring and field reference are in
[observability.md](observability.md) and
[`packages/server/API.md`](../../packages/server/API.md), published as
`node_modules/@gusto/baerly-storage/dist/API.md`, under "Observability".

## Capacity

The design envelope — cross any one of these and it's the signal to
graduate, not a hard quota:

- roughly 30 sustained logical writes/min per collection;
- roughly 10 GB per tenant;
- roughly 100 collections per tenant.

Graduation thresholds and the fold-cost derivation live in
[graduation.md](../about/graduation.md); cost math lives in
[cost-model.md](../about/cost-model.md).

## Route quick reference

| Route                                             | Meaning                                                    |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `GET /v1/healthz`                                 | Anonymous liveness check.                                  |
| `GET /v1/c/:collection`                           | List rows; accepts JSON-encoded `where`, `order`, `limit`. |
| `GET /v1/c/:collection/:id`                       | Read one row.                                              |
| `POST /v1/c/:collection`                          | Insert one row.                                            |
| `PATCH /v1/c/:collection/:id`                     | Merge-patch one row.                                       |
| `PUT /v1/c/:collection/:id`                       | Replace one row.                                           |
| `DELETE /v1/c/:collection/:id`                    | Delete one row.                                            |
| `GET /v1/count?collection=<name>&where=<json>`    | Count matching rows.                                       |
| `GET /v1/since?collection=<name>&cursor=<opaque>` | Long-poll change feed.                                     |
