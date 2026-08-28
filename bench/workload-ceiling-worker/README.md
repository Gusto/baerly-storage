# Workload-ceiling study Worker

Deployed evidence harness for the workload-ceiling study (parent plan Task 8,
`docs/superpowers/programs/increase-workload-ceiling/`). This Worker is
measurement-only: it is not part of any published `@gusto/baerly-storage`
entry point, it is not reachable from a user's application, and it changes no
production behavior.

## What it does

One authenticated `POST /run` per invocation:

1. Validates the request body as a `WorkloadCeilingRunRequest`
   (`../measurement/workload-ceiling-harness.ts`) — strict field set,
   canonical JSON, no unknown fields.
2. Opens the exact fixture `workload-ceiling-provision.ts` already wrote
   under `fixture_prefix`. It never provisions a fixture itself.
3. Awaits one controlled fold subject —
   `foldChunkedSnapshotReference(rows, [])` from
   `packages/server/src/chunked-snapshot-reference.ts`, the same independent
   logical oracle the chunk-native view is checked against — over whichever
   representation `implementation` selects:
   - `monolithic-control` — a single JSON blob, the shape of today's shipped
     single-snapshot format.
   - `chunked-candidate` — the proposed manifest + chunk layout, read through
     `openSnapshotView` (`packages/server/src/snapshot-view.ts`).
4. Emits the run's join identifiers exactly once as a single structured
   Workers Logs line, and returns the kernel result (row count).

It does **not** provision fixtures, aggregate results across runs, loop or
retry, schedule cron, or self-report CPU time — `Date.now()` /
`performance.now()` do not appear in `src/index.ts`. The only source of
truth for CPU is the platform's own invocation telemetry, retrieved
out-of-band by `../measurement/workload-ceiling-collect.ts`.

## Why CPU is never self-reported

A Worker cannot observe its own CPU-limit enforcement from inside the
isolate — the limit is enforced by the runtime around the isolate, and an
in-process timer measures wall time, not the runtime's own CPU accounting.
Reporting a self-timed number here would be exactly the kind of synthesized
evidence `workload-ceiling-harness.ts`'s codec exists to refuse. The study
instead retrieves the platform's own numbers from two telemetry sources
(evidence contract v2): Workers Observability is the authority for
per-invocation existence and execution outcome (`$workers.outcome` on the
fetch-summary line, whose success literal is `ok`), and the GraphQL Analytics
API's `workersInvocationsAdaptive` dataset supplies the CPU measurement
(`sum.cpuTimeUs`, microsecond resolution) — that dataset demonstrably drops
rows permanently, which the study records as CPU-measurement missingness
rather than execution failure.

## Join mechanism

Workers Analytics does not carry a caller-supplied correlation ID per row.
This harness reuses one already-deployed, fixed-name Worker
(`baerly-storage`, overwritten in place by `deploy.mjs` — see §"Token scope"
for why). Disambiguation therefore rests on the Worker emitting its join
identifiers (`run_id` / `scenario_id` / `implementation` /
`isolate_cold`, step 4 above) exactly once per invocation as a structured
Workers Logs line: under evidence contract v2 the collector joins that line
to the platform fetch-summary line by their shared `requestId`, giving one
authoritative per-invocation record (existence + outcome) however many
invocations share the script name. The CPU measurement still comes from
`workersInvocationsAdaptive` bounded by a narrow `datetime` window, so
overlapping windows still cannot attribute a CPU row — the capture
protocol's global 70 s spacing exists to keep one invocation per minute
bucket.

## Platform documentation this rests on

Retrieved via this repo's `cloudflare`, `workers-best-practices`, and
`wrangler` Claude Code skills at implementation time (Task 8 Step 1); linked
directly here per that step's requirement.

- Module Worker shape / `fetch` handler:
  <https://developers.cloudflare.com/workers/runtime-apis/handlers/fetch/>
