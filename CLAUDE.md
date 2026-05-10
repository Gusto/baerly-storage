# CLAUDE.md

Guidance for AI coding agents working in this repo. Keep this file lean —
only content that **cannot be inferred from the code** belongs here.

## What this is

**baerly-storage** is a vendorless document database that runs over
any S3-compatible storage API. The data lives in your bucket; the
protocol kernel is small enough that an LLM can use the public API
zero-shot from the `.d.ts` files alone. Theoretical foundations live
in [docs/](docs/).

Status: under heavy redesign — see
[`.claude/research/00-plan.md`](.claude/research/00-plan.md). The
project was MPS3 (browser-direct multiplayer); it is becoming Baerly
(Worker-fronted server). The protocol kernel survives both; the
deployment shape is changing.

## Toolchain

- **Package manager:** pnpm (`packageManager: pnpm@10.31.0`).
- **Test runner:** vitest (`vitest run`). Tests import from `"vitest"`.
- **Type checker:** TypeScript 7 / `tsgo` (`@typescript/native-preview`).
- **Formatter:** oxfmt.
- **Linter:** oxlint.
- **Bundler:** rolldown (`rolldown.config.ts`).

Don't introduce alternate tooling without justification.

## Verification

| Command | What it catches | Runtime | Clean on `main`? |
|---|---|---|---|
| `pnpm verify` | typecheck (`tsgo --noEmit`) + lint (`oxlint`) | ~seconds | ✅ — non-zero exit *is* your regression |
| `pnpm test` | vitest unit + integration (zero infra) | ~1s | ✅ — Minio + credentials tests are gated, see below |
| `pnpm test:minio` | adds the Minio-gated suites (`randomized`, `time` + Minio variants) | ~30s | ✅ when `pnpm dev:storage` is up |
| `pnpm test:conformance` | adds `conformance.test.ts` (needs Minio + credentials files) | ~30s | requires credentials in `credentials/{aws,gcs,cloudflare}.json` |
| `pnpm format:check` | oxfmt formatting | ~seconds | ❌ red on ~20 pre-existing files; diff vs. `main` |
| `pnpm build` | rolldown bundle to `dist/` | ~seconds | ✅ |
| `pnpm test:randomize` | property-based fuzzer (cranks `FC_NUM_RUNS` for fast-check arbitraries) | run for minutes | use when changing protocol code |
| `pnpm dev:storage` | brings up Minio `:9102` + Toxiproxy `:9104` | n/a | required for `test:minio` / `test:conformance` |

