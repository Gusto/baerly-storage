---
title: CLAUDE.md — agent guidance for baerly-storage
audience: agent
summary: Toolchain, verification matrix, module map, conventions, anti-patterns. The main agent entry point.
last-reviewed: 2026-05-12
tags: [agent-entry, conventions, verification]
related: ["docs/README.md", "docs/contributing/architecture.md", "docs/contributing/development.md"]
---

# CLAUDE.md

Guidance for AI coding agents working in this repo. Keep this file lean —
only content that **cannot be inferred from the code** belongs here.

## What this is

**baerly-storage** is a vendorless document database that runs over
any S3-compatible storage API. The data lives in your bucket; the
protocol kernel is small enough that an LLM can use the public API
zero-shot from the `.d.ts` files alone. Theoretical foundations live
in [docs/](docs/).

**Current state:** Private Gusto preview, published as
`@gusto/baerly-storage` to Gusto's private npm registry. See
[`docs/contributing/publishing.md`](docs/contributing/publishing.md) for
the publish workflow.

The protocol kernel and HTTP server are landed. Day-1 templates ship
for Cloudflare Workers and self-hosted Node; both are first-class.
AWS Lambda / Bun / Deno / Fly are an adapter package away.

## Toolchain

- **Package manager:** pnpm (`packageManager: pnpm@11.1.2`).
- **Test runner:** vitest (`vitest run`). Tests import from `"vitest"`.
- **Type checker:** TypeScript 7 / `tsgo` (`@typescript/native-preview`).
- **Formatter:** oxfmt.
- **Linter:** oxlint.
- **Bundler:** rolldown (`rolldown.config.ts`).

Don't introduce alternate tooling without justification.

## Verification

Under Claude Code, `vitest` runs use the compact `minimal` reporter —
vitest 4.1 auto-detects AI-agent environments, and the repo config
(`vitest.config.ts`) additionally pins this behavior when
`CLAUDECODE=1` is set so it isn't silently broken by detection
changes. Failures still print in full. Override with
`--reporter=dot` for long suites (`test:randomize`,
`test:fuzz-phase5`) when progress signal matters more than
compactness, or `--reporter=default` to force the full reporter.
`pnpm verify` / `pnpm test` is what humans + the lefthook
pre-commit hook run; `pnpm verify:agent` / `pnpm test:agent` are
explicit compact-output variants for environments where the env
var isn't propagated.

> **Agents: don't pipe `verify:agent` / `test:agent` through `| tail -N` or `| head -N`.** Both scripts are already compact — one finding per line, with full detail preserved on failures. Piping to `tail`/`head` removes the lines you need; if the first run prints nothing useful, the *output is empty because the gate passed*, not because the tail was wrong. Same applies to `pnpm bundle-sizes`.