- `wrangler.jsonc` configuration reference:
  <https://developers.cloudflare.com/workers/wrangler/configuration/>
- Compatibility dates:
  <https://developers.cloudflare.com/workers/configuration/compatibility-dates/>
- R2 bucket binding (`r2_buckets`, `env.BUCKET`):
  <https://developers.cloudflare.com/r2/api/workers/workers-api-reference/>
- GraphQL Analytics API — query shape, `*Adaptive` raw-row datasets,
  `workersInvocationsAdaptive` dimensions/metrics (`cpuTimeUs`, `status`,
  `scriptName`, `coloCode`, `scriptVersion`) — note the docs below use the
  field name `cpuTime`, but the live `AccountWorkersInvocationsAdaptiveSum`
  schema (confirmed by introspection) names it `cpuTimeUs`:
  <https://developers.cloudflare.com/analytics/graphql-api/>,
  <https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/>
- Workers observability / metrics and invocation status classification:
  <https://developers.cloudflare.com/workers/observability/metrics-and-analytics/>
- Workers Logs (the join-identifier emission path):
  <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>
- Non-interactive Wrangler auth (`CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID`, sourced here from `CF_API_TOKEN` / `CF_ACCOUNT_ID`
  per `tests/integration/day-one-handshake.test.ts`'s existing convention):
  <https://developers.cloudflare.com/workers/wrangler/ci-cd/>

## Deploying (not performed by this task)

Step 10 of Task 8 — one authorized deployed smoke run — is deliberately
**not** performed by this repository's automated gates (`pnpm verify`,
`pnpm test`), and requires `CF_API_TOKEN` / `CF_ACCOUNT_ID` or a credentials
file to be provisioned first (see below).

Set `WORKLOAD_CEILING_TIER=free` to use `credentials/cloudflare-deploy-free.json`
instead of `credentials/cloudflare-deploy.json`. Note that the `-free`
suffix names a credential set, never a verified Workers plan tier — and a
verified plan tier still never implies an enforced CPU ceiling. `cf-free`
evidence comes from the `limits.cpu_ms` block in `wrangler.jsonc`, which
needs a Paid plan; see `lane-b-preflight.md` § Q4 and
`WORKLOAD_CEILING_STUDY.cpu_envelope` before treating any output as `cf-free`.

The workers.dev URL is `https://<name>.<subdomain>.workers.dev/run`, where
`<subdomain>` is per-account. The `-free` account's subdomain happens to be
literally `baerly-storage` (derived from the account name), so the live URL
is the doubled `https://baerly-storage.baerly-storage.workers.dev/run`.
Discover yours with:

```sh
GET /accounts/<account_id>/workers/subdomain   # { "result": { "subdomain": … } }
```

(as done 2026-08-20; works with the deploy token's Account:Read scope)

`deploy.mjs` wraps `wrangler` so auth never has to live in shell env or a
global dotfile — never `wrangler login`. It resolves `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` the same way `../measurement/workload-ceiling-collect.ts`
does: `CF_API_TOKEN` + `CF_ACCOUNT_ID` env vars if both are set, otherwise a
repo-scoped `credentials/cloudflare-deploy.json` (or
`credentials/cloudflare-deploy-free.json` when `WORKLOAD_CEILING_TIER=free`,
gitignored — `{ "api_token": "...", "account_id": "..." }`, read by
`loadCloudflareDeployCredsForTier` in `tests/fixtures/endpoint-creds.ts`).
Either way the resolved credentials are injected only into the spawned
`wrangler` child's environment, never printed or written elsewhere. Once one
of those two sources is available:

```sh
node bench/workload-ceiling-worker/deploy.mjs deploy --name baerly-storage

node bench/workload-ceiling-worker/deploy.mjs secret put WORKLOAD_CEILING_SHARED_SECRET \
  --name baerly-storage
```

### Token scope

Cloudflare's API token permission model has no per-script resource type —
`Workers Scripts: Edit` grants edit access to every Worker in whichever
account you scope the token to under **Account Resources**, not just this
study's. `deploy.mjs` narrows that in code instead: it refuses to run any
`wrangler` subcommand whose `--name` isn't exactly `baerly-storage` (the
same `WORKLOAD_CEILING_WORKER_NAME` constant
`../measurement/workload-ceiling-collect.ts` uses to filter telemetry), so a
typo'd or copy-pasted `--name` can never reach an unrelated script even
though the credential technically could. Treat the token itself
as disposable regardless — create it right before a Step 10 run and revoke
it from the Cloudflare dashboard once cleanup is confirmed, rather than
leaving a standing account-wide-Workers credential around.

