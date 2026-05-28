---
title: Manual end-to-end check
audience: maintainer
summary: "Manual lifecycle for the CF + Node end-to-end check. Deploy the production scaffolds, then run pnpm test:manual-e2e against the deployed URLs."
last-reviewed: 2026-05-20
tags: [manual-e2e, operations]
related: ["../CLAUDE.md"]
---

# Baerly manual end-to-end check

A two-file check (`manual-e2e/cloudflare/e2e.test.ts` +
`manual-e2e/node/e2e.test.ts`) that lets a maintainer verify
`baerlyWorker()` and `baerlyNode()` against real R2 and real S3
before merging adapter changes. Manual — not part of CI.

The deploy artifacts are the production templates at
`examples/minimal-cloudflare/` and `examples/minimal-node/`
(materialised via `create-baerly-storage`). This directory holds only the
test driver — there are no skeleton apps to maintain.

## Lifecycle

1. Provision resources (one-time): R2 bucket, S3 bucket, IAM /
   wrangler credentials, shared secret.
2. Deploy both runtimes from the `create-baerly-storage` scaffolds.
3. `pnpm test:manual-e2e` — runs the two test files against the
   deployed URLs.
4. Inspect the pass criteria below.
5. Tear down: `wrangler delete`, `docker stop && docker rm`,
   delete buckets if desired.

The check is a **manual checklist**: deploy, run, tear down. CI
plumbing is a future addition.

## Section 1: Deploy the Cloudflare Worker

### Prerequisites

- A Cloudflare account on **Workers Standard or higher** — the 25 s
  long-poll budget exceeds the free-tier 10 ms CPU cap. Standard's
  50 ms-burst tier with 30 s wall-clock is the floor.
- `wrangler` v3+ installed: `npm i -g wrangler` (or `pnpm dlx
  wrangler`).
- An R2 bucket. Free tier (10 GB / 10 M Class A / 1 M Class B per
  month) is more than enough for the check run (~700 ops total).

### Step-by-step

```sh
# 1. Scaffold the production Cloudflare template. The name doubles
#    as the R2 bucket name; pick something memorable.
npm create baerly@latest baerly-e2e-cf -- --target=cloudflare
cd baerly-e2e-cf
pnpm install

# 2. Auth.
wrangler login

# 3. Set the shared secret. Read a strong random secret into
#    SHARED_SECRET; the same value goes into the check runner's env.
export SHARED_SECRET="$(openssl rand -hex 32)"
echo "$SHARED_SECRET" | wrangler secret put SHARED_SECRET

# 4. Deploy. `baerly deploy` auto-provisions the R2 bucket via
#    `wrangler deploy --x-provision --x-auto-create` (with a
#    `wrangler r2 bucket create` fallback).
pnpm baerly deploy

# 5. Note the deployed URL (e.g.
#    https://baerly-e2e-cf.<sub>.workers.dev).
export CF_DEPLOY_URL="https://baerly-e2e-cf.<your-subdomain>.workers.dev"
```

### Env-var checklist (for the check runner)

