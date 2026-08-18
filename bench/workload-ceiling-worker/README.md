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
instead retrieves the platform's own number through the GraphQL Analytics
API's `workersInvocationsAdaptive` dataset, which reports per-invocation
`status` (the outcome, e.g. success, or an exceeded-resources / exception /
disconnect classification) and CPU time.

## Join mechanism

Workers Analytics does not carry a caller-supplied correlation ID per row.
The plan's Step 10 language ("deploy a uniquely named study Worker") assumes
a fresh per-run deployment, whose `scriptName` alone would disambiguate
invocations. This harness instead reuses one already-deployed, fixed-name
Worker (`baerly-storage`, overwritten in place by `deploy.mjs` for each
smoke run — see §"Token scope" for why), so disambiguation for Task 8's one
authorized smoke run rests on `workload-ceiling-collect.ts` querying
`workersInvocationsAdaptive` filtered by that fixed `scriptName` plus a
narrow `datetime` window bounding the single invocation, rather than on the
name itself. The Workers Logs line emitted in step 4 above (`run_id` /
`scenario_id` / `implementation`) is the independent check that the
telemetry row collected in that window is in fact this run. A later,
bulk multi-run study (out of this plan's scope) would need per-run
uniqueness back, since a shared name plus overlapping windows could no
longer disambiguate concurrent invocations.

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
  `workersInvocationsAdaptive` dimensions/metrics (`cpuTime`, `status`,
  `scriptName`, `coloCode`, `scriptVersion`):
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
`pnpm test`), and requires `CF_API_TOKEN` / `CF_ACCOUNT_ID` or
`credentials/cloudflare-deploy.json` to be provisioned first (see below).

`deploy.mjs` wraps `wrangler` so auth never has to live in shell env or a
global dotfile — never `wrangler login`. It resolves `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` the same way `../measurement/workload-ceiling-collect.ts`
does: `CF_API_TOKEN` + `CF_ACCOUNT_ID` env vars if both are set, otherwise a
repo-scoped `credentials/cloudflare-deploy.json` (gitignored —
`{ "api_token": "...", "account_id": "..." }`, read by
`loadCloudflareDeployCreds` in `tests/fixtures/endpoint-creds.ts`). Either
way the resolved credentials are injected only into the spawned `wrangler`
child's environment, never printed or written elsewhere. Once one of those
two sources is available:

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
housekeeping: `workload-ceiling-compare.ts` joins two event directories,
one per side, and both implementations reuse the same `scenario_id`s —
collected into one shared directory, every scenario arrives twice there
and is evicted as a duplicate, leaving zero pairs and an exit 1.

Never rely on the default 10-minute window — it will span both invocations
and both sides will record `missing-terminal-event`.