Provision the fixture first (`pnpm bench:workload-ceiling:provision`),
invoke once, collect (`pnpm bench:workload-ceiling:collect`), verify the
join, then delete the fixed-name study Worker
(`node bench/workload-ceiling-worker/deploy.mjs delete --name
baerly-storage`) — only once the study as a whole concludes — along with
its exact leased keys. The Worker is deliberately not run-unique: it is
fixed-name and overwritten in place by each smoke run (see §"Join
mechanism"), so there is no per-run deployment to clean up between runs.
Never delete the bucket or an unresolved prefix.

## Runbook — one smoke run

`workersInvocationsAdaptive` rows are minute-bucketed aggregates. Two
invocations inside the same minute collapse into one row with summed CPU —
the collector's request-count assertion treats such a row as unresolved, so
space the two invocations at least one minute apart and give each its own
explicit collection window:

0. Confirm `credentials/cloudflare.json` names the bucket
   `baerly-storage-eval`. Provisioning writes fixtures to whatever bucket that
   file names, while `wrangler.jsonc` binds the Worker's `env.BUCKET` to
   `baerly-storage-eval` as a literal — the two are configured independently,
   and a mismatch means every `POST /run` returns a 502
   `fixture descriptor is missing` that reads as a provisioning bug.
   `pnpm bench:workload-ceiling:provision` preflights this and refuses to
   write on a mismatch; the constant both sides answer to is
   `WORKLOAD_CEILING_BUCKET_NAME` in `../measurement/workload-ceiling-harness.ts`.
1. `deploy.mjs deploy --name baerly-storage` (once), then set the shared
   secret.
2. Provision the fixture (`pnpm bench:workload-ceiling:provision`).
3. Invoke `POST /run` for `monolithic-control`; note the time.
4. Collect with explicit `WORKLOAD_CEILING_WINDOW_START`/`_END` bounding
   only that invocation, routed to the control side's own directory:
   `WORKLOAD_CEILING_OUT_DIR=bench/results/workload-ceiling/control pnpm
   bench:workload-ceiling:collect`.
5. Wait ≥ 1 minute. Repeat 3–4 for `chunked-candidate` with
   `WORKLOAD_CEILING_OUT_DIR=bench/results/workload-ceiling/candidate`.
6. `WORKLOAD_CEILING_CONTROL_DIR=bench/results/workload-ceiling/control
   WORKLOAD_CEILING_CANDIDATE_DIR=bench/results/workload-ceiling/candidate
   pnpm bench:workload-ceiling:compare`.

The per-implementation directories in steps 4–5 are mandatory, not
housekeeping: the directory IS the side. `workload-ceiling-compare.ts`
reads one directory per implementation and both implementations reuse the
same `scenario_id`s, so a shared directory hands the control side every
candidate event as well. Compare pools each side's events per scenario, so
it would not reject them — it would report a control p50 computed over
both arms and a ratio of that against itself.

Never rely on the default 10-minute window — it will span both invocations
and both sides will record CPU-measurement missingness (a collapsed
`workersInvocationsAdaptive` row supplies no attributable CPU; under evidence
contract v2 the invocation's existence and outcome still resolve from Workers
Observability, but the sample carries no number).
