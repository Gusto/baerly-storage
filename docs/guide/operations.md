---
title: Operations runbook
audience: operator
summary: Production preflight, auth, backup, observability, capacity, and route checks.
last-reviewed: 2026-06-30
tags: [operations, runbook, production]
related: [auth.md, backups.md, observability.md, "../about/graduation.md", "../about/cost-model.md"]
---

# Operations runbook

Production checklist for one baerly-storage app. Operational safety
depends on one bucket URI, one `(app, tenant, collection)` scope, and
auth returning the intended tenant prefix. Fill these once and keep the
same values through every command:

```sh
APP=acme
TENANT=main
BUCKET_URI=s3://baerly-prod
COLLECTION=tickets
BASE_URL=https://api.example.com
```

## Before first deploy

### Bucket and deploy checks

For Cloudflare, run both checks. For Node/self-hosted, run only the
bucket check.

```sh
# Cloudflare only: wrangler config, R2 binding, secrets, Access shape.
baerly doctor --target=cloudflare

# All targets: live conditional-write probe against the production bucket.
baerly doctor --bucket="$BUCKET_URI"
```

- The target check validates platform deploy shape.
- The bucket check validates the object-store commit rule: when several
  writers try to create the same fresh log object, exactly one must win;
  stale `If-Match` updates and create-if-absent writes over existing keys
  must fail.

`baerly doctor --bucket` writes and deletes throwaway sentinels to prove
the bucket honors `If-None-Match: "*"` and `If-Match`. It does not
migrate or validate an existing baerly-storage prefix.

For new buckets, skip this note: buckets written by the old
pre-single-write `current.json` schema (`schema_version` 1 or 2) must be
dumped under the old build and restored/reseeded under the current schema
(`schema_version: 3`), not reused in place.

There is no `baerly doctor --target=node` backend today; the bucket
probe is the Node safety check.

### Readiness check

`GET /v1/healthz` is an anonymous *liveness* probe — it answers "is the
process up?" without touching storage. `assertStorageReachable` from
`@gusto/baerly-storage/node` is the application-level *readiness* check:
it proves the configured bucket is reachable and honors the conditional
writes (CAS) the protocol depends on. It throws `BaerlyError` —
`NetworkError` if the bucket is unreachable, `InvalidConfig` if CAS is
broken — so the process fails closed before serving traffic.

```ts
import { resolveStorageFromEnv, assertStorageReachable } from "@gusto/baerly-storage/node";
const { storage, label } = resolveStorageFromEnv();
await assertStorageReachable(storage); // throws before we serve traffic
console.log(`[baerly] storage=${label} (reachable)`);
```

It is opt-in by design: it performs a handful of live round-trips
(writing and deleting throwaway sentinels), so do not run it on every
request or wire it into a hot path. Run it once at startup, or behind a
`/readyz` handler your platform polls. On serverless or edge runtimes
with frequent cold starts (e.g. Cloudflare isolates) you would not want
it on every cold start.

It catches an unreachable, access-denied, or non-existent bucket and a
CAS-broken store, but not a wrong-but-writable bucket — a typo that
points at another bucket you own boots clean.

### Auth

Verify the route boundary. `GET /v1/healthz` is anonymous inside the
baerly-storage adapter; if Cloudflare Access protects the whole
hostname, Access may challenge it before the Worker sees it. The
unauthenticated collection request below is the production data-route
check.

```sh
curl -fsS "$BASE_URL/v1/healthz"

# Must fail closed without production auth.
# Expect 401/403 or an Access challenge; any 2xx here is a production auth failure.
curl -i "$BASE_URL/v1/c/$COLLECTION"

# Shared-secret or generic bearer verifier.
curl -fsS -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/v1/c/$COLLECTION"

# Cloudflare Access service-token request.
curl -fsS \
  -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
  "$BASE_URL/v1/c/$COLLECTION"
```

Set exactly one auth path's variables before running the authenticated
curl: either `$TOKEN`, or the Cloudflare Access service-token pair.

Use `auth: "none"` only for local development or trusted internal
code paths. Production data routes (`/v1/c/*`, `/v1/count`, and
`/v1/since`) need a verifier that accepts the request and returns the
tenant prefix, the storage namespace for that request:

| Target             | Production default                                                           |
| ------------------ | ---------------------------------------------------------------------------- |
| Cloudflare         | `cloudflareAccess({ teamDomain, audienceTag, tenantPrefix })`                |
| Node               | `bearerJwt({ jwks, issuer, audience, tenantClaim })` or fixed `tenantPrefix` |
| Service-to-service | `sharedSecret({ secret, tenantPrefix })`                                     |

Never ship `SHARED_SECRET` to a browser bundle. Full recipes are in
[auth.md](auth.md) and [client-auth.md](client-auth.md).

## Backups

Dump every production collection off-host. Dumps are collection-scoped
NDJSON; keep an inventory of every `(app, tenant, collection)` triple
you operate. Use the hardened wrapper in [backups.md](backups.md):
`0600` env file owned by the job user, temp file plus atomic rename,
`0600` files, SHA-256 sidecar, off-host retention, and restore drill.

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

Run these for each production collection:

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

They cover `current.json`, snapshot and log state, Class A/month
projection from the trailing log, the snapshot hash, and log holes.

For Node/self-hosted buckets, also run the all-collection writes/min
scan:

```sh
baerly admin usage \
  --target=node \
  --bucket="$BUCKET_URI" \
  --app="$APP" \
  --tenant="$TENANT"
```

For Cloudflare, `admin usage` is not wired for this scan yet: the Node
CLI cannot reach a Workers R2 binding directly. Use canonical logs for
trend history and `baerly cost` with R2 S3-compatible credentials for
current operation-cost projection.

## Incidents

On alerts, collect the canonical JSON log line first; it carries
`request_id`, `outcome`, status, and the `db.*` counters. For
Cloudflare maintenance alerts, also collect the `wrangler tail`
`console.warn` / `console.error` line. Alert and respond on:

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

| Line | Meaning |
| --- | --- |
| roughly 30 sustained logical writes/min per collection | Throughput ceiling; model/estimate, pending real-infra measurement. |
| >10 GB per tenant stored | R2 free-tier storage line; a cost signal, not a protocol ceiling. baerly-storage does not enforce per-tenant byte limits. |
| ~100 collections per tenant | Soft fan-out guideline; bench-grounded linear cost. Nothing in the protocol enforces a cap. |

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
