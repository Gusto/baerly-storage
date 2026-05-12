# Development

## Prerequisites

- [pnpm](https://pnpm.io) ≥ 10 (the repo declares `packageManager: pnpm@10.31.0`).
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

IndexedDB is mocked via `import "fake-indexeddb/auto"` in tests that need it.

### Which tests need infra

Which tests skip without Minio or credentials, and which are always
green, is documented in [CLAUDE.md → Test gating](../CLAUDE.md#test-gating).

To bring up the local Minio + Toxiproxy stack:

```sh
pnpm dev:storage      # docker compose up -d --wait (blocks until healthy)
pnpm dev:storage:stop # tear down
```

Minio runs on `http://127.0.0.1:9102` (S3 API), console on `:9103`
(login `mps3` / see `docker-compose.yml`); Toxiproxy on `:9104` proxies
Minio for latency/failure injection. The `minio` proxy is declared
statically in [`docker/toxiproxy.json`](../docker/toxiproxy.json) and
loaded at container start.

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
`packages/server/src/db.ts` and `packages/server/src/table.ts`. IDE
hover and `tsgo` consume it directly — there is no rendered markdown
ref to regenerate.

## The verification ritual

```sh
pnpm verify       # typecheck + lint — guaranteed green on main
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
  (`import { makeTable } from "./table"`).
- **`oxfmt --write` modifies files.** Use `format:check` if you only want
  to verify.
- **`tsgo` is the TS 7 native preview.** Errors look slightly different
  from `tsc` 5.x output but the diagnostics map 1:1.
- **Clock-skew tests are sensitive.** The protocol has a `LAG_WINDOW_MILLIS`
  (5s) tolerance — if your machine clock drifts > 5s from NTP, expect
  flakes in `time.test.ts` and `randomized.test.ts`.

## Debugging a flaky test

1. Reproduce: `pnpm test:randomize` runs the suite in a loop until
   something fails.
2. Narrow: copy the failing test name and run that file alone.
3. Logs: pass a `MetricsRecorder` (or wrap one) into the
   `ServerWriter` under test to observe internal events. The
   `db.write.*` metric names enumerated in
   `packages/server/src/server-writer.ts`'s JSDoc are the
   canonical event taxonomy.
4. Inspect Minio: when running against `dev:storage`, the Minio console at
   `http://localhost:9103` shows current bucket contents — useful for
   eyeballing manifest objects.
5. Toxiproxy: failures only with Toxiproxy in the loop usually mean a
   resilience gap. The static proxy lives in `docker/toxiproxy.json`;
   add toxics at runtime with the admin API on `:8474`
   (`POST /proxies/minio/toxics`) or via `toxiproxy-cli`.

## Project layout

The module map lives in [CLAUDE.md → Module map](../CLAUDE.md#module-map);
the deeper dependency graph + lifecycles live in
[ARCHITECTURE.md](ARCHITECTURE.md). For a flat enumeration, just `ls
packages/*/src/ tests/`.
