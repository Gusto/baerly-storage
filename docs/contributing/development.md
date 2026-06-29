---
title: Developer setup
audience: coder
summary: "Local dev: pnpm, MinIO + Toxiproxy + Postgres stack, test commands, and troubleshooting."
last-reviewed: 2026-06-28
tags: [development, setup, tests, troubleshooting]
related: ["../../CLAUDE.md"]
---

# Development

## Prerequisites

- [pnpm](https://pnpm.io) ≥ 11 (the repo declares `packageManager: pnpm@11.1.2`).
- [Docker](https://docker.com) + Docker Compose (for local MinIO).
- Node 22+ (`@types/node@^22.9.0` and `tsgo` target).

## Initial setup

```sh
git clone <repo>
cd baerly-storage
pnpm install
```

## Running tests

The full suite is run with vitest:

```sh
pnpm test                                   # build + default Vitest project
pnpm exec vitest run packages/protocol/src/json.test.ts   # one file
pnpm exec vitest run -t "subscribe"               # tests whose name matches
pnpm test:randomize                         # one higher-run randomized pass
```

Test files import from `"vitest"`:

```ts
import { test, expect, describe, beforeAll, afterEach } from "vitest";
```

### Which tests need infra

Which tests skip without MinIO or credentials, and which are always
green, is documented in [CLAUDE.md → Test gating](../../CLAUDE.md#test-gating).

To bring up the local MinIO + Toxiproxy stack:

```sh
pnpm dev:storage      # docker compose up -d --wait (blocks until healthy)
pnpm dev:storage:stop # tear down
```

The local stack exposes these ports:

| Service | Port | Purpose |
|---|---|---|
| MinIO API | `:9102` | Direct S3-compatible endpoint; tests use this when they need reliable MinIO. |
| MinIO console | `:9103` | Web UI at <http://127.0.0.1:9103> (login `baerly` / see `docker-compose.yml`). |
| Toxiproxy | `:9104` | Proxy in front of MinIO; `randomized.test.ts` uses it for injected network failure. |
| Toxiproxy admin | `:8474` | HTTP admin API for toggling or configuring the proxy. |
| Postgres | `:5433` | Backs `export-smoke.test.ts`. Host port 5433 dodges a local dev Postgres on 5432. |

The `minio` proxy is declared statically in
[`docker/toxiproxy.json`](../../docker/toxiproxy.json) and loaded at
container start.

The MinIO/Toxiproxy split matters because both endpoints reach the same
bucket but test different failure modes. Direct `:9102` traffic tests
available MinIO; proxied `:9104` traffic tests convergence while the
proxy drops and returns. Bucket setup uses direct MinIO through
`stableConfig`; fault-injected `S3HttpStorage` traffic uses Toxiproxy
through `unstableConfig`. Toxiproxy's default config creates one enabled
`minio` proxy with no toxics (a toxic is a configured latency, drop, or
bandwidth rule); the randomized tests simulate failure by toggling the
proxy through the admin API on `:8474`, not by adding toxics.

Running two worktrees at once? `pnpm dev:storage` runs `docker compose`
directly; it does not load `.env.local`, and the checked-in Compose file
sets the project name to `baerly-storage`. If you need two simultaneous
stacks, call Compose yourself with a distinct project name and pass the
port overrides inline or through a Compose-loaded env file:

```sh
BAERLY_MINIO_HOST_PORT=9202 \
BAERLY_TOXIPROXY_HOST_PORT=9204 \
BAERLY_TOXIPROXY_ADMIN_PORT=8574 \
BAERLY_POSTGRES_HOST_PORT=5434 \
docker compose -p baerly-storage-alt up -d --wait
```

`tests/setup/ports.ts` reads the same `BAERLY_*` variables, so test
commands need those env vars too. Without overrides a second
`compose up` fails with `port already allocated`. The MinIO console
port `:9103` is fixed in `docker-compose.yml`; running two full stacks
unchanged still collides there unless you add a local Compose override
or stop the first stack.

## Type checking, formatting, linting

```sh
pnpm typecheck        # tsgo --noEmit (TypeScript 7 in strict mode)
pnpm format           # oxfmt (writes in place)
pnpm format:check     # oxfmt --check (no writes; CI mode)
pnpm lint             # oxlint
```

## Building

```sh
pnpm build       # rolldown bundle to dist/ (index.js + index.d.ts)
```

Public-API documentation lives as JSDoc on
`packages/server/src/db.ts` and `packages/server/src/collection.ts`. IDE
hover and `tsgo` consume it directly. The curated installed quick
reference source is `packages/server/API.md`, copied to `dist/API.md`
at build time. Keep both aligned with the exported `.d.ts` surface.

## The verification ritual

```sh
pnpm verify       # typecheck + examples + lint/format/docs + repository guard scripts
pnpm test         # vitest run — see CLAUDE.md "Test gating" for which tests are gated
pnpm build        # exercise the build path (rolldown bundle)
```

`pnpm verify` is green on `main`, so a non-zero exit means *you* broke
something. It bundles the format check (`oxfmt --check`, whole-repo),
the docs checks, example typechecks, and repository guard scripts
alongside typecheck and lint — see the gate table in CLAUDE.md for the
full list. `pnpm test` is kept separate because some suites are
infra-gated; if a test fails, compare against the `main` baseline to
confirm it's yours.

## Common pitfalls

- **vitest, not bun:test.** A `import { test } from "bun:test"` will
  silently mismatch and produce confusing errors. Always import from
  `"vitest"`.
- **No `baseUrl`.** `tsconfig.json` uses `moduleResolution: "bundler"` and
  no `baseUrl`. Cross-package imports use the `@baerly/<pkg>`
  workspace name; sibling imports are relative
  (`import { makeCollection } from "./collection"`).
- **`oxfmt --write` modifies files.** Use `format:check` if you only want
  to verify.
- **`tsgo` is the TS 7 native preview.** Errors look slightly different
  from `tsc` 5.x output but the diagnostics map 1:1.
- **Clock-skew tests are sensitive.** The protocol has a `LAG_WINDOW_MILLIS`
  (5s) tolerance — if your machine clock drifts > 5s from NTP, expect
  flakes in `time.test.ts` and `randomized.test.ts`.
- **`pnpm install` errors with `lefthook install`.** If `git config core.hooksPath`
  is set to something `lefthook install` doesn't expect (common when another tool
  in your dotfiles owns the hooks path), the `prepare` script fails. Workarounds,
  in order of preference: `lefthook install --reset-hooks-path`, or
  `git config --unset core.hooksPath && pnpm install`, or as a last resort
  `pnpm install --ignore-scripts` (skips the `prepare` step entirely; you'll need
  to wire pre-commit hooks manually).

## Debugging a flaky test

1. Reproduce: `pnpm test:randomize` runs the default Vitest project once
   with `FC_NUM_RUNS=10000`; it increases the fast-check sample size but
   does not loop until failure.
2. Narrow: copy the failing test name and run that file alone.
3. Logs: pass a `MetricsRecorder` (or wrap one) into the
   `Writer` under test to observe internal events. The
   `db.write.*` metric names enumerated in
   `packages/server/src/writer.ts`'s JSDoc are the
   canonical event taxonomy.
4. Inspect MinIO: when running against `dev:storage`, the MinIO console at
   `http://localhost:9103` shows current bucket contents — useful for
   eyeballing manifest objects.
5. Toxiproxy: failures only with Toxiproxy in the loop usually mean a
   resilience gap. The static proxy lives in `docker/toxiproxy.json`;
   add toxics at runtime with the admin API on `:8474`
   (`POST /proxies/minio/toxics`) or via `toxiproxy-cli`.

## When to crank the fuzzers

`pnpm test:randomize` runs the default Vitest project once with
`FC_NUM_RUNS=10000`, raising fast-check property tests from 100 to
10,000 cases. It does not loop until failure, and the
`randomized.test.ts` cascade has its own backend variants, so a higher
`FC_NUM_RUNS` does not make that file loop. Reach for it when you:

- changed property-tested protocol, query, index, compaction, or GC
  behavior and want a larger fast-check sample;
- changed timing constants in `packages/protocol/src/constants.ts`
  (`LAG_WINDOW_MILLIS`, etc.);
- have a flaky failure with a fast-check seed and want more coverage
  before trusting a fix.

Use `pnpm test:fuzz-maintenance` instead when changing
`packages/server/src/compactor.ts`, `packages/server/src/gc.ts`, or
`packages/server/src/writer.ts`; that script runs the crash-injection
fuzzer. Neither command is a load test or a latency benchmark.

## Troubleshooting

Repeatable local-checkout failures not covered above or in `CLAUDE.md`.

### A test fails naming infra

`pnpm test` is meant to pass on a fresh checkout without MinIO,
Postgres, or cloud credentials. When a failure names one of those
dependencies, check the gate first:

| Failure mentions | Run or check |
|---|---|
| MinIO, S3, `:9102`, or Toxiproxy | Start `pnpm dev:storage`, then run `pnpm test:minio` or the narrower MinIO-backed script. |
| `export-smoke.test.ts` or Postgres | Start `pnpm dev:storage`, then run `pnpm test:export-smoke`. |
| `conformance.test.ts` credentials | Add `credentials/{aws,gcs,cloudflare}.json`, then run `pnpm test:conformance`. |
| Anything else | Treat it as an ungated failure in the current branch. |

The full gate list lives in
[CLAUDE.md → Test gating](../../CLAUDE.md#test-gating).

### `pnpm format:check` is red

It is green on `main`, so a local failure usually means the current
branch introduced a formatting violation. Run `pnpm format` to write the
oxfmt result in place, then re-run. `format:check` (`oxfmt --check .`,
whole-repo) is part of `pnpm verify`, and the lefthook pre-commit hook
also runs `oxfmt` on staged code/markup. Markdown is outside oxfmt;
`verify:docs` validates Markdown instead of reformatting it.

### The pre-commit hook didn't fire

`pnpm install` installs the lefthook pre-commit hook in the primary
checkout via `prepare`; secondary worktrees skip that install because
they share hook config with the primary checkout. A checkout is
secondary when `git rev-parse --git-dir` differs from
`git rev-parse --git-common-dir`. If the hook is missing, run
`pnpm install` in the primary checkout or `pnpm exec lefthook install`
explicitly, and verify from any checkout with
`cat "$(git rev-parse --git-path hooks/pre-commit)"` — it should be a
lefthook stub. Use `git commit --no-verify` only for local WIP commits
that will be fixed before review; never for merge commits or PR branches.

## Project layout

The module map lives in [CLAUDE.md → Module map](../../CLAUDE.md#module-map);
the deeper dependency graph + lifecycles live in
[architecture.md](architecture.md). For a flat enumeration, just `ls
packages/*/src/ tests/`.