| Command | What it catches | Runtime | Clean on `main`? |
|---|---|---|---|
| `pnpm verify` | typecheck (`tsgo --noEmit`) + `verify:examples` + lint (`oxlint`) | ~seconds | ✅ — non-zero exit *is* your regression |
| `pnpm verify:agent` | same gate as `pnpm verify`, with `tsgo --pretty false` + `oxlint --format=unix --quiet` for one-line-per-finding output (warnings hidden — `pnpm verify` still surfaces them) | ~seconds | ✅ — same gate as `verify`, just quieter |
| `pnpm verify:examples` | runs each scaffoldable example's `tsc -b --noEmit` (`minimal-cloudflare`, `minimal-node`, `react-cloudflare`, `react-node`) so SPA + Worker bugs in the templates fail fast | ~seconds | ✅ |
| `pnpm test` | vitest unit + integration (zero infra) — includes the `memory` + `local-fs` variants of `randomized.test.ts` | ~3s | ✅ — Minio + credentials tests are gated, see below |
| `pnpm test:agent` | same gate as `pnpm test`, with `--reporter=minimal --silent=passed-only` baked in (failures still full-detail). Works regardless of `CLAUDECODE` | ~3s | ✅ — same gate as `test`, just quieter |
| `pnpm test:minio` | adds the Minio-gated suites: the `clock behavior` block of `time.test.ts`, the `node-minio` variant of `randomized.test.ts`, and `adapter-node` Minio conformance | ~10s | ✅ when `pnpm dev:storage` is up |
| `pnpm test:conformance` | adds `conformance.test.ts` (needs Minio + credentials files) | ~30s | requires credentials in `credentials/{aws,gcs,cloudflare}.json` |
| `pnpm test:export-smoke` | adds `export-smoke.test.ts` (`LogEntry` round-trip into Postgres; needs local Postgres on `:5433`) | ~5s | ✅ when `pnpm dev:storage` is up |
| `pnpm test:export-round-trip` | full export → SQLite → restore → byte-equal dump | ~5–10s | ✅ when `sqlite3` is on PATH (auto-skips otherwise) |
| `pnpm test:adapter-cloudflare` | runs `r2BindingStorage` conformance, the `cloudflare-r2` variant of `randomized.test.ts`, the `cloudflare-r2` variant of `collection-api.test.ts`, **and** the `cloudflare-r2` variant of `http-conformance.test.ts` under miniflare (`@cloudflare/vitest-pool-workers`, project `cloudflare-pool`) | ~3s | ✅ — first run downloads the `workerd` binary |
| `pnpm test:http-conformance` | runs the HTTP cascade on `memory` + `local-fs` (default project) | ~3s | ✅ |
| `pnpm test:adapter-node` | runs `s3HttpStorage` conformance against local Minio | ~10s | ✅ when `pnpm dev:storage` is up |
| `pnpm test:adapters` | sequential wrapper: `test:adapter-cloudflare` then `test:adapter-node` | ~10s | ✅ when `pnpm dev:storage` is up |
| `pnpm format:check` | oxfmt formatting | ~seconds | ❌ red on ~20 pre-existing files; diff vs. `main` |
| `pnpm build` | rolldown bundle to `dist/` | ~seconds | ✅ |
| `pnpm test:randomize` | property-based fuzzer (cranks `FC_NUM_RUNS` for fast-check arbitraries). The randomized cascade itself is fault-injection-driven so `FC_NUM_RUNS` is a no-op for `randomized.test.ts` — all four variants (`memory` / `local-fs` / `cloudflare-r2` / `node-minio`) still run, but only the property tests in the rest of the suite scale up | run for minutes | use when changing protocol code |
| `pnpm test:fuzz-phase5` | crash-injection fuzzer for the maintenance loop (`phase5-crash-fuzz.test.ts`) — aborts the K-th storage op inside `ServerWriter` / `compact()` / `runGc()` and asserts the reader still sees a consistent row set | minutes-hours at `FC_NUM_RUNS=10000` | use after touching `compactor.ts` / `gc.ts` / `server-writer.ts` |
| `pnpm worktree:bootstrap` | `pnpm install --frozen-lockfile` + `pnpm run build`. Run this once after `git worktree add` to prime `dist/` so `baerly`, `pnpm bundle-sizes`, and any dist-consuming test work. `verify:agent` itself doesn't need it; everything else does | ~10-30s | n/a |
| `pnpm dev:storage` | brings up Minio `:9102` + Toxiproxy `:9104` + Postgres `:5433` | n/a | required for `test:minio` / `test:conformance` / `test:export-smoke` / `test:adapter-node` / `test:adapters` |
| `pnpm test:manual-e2e` | runs `manual-e2e/cloudflare/e2e.test.ts` + `manual-e2e/node/e2e.test.ts` against deployed URLs (HTTP conformance cascade + latency probe + long-poll wall-clock + 401 sniff) | minutes per run | requires `CF_DEPLOY_URL` + `NODE_DEPLOY_URL` + `SHARED_SECRET` (+ `CF_R2_*` / `AWS_*` for the conformance cascade); manual deploy lifecycle in `manual-e2e/README.md` |
| `pnpm bench:r2` | one-shot R2-contention bench (S1 / S2-idle / S3-toxic); validates the idle-reader bound on the wire — exit 0 when bound holds, 1 when violated | ~1–5 min per scenario | requires `pnpm dev:storage`; see `bench/README.md` |
| `pnpm bench:load` | one-shot load harness on memory backend (no infra); writes one JSON per run to `bench/results/load/` | ~seconds per preset | ✅ on `main` — no infra required; see `bench/README.md` |
| `pnpm bench:load:minio` | same as `bench:load` but with `--variant=node-minio` against local Minio | ~30s–2 min per preset | requires `MINIO=1` + `pnpm dev:storage` |
| `pnpm bench:load:matrix` | sequential sweep over presets × variants × cache modes; writes one timestamped subdirectory under `bench/results/load/` | minutes–tens of minutes | partial: `memory` + `local-fs` rows always; `node-minio` rows require `MINIO=1` + `pnpm dev:storage` |
| `pnpm bench:lsn-reverse-walk` | quantifies bytes-listed reduction of descending base-32 LSN encoding vs. ascending forward-list + in-memory reverse (patent C3 evidence). Populates 100k synthetic LSN-shaped keys into two `MemoryStorage` buckets (DESC + ASC arms), measures sum-of-key-lengths yielded by `Storage.list` for K∈{10,100,1000,10000}, writes JSON to `bench/results/lsn-reverse-walk/`. Baseline checked in at `docs/spec/attachments/lsn-reverse-walk-baseline.json` | ~seconds | ✅ no infra |
| `pnpm build && pnpm baerly deploy` | runs `baerly deploy` for a scaffolded app; dispatches on `baerly.config.ts:target`. Deploys to Cloudflare via `wrangler deploy --x-provision --x-auto-create` with a `wrangler r2 bucket create` fallback. The `node` target self-deploys via your PaaS, VM, or container build (`docker build` with `--with=docker`), so it is not accepted here | seconds to minutes | requires `wrangler login` |
| `baerly doctor --target=cloudflare` | walks the deploy invariants and reports findings: wrangler.jsonc, R2 bindings, required secrets, CF Access audience tag, cron triggers, domain/routes coherence | seconds | requires `wrangler login`; `--fix` auto-creates missing R2 buckets |
| `pnpm build && pnpm baerly export --target=sqlite ...` | snapshot dump one collection to SQL | seconds | ✅ no infra |
| `pnpm build && pnpm baerly {init,inspect,admin dump,admin restore} ...` | operator surface: `init` drops `baerly.config.ts` into an existing repo; `inspect` prints a read-only summary of one collection's snapshot / log / index state; `admin dump` emits canonical NDJSON of the materialised view; `admin restore` re-imports that NDJSON into a fresh bucket | seconds | ✅ no infra |
| `pnpm build && pnpm baerly admin fsck ...` | maintenance surface: `admin fsck` walks `current.json` → snapshot hash → log range → index prefixes read-only and exits 4 on any finding | seconds | ✅ no infra |
| `pnpm dlx:bust-cache` | wipes `~/.cache/pnpm/dlx` + `~/Library/Caches/pnpm/dlx` + `localhost+4873` registry metadata. Use after `pnpm verdaccio:publish` when iterating `pnpm create @gusto/baerly-storage@latest` against Verdaccio — dlx caches by `pkg@version` so re-publishing the same version is invisible without this step. `pnpm config get cache-dir` prints the literal string `"undefined"` — don't probe it manually | ~ms | ✅ |
| `cat node_modules/@gusto/baerly-storage/dist/API.md` | 367-line public-API quickref. Read this BEFORE walking the hash-suffixed `dist/*.d.ts` chain. Named `API.md` (not `AGENTS.md`) so it never collides with a scaffolded app's project-root `AGENTS.md`. Source lives at `packages/server/API.md`; the rolldown `closeBundle` step copies it to `dist/API.md` on every build | n/a | ✅ |

