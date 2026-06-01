---
title: Developer setup
audience: coder
summary: "Local dev: pnpm, Minio + Toxiproxy + Postgres stack, test commands."
last-reviewed: 2026-05-31
tags: [development, setup, tests]
related: ["./troubleshooting.md", "../../CLAUDE.md"]
---

# Development

## Prerequisites

- [pnpm](https://pnpm.io) ≥ 11 (the repo declares `packageManager: pnpm@11.1.2`).
- [Docker](https://docker.com) + Docker Compose (for local Minio).
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
pnpm test                                   # entire suite
pnpm exec vitest run packages/protocol/src/json.test.ts   # one file
pnpm exec vitest run -t "subscribe"               # tests whose name matches
pnpm test:randomize                         # loop until a failure (soak)
```

Test files import from `"vitest"`:

```ts
import { test, expect, describe, beforeAll, afterEach } from "vitest";
```

### Which tests need infra

Which tests skip without Minio or credentials, and which are always
green, is documented in [CLAUDE.md → Test gating](../../CLAUDE.md#test-gating).

To bring up the local Minio + Toxiproxy stack:

```sh
pnpm dev:storage      # docker compose up -d --wait (blocks until healthy)
pnpm dev:storage:stop # tear down
```

Minio runs on `http://127.0.0.1:9102` (S3 API), console on `:9103`
(login `baerly` / see `docker-compose.yml`); Toxiproxy on `:9104` proxies
Minio for latency/failure injection; Postgres on `:5433` backs the
export-smoke suite. The `minio` proxy is declared
statically in [`docker/toxiproxy.json`](../../docker/toxiproxy.json) and
loaded at container start.

Running two worktrees at once? The host ports for Minio (`:9102`),
Toxiproxy (`:9104`), the Toxiproxy admin port (`:8474`), and Postgres
(`:5433`) are overridable via `BAERLY_MINIO_HOST_PORT`,
`BAERLY_TOXIPROXY_HOST_PORT`, `BAERLY_TOXIPROXY_ADMIN_PORT`, and
`BAERLY_POSTGRES_HOST_PORT` (set them in a per-worktree `.env.local` or
inline). `tests/setup/ports.ts` reads the same variables so the test
setup stays in sync. Without overrides a second `compose up` fails with
`port already allocated`. (The Minio console `:9103` is fixed.)

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
hover and `tsgo` consume it directly — there is no rendered markdown
ref to regenerate.

## The verification ritual

```sh
pnpm verify       # typecheck + verify:examples + lint — guaranteed green on main
pnpm test         # vitest run — see CLAUDE.md "Test gating" for which tests are gated
pnpm format:check # currently red on ~20 pre-existing files; run pnpm format to fix
pnpm build        # exercise the build path (rolldown bundle)
```

`pnpm verify` is intentionally narrow — it covers only the checks that are
reliably green so a non-zero exit means *you* broke something. For tests
and formatting, compare your output against the `main` baseline to
distinguish your regressions from the pre-existing state.

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

1. Reproduce: `pnpm test:randomize` runs the suite in a loop until
   something fails.
2. Narrow: copy the failing test name and run that file alone.
3. Logs: pass a `MetricsRecorder` (or wrap one) into the
   `Writer` under test to observe internal events. The
   `db.write.*` metric names enumerated in
   `packages/server/src/writer.ts`'s JSDoc are the
   canonical event taxonomy.
4. Inspect Minio: when running against `dev:storage`, the Minio console at
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