| Var | Source | Used by |
| --- | --- | --- |
| `CF_DEPLOY_URL` | output of `baerly deploy` | check test file |
| `SHARED_SECRET` | the value put via `wrangler secret put` | check test client |
| `APP` | optional, defaults to `minimal-cloudflare` (only override if the scaffold's `wrangler.jsonc` `vars.APP` was customised) | check test client |
| `TENANT` | optional, defaults to `minimal-demo` (only override if `vars.TENANT` was customised) | check test client |
| `CF_R2_S3_ENDPOINT` | `https://<accountid>.r2.cloudflarestorage.com` | provisioning seam |
| `CF_R2_ACCESS_KEY_ID` | R2 API token (with object read/write) | provisioning seam |
| `CF_R2_SECRET_ACCESS_KEY` | R2 API token secret | provisioning seam |
| `CF_R2_BUCKET` | optional, defaults to `minimal-cloudflare` (the scaffold's `r2_buckets[0].bucket_name`; override only if you renamed the scaffold) | provisioning seam |

`CF_R2_*` are the **provisioning seam**: the HTTP conformance cascade
needs to write `current.json` for each fresh table before the first
`POST` lands. The HTTP surface has no "create table" route, so the test
process opens its own `S3HttpStorage` against the R2 S3-compat
endpoint and calls `createCurrentJson` directly. Without these vars,
the check skips the conformance cascade and runs only the latency
probe / long-poll / 401 checks.

### Verification

```sh
curl -s -H "Authorization: Bearer $SHARED_SECRET" \
  "$CF_DEPLOY_URL/v1/healthz"
# Expect: {"ok":true}

curl -s "$CF_DEPLOY_URL/v1/healthz"
# Expect: {"ok":true}  (healthz is always anonymous — by design)

curl -s "$CF_DEPLOY_URL/v1/c/some-table"
# Expect: 401 with {"error":{"code":"Unauthorized",...}}
```

## Section 2: Deploy the Node host

### Prerequisites

- Docker (or any container runtime).
- AWS account with an S3 bucket in the chosen region. Default
  `us-east-1`. Fallback: Cloudflare R2 via S3-compat (see end of
  section).
- IAM credentials with `s3:GetObject`, `s3:PutObject`,
  `s3:DeleteObject`, `s3:ListBucket` on the bucket.
- A host with TCP/8080 open. Local Docker is fine for the check.

### Step-by-step

```sh
# 1. Scaffold the production Node template with the docker add-on.
#    The add-on layers a multi-stage distroless Dockerfile + healthcheck.js
#    + .dockerignore on top of the base template.
npm create baerly@latest baerly-e2e-node -- --target=node --with=docker
cd baerly-e2e-node
pnpm install

# 2. Populate .env from .env.example (AWS_ACCESS_KEY_ID,
#    AWS_SECRET_ACCESS_KEY, BUCKET, SHARED_SECRET, etc.).
cp .env.example .env
$EDITOR .env

# Generate a shared secret (same value will go to the runner).
export SHARED_SECRET="$(openssl rand -hex 32)"
# Drop $SHARED_SECRET into .env's SHARED_SECRET= line.

# 3. Build and run.
docker build -t baerly-e2e-node:dev .
docker run --rm -d \
  --name baerly-e2e-node \
  -p 8080:8080 \
  --env-file .env \
  baerly-e2e-node:dev

export NODE_DEPLOY_URL="http://localhost:8080"
```

### Env-var checklist

| Var | Source | Used by |
| --- | --- | --- |
| `AWS_ACCESS_KEY_ID` | IAM | container + provisioning seam |
| `AWS_SECRET_ACCESS_KEY` | IAM | container + provisioning seam |
| `AWS_REGION` | optional, default `us-east-1` | container + provisioning seam |
| `BUCKET` | bucket name | container + provisioning seam |
| `SHARED_SECRET` | generated | container + check test client |
| `NODE_DEPLOY_URL` | container's external URL | check test file |
| `APP` | optional, defaults to `minimal-node` (only override if you edited the scaffold's `src/server/index.ts`) | check test client |
| `TENANT` | optional, defaults to `minimal-demo` (matches the scaffold's `.env.example:TENANT`; override only if you changed `.env`) | check test client |
| `S3_ENDPOINT` | optional, default `https://s3.<region>.amazonaws.com` | container + provisioning seam |

The same AWS credentials and bucket the container uses double as the
**provisioning seam** the check test process opens its own
`S3HttpStorage` against. No second R2-style indirection on this side.

### R2-via-S3-compat fallback

If you don't have AWS, point the Node host at Cloudflare R2 with the
S3 API. Either edit the `.env` you populated above, or override at
`docker run` time:

```sh
docker run --rm -d \
  --name baerly-e2e-node \
  -p 8080:8080 \
  -e S3_ENDPOINT="https://<accountid>.r2.cloudflarestorage.com" \
  -e AWS_REGION=auto \
  -e AWS_ACCESS_KEY_ID=<r2-token-id> \
  -e AWS_SECRET_ACCESS_KEY=<r2-token-secret> \
  -e BUCKET=baerly-e2e-node \
  -e SHARED_SECRET="$SHARED_SECRET" \
  baerly-e2e-node:dev
```

R2's S3-compat endpoint signs the same SigV4; `aws4fetch` handles
the difference transparently.

### Verification

```sh
curl -s -H "Authorization: Bearer $SHARED_SECRET" \
  "$NODE_DEPLOY_URL/v1/healthz"
# Expect: {"ok":true}
```

## Section 3: Run the check

```sh
# From repo root, with all env vars exported:
pnpm test:manual-e2e
```

The script invokes both `manual-e2e/cloudflare/e2e.test.ts` and
`manual-e2e/node/e2e.test.ts`. Each silently skips when its primary
deploy URL env var is unset, so it is safe to run the check against
only one runtime at a time during development.

Each test emits a pass summary on stdout (latency
percentiles, long-poll wall-clock samples). On failure, the
assertion + the env reproduction snippet print so a re-run is a
one-liner.

## Section 4: Teardown

```sh
# Cloudflare
wrangler delete baerly-e2e-cf
wrangler r2 bucket delete baerly-e2e-cf   # optional

# Node
docker stop baerly-e2e-node && docker rm baerly-e2e-node
aws s3 rb s3://<your-bucket> --force      # optional
```

Residual data: every check run scopes writes under a fresh
`e2e-<unix-ms>/`-prefixed table namespace. If a run is interrupted,
leftover keys are under that prefix; a one-line `aws s3 rm
--recursive s3://<bucket>/app/<APP>/tenant/<TENANT>/manifests/<e2e-prefix>*`
(or the matching `wrangler r2 object delete` script) cleans up.
Substitute the `APP` / `TENANT` values from your deploy (defaults
`minimal-cloudflare` / `minimal-demo` for CF, `minimal-node` /
`minimal-demo` for Node).

## Cost summary (per run)

- **Cloudflare R2:** ~700 R2 ops (PUT/POST/LIST + GET/HEAD). Well
  under the free tier's 10 M Class A / 1 M Class B monthly caps.
- **AWS S3 (us-east-1):** ~500 PUTs × $0.005/1000 = **$0.0025**.
  Negligible.
- **Cloudflare Workers Standard:** ~700 requests × $0.30/1M ≈
  **$0.0002**.

A back-of-the-envelope upper bound for ten check runs in a day:
under one US cent total.

## Pass criteria

The check passes when all of:

1. Every assertion in `runHttpConformanceCascade(...)` passes against
   both deployed URLs (when the provisioning seam env vars are set).
2. **P95 GET latency** for 100 sequential GETs to a 1 KB object:
   CF < 100 ms, Node (single-AZ `us-east-1`) < 50 ms.
3. **P99 GET latency** (same 100-GET sample): < 500 ms (both).
4. **Long-poll**: 10 concurrent long-polls + 10 writes; each
   long-poll returns within 26 s wall-clock (1 s buffer over the
   server-side 25 s budget) and observes the matching write.
5. **Unauthenticated request** → 401 with the canonical
   `{ "error": { "code": "Unauthorized", "message": ... } }`
   envelope.
6. Zero spurious 5xx. Transient 503 due to PATCH contention is OK
   (the protocol surfaces them as `Conflict` at the next layer); raw
   5xx without a structured envelope is a fail.

If any single budget gets relaxed on a given run (e.g. CF P95 hits
120 ms due to a region with poor R2 peering), record the observed
numbers in the PR description and on a follow-up ticket. Don't
quietly relax the constants.

## Out of scope (deferred)

- Automated CI integration (GitHub Actions / Buildkite).
- Multi-region / failover.
- Observability dashboards beyond stdout summaries.
