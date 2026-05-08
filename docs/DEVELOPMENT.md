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
pnpm exec vitest run src/__tests__/json.test.ts   # one file
pnpm exec vitest run -t "subscribe"               # tests whose name matches
pnpm test:randomize                         # loop until a failure (soak)
```

Test files import from `"vitest"`:

```ts
import { test, expect, describe, beforeAll, afterEach } from "vitest";
```

IndexedDB is mocked via `import "fake-indexeddb/auto"` in tests that need it.

### Tests that pass without infrastructure

Pure-unit:
`hashing.test.ts`, `consistency.test.ts`, `xml.test.ts`, `json.test.ts`,
`datatypes.test.ts`.

### Tests that need a running Minio

`randomized.test.ts`, `offlinefirst.test.ts`, `replication.test.ts`,
`time.test.ts` connect to `http://127.0.0.1:9102` (Minio). Bring it up:

```sh
pnpm dev:storage      # docker-compose up -d
```

This starts:

- **Minio** on `http://127.0.0.1:9102` (S3 API), console on `:9103`.
  Credentials: `mps3` / `ZOAmumEzdsUUcVlQ` (dev only — see
  `docker-compose.yml`).
- **Toxiproxy** on `:9104` proxying to Minio. Used to inject latency,
  partial failures, and resets in resilience tests.

Stop everything with:

```sh
pnpm dev:storage:stop
```

### Tests that need real cloud credentials

`conformance.test.ts` and parts of `replication.test.ts` import JSON
credentials from `credentials/{aws,gcs,cloudflare}.json` (gitignored).
Without those files the test files will fail to load. That's expected for
a fresh checkout — only contributors with cloud accounts run them.

### Known stale tests

`operationQueue.test.ts` has a known mismatch: its assertions expect a
scalar where `flatten()` now returns a `[value, sequence]` tuple. These
failures are pre-existing — don't be fooled into thinking your change
broke them. (If you fix them, ensure the fix doesn't change runtime
behavior of `OperationQueue.flatten()`.)

## Type checking, formatting, linting

```sh
pnpm typecheck        # tsgo --noEmit (TypeScript 7 in strict mode)
pnpm format           # oxfmt src (writes in place)
pnpm format:check     # oxfmt --check src (no writes; CI mode)
pnpm lint             # oxlint src
```

## Building

```sh
pnpm build       # rolldown bundle to dist/ (mps3.js + mps3.d.ts)
```

Public-API documentation lives as JSDoc on `src/mps3.ts`. IDE hover
and `tsgo` consume it directly — there is no rendered markdown ref to
regenerate.

## The verification ritual

```sh
pnpm verify       # typecheck + lint — guaranteed green on main
pnpm test         # vitest run — has known baseline failures (see above)
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
  no `baseUrl`. Imports inside `src/` are relative: `import { Ref } from "./types"`.
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
3. Logs: pass `log: true` (or `log: console.log`) into the `MPS3` config in
   the test to see internal events. Logger format: `<label> <event> <context>`.
4. Inspect Minio: when running against `dev:storage`, the Minio console at
   `http://localhost:9103` shows current bucket contents — useful for
   eyeballing manifest objects.
5. Toxiproxy: failures only with Toxiproxy in the loop usually mean a
   resilience gap. The `toxiproxy-config-*` services in `docker-compose.yml`
   show how to inject faults.

## Project layout cheatsheet

```
src/
  mps3.ts            # public class
  manifest.ts        # poll loop + subscribers
  syncer.ts          # manifest log read/write
  operationQueue.ts  # local write buffer (IDB-backed)
  replication.ts     # multi-manifest writes
  S3ClientLite.ts    # HTTP S3 client
  json.ts            # RFC 7386 JSON Merge Patch
  types.ts           # branded types + Ref helpers
  constants.ts       # protocol constants
  errors.ts          # MPS3Error + code enum
  hashing.ts         # SHA-256 / base64
  time.ts            # base32 timestamp encoding
  xml.ts             # parse S3 XML responses
  OMap.ts            # ordered map keyed by Ref
  indexdb.ts         # IDB persistence helpers
  s3-types.ts        # minimal S3 wire-protocol types
  __tests__/         # all tests live here (vitest)

docs/
  ARCHITECTURE.md            # module map + lifecycles
  DEVELOPMENT.md             # this file
  EXTENDING.md               # how to add features / modules / tests
  sync_protocol.md           # protocol spec
  causal_consistency_checking.md
  JSON_merge_patch.md
  replication.md

.claude/
  rules/                     # path-scoped rules (src, tests, docs)

docker-compose.yml           # Minio + Toxiproxy for local integration tests
rolldown.config.ts           # bundler config
vitest.config.ts             # test runner config
```