`pnpm verify` is also enforced as a [lefthook](https://lefthook.dev/)
pre-commit hook (`lefthook.yml`); `pnpm install` wires it up via the
`prepare` script. Bypass with `git commit --no-verify` when needed.

### Test gating

`pnpm test` runs green on a fresh checkout with zero infrastructure
deps. Tests requiring Minio or credentials are gated by env:

- **Minio-required tests** (the `clock behavior` block of
  `tests/integration/time.test.ts`, and the `node-minio` variant of
  `tests/integration/randomized.test.ts`) skip by default. Run them
  with `MINIO=1 pnpm test` (alias: `pnpm test:minio`) after
  `pnpm dev:storage`.
- **`tests/integration/conformance.test.ts`** needs both Minio and
  credentials in `credentials/{aws,gcs,cloudflare}.json` (gitignored).
  Excluded from the default test glob. Run with `pnpm test:conformance`.
- **`tests/integration/export-smoke.test.ts`** needs a local Postgres
  on `127.0.0.1:5433` (provisioned by `pnpm dev:storage`). Excluded
  from the default test glob. Run with `pnpm test:export-smoke`.
- **`packages/adapter-cloudflare/src/r2-binding-storage.conformance.test.ts`**
  runs inside Workerd via the `cloudflare-pool` vitest project
  (`@cloudflare/vitest-pool-workers`, miniflare-backed). The R2
  binding `BUCKET` is wired in `vitest.config.ts` and re-published
  on `globalThis.__BAERLY_R2_BINDING__` by `tests/setup/r2-binding.ts`
  so the conformance factory can consume it. Excluded from the
  default project's glob; run with `pnpm test:adapter-cloudflare`
  (the script also sets `ADAPTER_CLOUDFLARE=1` for any future
  in-test conditionals). No external network, no credentials.
- **`packages/adapter-node/src/s3-http.conformance.test.ts`** runs
  against the same local Minio that `pnpm dev:storage` provisions.
  Gated by `MINIO=1` via `describe.runIf`; the bucket
  `baerly-conformance-adapter-node` is auto-created in the suite's
  `beforeAll` (409 BucketAlreadyOwnedByYou is tolerated). Run with
  `pnpm test:adapter-node`, or both adapter suites in sequence
  with `pnpm test:adapters`.
- **`tests/integration/collection-api.test.ts`** drives the locked
  `db.collection(...).{first,all,count,insert,update,replace,delete}` and
  `db.transaction(...)` surface across three Node-side adapters
  (`memory`, `local-fs`, `node-minio`). `memory` + `local-fs` run by
  default; `node-minio` is gated on `MINIO=1` (via
  `pnpm test:minio`). The Workerd-side `cloudflare-r2` variant lives
  at `packages/adapter-cloudflare/src/collection-api.test.ts` and runs
  under the `cloudflare-pool` vitest project (via
  `pnpm test:adapter-cloudflare`). All variants share the
  backend-agnostic driver in `tests/fixtures/collection-api-cascade.ts`.
- **`tests/integration/phase5-end-to-end.test.ts`** is the end-to-end
  durability gate: seeds 5000 entries, runs
  `runScheduledMaintenance` to quiescence, then asserts find()
  parity, bucket-object-count drop, `log_seq_start` advance, and the
  "< 1 Class A op / writer / hour" idle-reader cost-model bound via
  a hand-rolled counting `Storage` proxy. Runs `memory` + `local-fs`
  variants in the default project; `node-minio` and `cloudflare-r2`
  are deferred.

`randomized.test.ts` drives the all-to-all single-key causal-
consistency cascade through `Db` + `ServerWriter` (from
`@baerly/server`) over four storage adapters:

  - `memory` — `MemoryStorage`, shared per-bucket via
    `getOrCreateMemoryStorageForBucket`. Default project, no infra,
    runs in <1s on every PR.
  - `local-fs` — `LocalFsStorage` over a fresh `mkdtemp` root.
    Default project, no infra, runs in ~1s on every PR.
  - `cloudflare-r2` — `r2BindingStorage` over the miniflare R2 binding
    wired by `tests/setup/r2-binding.ts`. Lives at
    `packages/adapter-cloudflare/src/randomized.test.ts` and runs
    under the `cloudflare-pool` vitest project (Workerd). Excluded
    from the default glob; run with `pnpm test:adapter-cloudflare`.
  - `node-minio` — `S3HttpStorage` against Toxiproxy → Minio with a
    fault-injection twiddler flipping the proxy every 100 ms. Default
    project, gated on `MINIO=1`; run with `pnpm test:minio`.

The cascade body is shared across projects via
`tests/fixtures/randomized-cascade.ts` (Node-import-free, so it loads
inside Workerd). The Node-side variant table is in
`tests/integration/randomized.test.ts`; the Workerd-side entry is in
`packages/adapter-cloudflare/src/randomized.test.ts`. Each variant
constructs N `Storage` handles sharing the same backing store, then
spins up N `Db` + `ServerWriter` writers all contending on a single
`current.json`.

Pure-unit tests that always pass: `packages/protocol/src/hashing.test.ts`,
`tests/unit/consistency.test.ts`, `packages/protocol/src/xml.test.ts`,
`packages/protocol/src/json.test.ts`,
`packages/protocol/src/log.test.ts`,
`packages/protocol/src/storage/memory.test.ts`,
`packages/adapter-node/src/s3-http.test.ts`,
`packages/dev/src/local-fs.test.ts`,
`tests/unit/datatypes.test.ts`,
`tests/integration/bundle-size.test.ts`,
`tests/integration/log-emit.test.ts`,
`tests/integration/put-all-partial-failure.test.ts`,
`tests/regressions.test.ts`.

## Local dev

Integration tests can run against a local Minio + Toxiproxy stack:

```sh
pnpm dev:storage         # docker compose up -d --wait (Minio :9102, Toxiproxy :9104, Postgres :5433)
pnpm dev:storage:stop    # docker compose down
```

See [docs/contributing/development.md](docs/contributing/development.md) for full setup.

## Module map

Read in this order to build a mental model:

1. `packages/server/src/index.ts` — public barrel; bundler entry
   point. The `@gusto/baerly-storage` npm package is bundled from here.
2. `packages/server/src/db.ts` — the `Db` class. Public read/write
   surface for application code.
3. `packages/server/src/collection.ts`, `packages/server/src/query.ts` —
   `Collection<T>` / `Query<T>` SQL-shape API + predicate AST.
4. `packages/server/src/server-writer.ts` — `ServerWriter` stateless
   commit path: PUT content → PUT log entry → PUT/DELETE
   index entries → CAS-advance `current.json`.
5. `packages/server/src/indexes.ts` — `IndexDefinition`, key
   encoding (lex-order-preserving base-32), and per-doc projection
   helpers. Consumed by the writer's fence-time emission and by
   `rebuildIndex`.
6. `packages/server/src/rebuild-index.ts` — `rebuildIndex(storage,
   currentJsonKey, def)` idempotent reconciliation; what `baerly
   admin rebuild-index` calls.
7. `packages/server/src/compactor.ts`,
   `packages/server/src/gc.ts`,
   `packages/server/src/maintenance.ts` — durability sweep loops.
8. **`@baerly/protocol`** (pure modules; no I/O):
   `packages/protocol/src/json.ts`, `packages/protocol/src/types.ts`,
   `packages/protocol/src/constants.ts`,
   `packages/protocol/src/errors.ts`,
   `packages/protocol/src/hashing.ts`,
   `packages/protocol/src/o-map.ts`,
   `packages/protocol/src/time.ts`,
   `packages/protocol/src/xml.ts`,
   `packages/protocol/src/collection-api.ts` (on-the-wire
   `Collection`/`Query`/`Predicate` contracts),
   `packages/protocol/src/query/` (validate / matches / merge —
   the kernel half of the predicate algebra),
   `packages/protocol/src/storage/` (`Storage` interface +
   `MemoryStorage` only — concrete S3/R2 adapters live in
   `@baerly/adapter-node` / `@baerly/adapter-cloudflare`).
9. **`@baerly/dev`** (Node-only `Storage` impls + dev harness):
   `packages/dev/src/local-fs.ts` (`LocalFsStorage` — directory-tree
   `Storage` with content-addressed ETags and atomic writes; used by
   future `baerly dev` and by tests that need cross-`Db`-instance
   visibility without Minio).
10. **`manual-e2e/`** — manual end-to-end check that drives the
   HTTP conformance cascade + latency / long-poll / 401 probes
   against real R2 / real S3. Each subdir now holds only its
   `e2e.test.ts`; the deploy artifacts are the production scaffolds
   `examples/minimal-cloudflare` (via `pnpm baerly deploy`) and
   `examples/minimal-node --with=docker` (via `docker build && docker
   run`). Manual lifecycle in `manual-e2e/README.md`; driven by
   `pnpm test:manual-e2e`. Sits at the root alongside `bench/`
   because it's manual maintainer infrastructure, not part of the
   automated test suite.
11. **`examples/`** — runnable example apps that double as the CLI
   template source. `examples/minimal-cloudflare/` (R2 +
   `cloudflareAccess`→`sharedSecret`), `examples/minimal-node/`
   (S3 + JWKS→`sharedSecret`, any host that runs `node server.js`),
   `examples/react-cloudflare/` (full React + Vite SPA over a
   `NoteSchema` collection; dev uses workerd-in-Vite via
   `@cloudflare/vite-plugin` + `baerlyDevAuth` from
   `@gusto/baerly-storage/dev/vite`), and `examples/react-node/` (same SPA +
   `NoteSchema`; dev uses `baerlyDev()` from `@gusto/baerly-storage/dev/vite`
   over `LocalFsStorage` as a single-Vite-process middleware) are the
   production-shaped scaffolds. Each scaffoldable example carries
   a `.baerly/scaffold.json` manifest declaring rename sentinels,
   copy exclusions, and devDep drops. The CLI consumes them at
   scaffold time via `STARTER_TO_EXAMPLE` in
   `packages/create-baerly-storage/src/scaffold.ts`; the rolldown build
   copies them into `dist/templates/<name>/` so the published
   `@gusto/create-baerly-storage` binary is self-contained.
   Opt-in add-ons live alongside the examples at
   `packages/create-baerly-storage/templates/addons/<name>/` (today: just
   `docker/` — Dockerfile + healthcheck.js + .dockerignore). The
   scaffolder layers an add-on on top of the base template when
   `--with=<name>` is passed (Docker requires `--target=node`).
   `rolldown.config.ts` mirrors `templates/addons/` into
   `dist/templates/addons/` so the published binary ships them too.
   Catalog index in `examples/README.md`. See `packages/create-baerly-storage/AGENTS.md` for the full scaffold pipeline (examples → dist/templates → tgz → user dir).

The full lifecycle of `db.collection().insert()` is in
[docs/contributing/architecture.md](docs/contributing/architecture.md) — read it before
changing `packages/server/src/server-writer.ts` or the query
evaluation path. architecture.md also has a Mermaid dependency
graph if you need finer-grained roles than the groups above.

## When editing X, read Y

Path-scoped conventions. **Read the matching file before editing.**

| When you're editing… | Read first |
|---|---|
| `tests/**` | [docs/contributing/conventions/tests.md](docs/contributing/conventions/tests.md) |
| `docs/**` | [docs/contributing/conventions/docs.md](docs/contributing/conventions/docs.md) |
| `packages/server/src/server-writer.ts` | [docs/spec/sync-protocol.md](docs/spec/sync-protocol.md) + [docs/spec/causal-consistency-checking.md](docs/spec/causal-consistency-checking.md) |
| `packages/protocol/src/json.ts` | [docs/spec/json-merge-patch.md](docs/spec/json-merge-patch.md) |
| `packages/protocol/src/log.ts`, the log-emit path in `server-writer.ts` | [docs/spec/log-entry-shape.md](docs/spec/log-entry-shape.md) |
| `packages/server/src/observability/**` | [docs/contributing/conventions/observability.md](docs/contributing/conventions/observability.md) |
| Public API on `Db` / `Collection` | [docs/contributing/extending.md](docs/contributing/extending.md) |
| `packages/server/src/schema.ts` or `CollectionDefinition.schema` | [docs/contributing/extending.md](docs/contributing/extending.md) §"Declare a schema for a collection" |

Claude users: `.claude/rules/{tests,docs,change-discipline}.md`
auto-load on matching edits and point at the same files.

## Conventions

- **Imports are relative, with explicit `.ts`/`.tsx` extensions.**
  `tsconfig.json` uses `moduleResolution: "bundler"` and no `baseUrl`.
  Inside `packages/server/src/` write
  `import { UUID } from "@baerly/protocol"` for cross-package types
  and `import { makeCollection } from "./collection.ts"` for siblings. The
  `.ts` extension is required so that Node's native
  `--experimental-strip-types` runtime — used by the
  `examples/minimal-node/` and `examples/react-node/` scaffolds,
  which consume the workspace `exports."."` → `./src/*.ts` paths
  directly — can resolve relative specifiers. Enforced by
  oxlint (`import/extensions: ["error", "always", { ignorePackages: true }]`);
  `scripts/add-ts-extensions.mjs --check` audits the full repo
  including `bench/`, `manual-e2e/`, `examples/`, and `*.config.ts`.
- **Branded types are load-bearing.** `UUID` and `ContentVersionId`
  exist to prevent confusion bugs. Don't paper over a type
  mismatch with `as string`; widen only if you understand why.
- **Magic values live in `packages/protocol/src/constants.ts`** with a JSDoc citing where the
  value comes from (often `docs/spec/sync-protocol.md`).
- **Errors must be `BaerlyError` instances** (re-exported from
  `@baerly/protocol`). Use the `code` discriminant
  (`error.code === "NetworkError"`), not `instanceof` chains. Hierarchy
  lives in `packages/protocol/src/errors.ts`.
- **Tests use vitest.** `import { describe, test, it, expect } from "vitest"`.
  Don't add jest, mocha, or `bun:test`.
- **Public API docs live as JSDoc on `packages/server/src/db.ts` and
  `packages/server/src/table.ts`.** IDE hover and tsgo consume them
  directly — no rendered markdown ref to maintain.
- **Causal consistency is a hard invariant.** [docs/spec/sync-protocol.md](docs/spec/sync-protocol.md)
  and [docs/spec/causal-consistency-checking.md](docs/spec/causal-consistency-checking.md)
  describe how it works. Read those before touching
  `packages/server/src/server-writer.ts`.

## Anti-patterns

- ❌ Adding **runtime** dependencies to anything that ships to user
  apps. The runtime footprint of `baerly-storage` and the adapters
  is intentionally small (`aws4fetch`, `fast-xml-parser`, `hono`,
  `jose`); every additional dep widens the kernel bundle
  and the audit surface for users. Justify any addition.
- ✅ **Build-time / CLI / dev-tooling deps are fair game.** Inside
  `packages/create-baerly-storage/`, `packages/cli/`, `packages/dev/`,
  `bench/`, `manual-e2e/`, `scripts/`, and `examples/*/devDependencies`,
  prefer a well-maintained dep over reinventing it in-house. None
  of this code ends up in a user's production bundle, so the
  trade-off flips: the cost is one more line in our lockfile, the
  benefit is less undifferentiated heavy lifting we own forever.
  Examples worth reaching for here: `@clack/prompts`,
  `nypm`, `citty`. Still pick maintained, narrow,
  ESM-friendly packages — but the default answer is "yes, take the
  dep" rather than "justify it."
- ❌ Widening a branded type to its base (`as string`, `as number`).
- ❌ Skipping or `.skip()`'ing a test to ship. If a test is wrong, fix it;
  if the code is wrong, fix the code.
- ❌ Hard-coding new magic numbers. Add to `packages/protocol/src/constants.ts`.
- ❌ Reintroducing `bun:test`, Rome, or baseUrl imports — all replaced.
- ❌ Extensionless relative imports (`from "./foo"`). Always write
  `from "./foo.ts"` or `from "./foo/index.ts"`. Node's
  strip-types runtime can't resolve them; oxlint's
  `import/extensions` rule fails the lint.
- ❌ Calling `vitest` via `pnpm exec vitest` or `./node_modules/.bin/vitest` —
  both skip the `pretest` hook (`pnpm run build`), leaving `dist/` empty or
  stale and producing spurious failures in bundle-size / dist-consuming tests.
  Use `pnpm test:agent` or `pnpm bundle-sizes` (whose script self-builds).
  Same idea for the other tools: prefer `pnpm verify:agent` / `pnpm build`
  over `pnpm exec tsgo` / `pnpm exec rolldown` so the canonical flags
  (`--pretty false`, `--format=unix --quiet`, etc.) come along.
- ❌ Probing `pnpm config get cache-dir` to locate the dlx cache. It
  returns the literal string `"undefined"` when not explicitly set
  (the default), so `rm -rf "$(pnpm config get cache-dir)/dlx"` is a
  silent no-op that exits 0. The real dlx cache lives at `~/.cache/pnpm/dlx`
  (Linux/XDG) or `~/Library/Caches/pnpm/dlx` (macOS) — both can
  exist. Use `pnpm dlx:bust-cache` instead.

## Scope guidance

- **Bugfix?** Reproduce with a failing test first. Pick the right test file
  by topic (`json.test.ts`, `time.test.ts`, etc.).
- **New public API method on `Db` / `Collection`?** See [docs/contributing/extending.md](docs/contributing/extending.md).
  Add JSDoc with `@example` — IDEs and tsgo consume it directly.
- **Touching the sync protocol?** Read `docs/spec/sync-protocol.md` and
  `docs/spec/causal-consistency-checking.md`. Add a property-based test in
  `tests/integration/randomized.test.ts` or a check in
  `tests/unit/consistency.test.ts`.
- **Performance change?** Run `pnpm test:randomize` for a few minutes.
  Randomized tests catch races the conformance suite misses.
- **Scoping from an inbound brief / gap report?** Verify each cited
  file:line and each named feature with `grep` / `Read` before
  drafting tickets. Inbound briefs can hallucinate file paths,
  miscount the API surface, or claim missing features that already
  exist. ~10 minutes of verification up front beats hours of work
  stuck on phantom references.

## Pointers

- Doc topic map: [docs/README.md](docs/README.md) — start here if
  unsure where to look.
- Feature → code map: [docs/contributing/features.md](docs/contributing/features.md)
- Architecture overview: [docs/contributing/architecture.md](docs/contributing/architecture.md)
- Local dev setup: [docs/contributing/development.md](docs/contributing/development.md)
- How to add a feature / module / test: [docs/contributing/extending.md](docs/contributing/extending.md)
- Protocol theory: [docs/spec/sync-protocol.md](docs/spec/sync-protocol.md),
  [docs/spec/causal-consistency-checking.md](docs/spec/causal-consistency-checking.md),
  [docs/spec/json-merge-patch.md](docs/spec/json-merge-patch.md)
- Architecture decisions ("why"): [docs/adr/](docs/adr/)
- Troubleshooting: [docs/guide/troubleshooting.md](docs/guide/troubleshooting.md)
- Path-scoped conventions: [docs/contributing/conventions/](docs/contributing/conventions/) (table at top)