`pnpm verify` is also enforced as a [lefthook](https://lefthook.dev/)
pre-commit hook (`lefthook.yml`); `pnpm install` wires it up via the
`prepare` script. Bypass with `git commit --no-verify` when needed.

### Test gating

`pnpm test` runs green on a fresh checkout with zero infrastructure
deps. Tests requiring Minio or credentials are gated by env:

- **Minio-required tests** (the `clock behavior` block of
  `tests/integration/time.test.ts`, and the `useVersioning` / `minio`
  variants of `tests/integration/randomized.test.ts`) skip by default.
  Run them with `MINIO=1 pnpm test` (alias: `pnpm test:minio`) after
  `pnpm dev:storage`.
- **`tests/integration/conformance.test.ts`** needs both Minio and
  credentials in `credentials/{aws,gcs,cloudflare}.json` (gitignored).
  Excluded from the default test glob. Run with `pnpm test:conformance`.

`randomized.test.ts` runs by default against an in-memory `Storage`
impl (`MemoryStorage` in `@baerly/protocol`, served as a `fetchFn`
via `fetchFnFromStorage`) — the property-based causal-consistency
checker is the highest-leverage test asset and now runs in <1s on
every PR.

Pure-unit tests that always pass: `packages/protocol/src/hashing.test.ts`,
`tests/unit/consistency.test.ts`, `packages/protocol/src/xml.test.ts`,
`packages/protocol/src/json.test.ts`,
`tests/unit/datatypes.test.ts`,
`tests/integration/bundle-size.test.ts`,
`tests/integration/put-all-partial-failure.test.ts`,
`tests/regressions.test.ts`.

## Local dev

Integration tests can run against a local Minio + Toxiproxy stack:

```sh
pnpm dev:storage         # docker-compose up -d (Minio :9102, Toxiproxy :9104)
pnpm dev:storage:stop    # docker-compose down
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for full setup.

## Module map

Read in this order to build a mental model:

1. `src/index.ts` — public barrel; bundler entry point.
2. `src/mps3.ts` — public `MPS3` class.
3. `src/manifest.ts`, `src/syncer.ts` — protocol core wiring.
4. `src/s3-client-lite.ts` — storage layer.
5. **`@baerly/protocol`** (pure modules; no I/O):
   `packages/protocol/src/json.ts`, `packages/protocol/src/types.ts`,
   `packages/protocol/src/constants.ts`,
   `packages/protocol/src/errors.ts`,
   `packages/protocol/src/hashing.ts`,
   `packages/protocol/src/o-map.ts`,
   `packages/protocol/src/time.ts`,
   `packages/protocol/src/xml.ts`,
   `packages/protocol/src/storage/` (`Storage` interface +
   `MemoryStorage` impl + `fetchFnFromStorage` adapter).
6. **`src/`** (impure utilities still being carved):
   `src/s3-types.ts`.

The full lifecycle of `put()` and `subscribe()` is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — read it before
changing `syncer.ts` or `manifest.ts`. ARCHITECTURE.md also has a
Mermaid dependency graph if you need finer-grained roles than the
groups above.

## When editing X, read Y

Path-scoped conventions. **Read the matching file before editing.**

| When you're editing… | Read first |
|---|---|
| `src/**/*.ts` (excluding tests) | [docs/conventions/src.md](docs/conventions/src.md) |
| `src/**/*.test.ts`, `tests/**` | [docs/conventions/tests.md](docs/conventions/tests.md) |
| `docs/**` | [docs/conventions/docs.md](docs/conventions/docs.md) |
| `src/syncer.ts`, `src/manifest.ts` | [docs/sync_protocol.md](docs/sync_protocol.md) + [docs/causal_consistency_checking.md](docs/causal_consistency_checking.md) |
| `packages/protocol/src/json.ts` | [docs/JSON_merge_patch.md](docs/JSON_merge_patch.md) |
| Public API on `MPS3` | [docs/EXTENDING.md](docs/EXTENDING.md) |

Claude users: `.claude/rules/{src,tests,docs}.md` auto-load on matching
edits and point at the same files.

## Conventions

- **Imports are relative.** `tsconfig.json` uses `moduleResolution: "bundler"`
  and no `baseUrl`. Inside `src/` write `import { Ref } from "./types"`.
- **Branded types are load-bearing.** `Ref`, `ManifestKey`, `UUID`,
  `VersionId` exist to prevent confusion bugs. Don't paper over a type
  mismatch with `as string`; widen only if you understand why.
- **Magic values live in `packages/protocol/src/constants.ts`** with a JSDoc citing where the
  value comes from (often `docs/sync_protocol.md`).
- **Errors must be `MPS3Error` instances.** Use the `code` discriminant
  (`error.code === "NetworkError"`), not `instanceof` chains. Hierarchy
  lives in `packages/protocol/src/errors.ts`.
- **Tests use vitest.** `import { describe, test, it, expect } from "vitest"`.
  Don't add jest, mocha, or `bun:test`. IndexedDB is mocked via
  `import "fake-indexeddb/auto"`.
- **Public API docs live as JSDoc on `src/mps3.ts`.** IDE hover and
  tsgo consume them directly — no rendered markdown ref to maintain.
- **Causal consistency is a hard invariant.** [docs/sync_protocol.md](docs/sync_protocol.md)
  and [docs/causal_consistency_checking.md](docs/causal_consistency_checking.md)
  describe how it works. Read those before touching `syncer.ts` or
  `manifest.ts`.

## Anti-patterns

- ❌ Adding dependencies. The runtime footprint is intentionally small
  (`aws4fetch`, `idb-keyval`, `@xmldom/xmldom`). Justify any addition.
- ❌ Widening a branded type to its base (`as string`, `as number`).
- ❌ Skipping or `.skip()`'ing a test to ship. If a test is wrong, fix it;
  if the code is wrong, fix the code.
- ❌ Hard-coding new magic numbers. Add to `packages/protocol/src/constants.ts`.
- ❌ Reintroducing `bun:test`, Rome, or baseUrl imports — all replaced.

## Scope guidance

- **Bugfix?** Reproduce with a failing test first. Pick the right test file
  by topic (`json.test.ts`, `time.test.ts`, etc.).
- **New public API method on `MPS3`?** See [docs/EXTENDING.md](docs/EXTENDING.md).
  Add JSDoc with `@example` — IDEs and tsgo consume it directly.
- **Touching the sync protocol?** Read `docs/sync_protocol.md` and
  `docs/causal_consistency_checking.md`. Add a property-based test in
  `tests/integration/randomized.test.ts` or a check in
  `tests/unit/consistency.test.ts`.
- **Performance change?** Run `pnpm test:randomize` for a few minutes.
  Randomized tests catch races the conformance suite misses.

## Pointers

- Feature → code map: [docs/features.md](docs/features.md)
- Architecture overview: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Local dev setup: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- How to add a feature / module / test: [docs/EXTENDING.md](docs/EXTENDING.md)
- Protocol theory: [docs/sync_protocol.md](docs/sync_protocol.md),
  [docs/causal_consistency_checking.md](docs/causal_consistency_checking.md),
  [docs/JSON_merge_patch.md](docs/JSON_merge_patch.md)
- Architecture decisions ("why"): [docs/adr/](docs/adr/)
- Troubleshooting: [docs/troubleshooting.md](docs/troubleshooting.md)
- Path-scoped conventions: [docs/conventions/](docs/conventions/) (table at top)
