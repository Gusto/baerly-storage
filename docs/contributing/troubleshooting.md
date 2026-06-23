---
title: Troubleshooting
audience: coder
summary: "Common pain points: test gating, local stack ports, randomized tests, formatting hooks."
last-reviewed: 2026-06-22
tags: [troubleshooting, operations]
related: [./development.md]
---

# Troubleshooting

Troubleshooting for repeatable local checkout failures not covered in
`CLAUDE.md`.

## Test gating

`pnpm test` is meant to pass on a fresh checkout without Minio,
Postgres, or cloud credentials. When a failure names one of those
dependencies, check the gate first:

| Failure mentions | Run or check |
|---|---|
| Minio, S3, `:9102`, or Toxiproxy | Start `pnpm dev:storage`, then run `pnpm test:minio` or the narrower Minio-backed script. |
| `export-smoke.test.ts` or Postgres | Start `pnpm dev:storage`, then run `pnpm test:export-smoke`. |
| `conformance.test.ts` credentials | Add `credentials/{aws,gcs,cloudflare}.json`, then run `pnpm test:conformance`. |
| Anything else | Treat it as an ungated failure in the current branch. |

The full gate list lives in
[CLAUDE.md → Test gating](../../CLAUDE.md#test-gating).

## Local stack ports

`pnpm dev:storage` brings up the local services that support S3 and
export tests: Minio for S3, Toxiproxy for controlled reachability
failure, and Postgres for export smoke.

| Service | Port | Purpose |
|---|---|---|
| Minio API | `:9102` | Direct S3-compatible endpoint; tests use this when they need reliable Minio. |
| Minio console | `:9103` | Web UI at <http://127.0.0.1:9103> (login `baerly` / see compose file). |
| Toxiproxy | `:9104` | Proxy in front of Minio; `randomized.test.ts` uses it for injected network failure. |
| Toxiproxy admin | `:8474` | HTTP admin API for toggling or configuring the proxy. |
| Postgres | `:5433` | Backs `export-smoke.test.ts`. Host port 5433 to dodge a local dev Postgres on 5432. |

The compose bindings for all ports except the Minio console are
overridable via `BAERLY_MINIO_HOST_PORT`,
`BAERLY_TOXIPROXY_HOST_PORT`, `BAERLY_TOXIPROXY_ADMIN_PORT`, and
`BAERLY_POSTGRES_HOST_PORT` (see [development.md](development.md)).
Vitest tests that import `tests/setup/ports.ts` read the same variables.
The Minio console stays fixed at `:9103`, and two independent Compose
projects also need distinct project names; otherwise a second
`compose up` can fail with `port already allocated`.

The Minio/Toxiproxy split matters because both endpoints reach the same
bucket, but they test different failure modes. Direct `:9102` traffic
tests available Minio. Proxied `:9104` traffic tests convergence while
the proxy drops and returns. In current `randomized.test.ts`, bucket
setup uses direct Minio through `stableConfig`; fault-injected
`S3HttpStorage` traffic uses Toxiproxy through `unstableConfig`.

Toxiproxy's default config creates one enabled `minio` proxy with no
toxics. A toxic is a configured latency, drop, bandwidth, or similar
rule. Current randomized tests simulate network failure by toggling the
proxy through the admin API, not by adding toxics.

## What `pnpm test:randomize` actually does

`"test:randomize": "FC_NUM_RUNS=10000 vitest run --project=default"`

Despite the name, `pnpm test:randomize` does not loop until
failure; it runs the default Vitest project once with
`FC_NUM_RUNS=10000`. That raises fast-check property tests from the
default 100 cases to 10,000 cases. The `randomized.test.ts` cascade has
its own backend variants, so raising `FC_NUM_RUNS` does not make that
file loop.

Run it when:

- You changed property-tested protocol, query, index, compaction, or GC
  behavior and want a larger fast-check sample.
- You changed timing constants in `packages/protocol/src/constants.ts`
  (`LAG_WINDOW_MILLIS`, etc.).
- You have a flaky failure with a fast-check seed/path and want more
  coverage before trusting a fix.

Use `pnpm test:fuzz-phase5` when changing `packages/server/src/compactor.ts`,
`packages/server/src/gc.ts`, or `packages/server/src/writer.ts`; that
script runs the crash-injection fuzzer. Neither command is a load test or
a latency benchmark.

## "Why is `pnpm format:check` red?"

It is green on `main`; a local failure usually means the current branch
introduced a formatting violation. Run `pnpm format` to write the oxfmt
result in place, then re-run.
`format:check` (`oxfmt --check .`, whole-repo) is part of `pnpm verify`,
and the lefthook pre-commit hook also runs `pnpm exec oxfmt {staged_files}`
on staged code/markup. Markdown is outside oxfmt; `verify:docs`
validates Markdown instead of reformatting it.

## "Pre-commit hook didn't fire"

`pnpm install` installs the lefthook pre-commit hook in the primary
checkout via `prepare`; secondary worktrees skip that install because
they share hook config with the primary checkout. A checkout is secondary
when `git rev-parse --git-dir` differs from
`git rev-parse --git-common-dir`.

If the hook is missing, run `pnpm install` in the primary checkout or
`pnpm exec lefthook install` explicitly. Verify from any checkout with
`cat "$(git rev-parse --git-path hooks/pre-commit)"` — it should be a
lefthook stub.

Use `git commit --no-verify` only for local WIP commits that will be
fixed before review. Do not bypass hooks for merge commits or PR
branches.
