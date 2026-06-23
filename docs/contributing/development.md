---
title: Developer setup
audience: coder
summary: "Local dev: pnpm, MinIO + Toxiproxy + Postgres stack, test commands."
last-reviewed: 2026-06-23
tags: [development, setup, tests]
related: ["./troubleshooting.md", "../../CLAUDE.md"]
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

MinIO runs on `http://127.0.0.1:9102` (S3 API), console on `:9103`
(login `baerly` / see `docker-compose.yml`); Toxiproxy on `:9104` proxies
MinIO for latency/failure injection; Postgres on `:5433` backs the
export-smoke suite. The `minio` proxy is declared
statically in [`docker/toxiproxy.json`](../../docker/toxiproxy.json) and
loaded at container start.

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

## Project layout

The module map lives in [CLAUDE.md → Module map](../../CLAUDE.md#module-map);
the deeper dependency graph + lifecycles live in
[architecture.md](architecture.md). For a flat enumeration, just `ls
packages/*/src/ tests/`.
