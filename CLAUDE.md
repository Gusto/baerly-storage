# CLAUDE.md

Guidance for AI coding agents working in this repo. Keep this file lean —
only content that **cannot be inferred from the code** belongs here.

## What this is

**MPS3** is a vendorless, causally consistent multiplayer document database
that runs entirely client-side over any S3-compatible storage API (S3, R2,
Backblaze, Minio). No server. The client polls a time-ordered manifest log
to sync state across writers. Theoretical foundations live in [docs/](docs/).

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
| `pnpm test:minio` | adds the Minio-gated suites (`randomized`, `offline-first`, `time` + Minio variants) | ~30s | ✅ when `pnpm dev:storage` is up |
| `pnpm test:conformance` | adds `conformance.test.ts` (needs Minio + credentials files) | ~30s | requires credentials in `credentials/{aws,gcs,cloudflare}.json` |
| `pnpm format:check` | oxfmt formatting | ~seconds | ❌ red on ~20 pre-existing files; diff vs. `main` |
| `pnpm build` | rolldown bundle to `dist/` | ~seconds | ✅ |
| `pnpm test:randomize` | property-based fuzzer (loops `pnpm test` until failure) | run for minutes | use when changing protocol code |
| `pnpm dev:storage` | brings up Minio `:9102` + Toxiproxy `:9104` | n/a | required for `test:minio` / `test:conformance` |

`pnpm verify` is also enforced as a [lefthook](https://lefthook.dev/)
pre-commit hook (`lefthook.yml`); `pnpm install` wires it up via the
`prepare` script. Bypass with `git commit --no-verify` when needed.

### Test gating

`pnpm test` runs green on a fresh checkout with zero infrastructure
deps. Tests requiring Minio or credentials are gated by env:

- **Minio-required tests** (`tests/integration/offline-first.test.ts`,
  the `clock behavior` block of `tests/integration/time.test.ts`, and
  the `useVersioning` / `minio` variants of
  `tests/integration/randomized.test.ts`) skip by default. Run them
  with `MINIO=1 pnpm test` (alias: `pnpm test:minio`) after
  `pnpm dev:storage`.
- **`tests/integration/conformance.test.ts`** needs both Minio and
  credentials in `credentials/{aws,gcs,cloudflare}.json` (gitignored).
  Excluded from the default test glob. Run with `pnpm test:conformance`.

`randomized.test.ts` runs by default against an in-memory `fetchFn`
adapter (`src/memory-fetch.ts`) — the property-based causal-consistency
checker is the highest-leverage test asset and now runs in <1s on
every PR.

Pure-unit tests that always pass: `src/hashing.test.ts`,
`tests/unit/consistency.test.ts`, `src/xml.test.ts`, `src/json.test.ts`,
`tests/unit/datatypes.test.ts`, `src/operation-queue.test.ts`,
`tests/integration/bundle-size.test.ts`,
`tests/integration/put-all-partial-failure.test.ts`,
`tests/regressions.test.ts`.

The `regressions.test.ts` suite includes one `test.fails` (session-ID
collision rate is too high — Phase 3 will fix) and one `test.todo`
(`useChecksum` flag disposition — Phase 1 picks). Both are
intentional and don't represent broken builds.

## Local dev

Integration tests can run against a local Minio + Toxiproxy stack:

```sh
pnpm dev:storage         # docker-compose up -d (Minio :9102, Toxiproxy :9104)
pnpm dev:storage:stop    # docker-compose down
```

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for full setup.

## Module map

Read in this order to build a mental model:

| File | Role |
|---|---|
| `src/index.ts` | Public barrel; re-exports from `mps3.ts`. The bundler entry point. |
| `src/mps3.ts` | Public `MPS3` class. **Start here for behavior.** |
| `src/manifest.ts` | Per-manifest poller + subscriber registry. |
| `src/syncer.ts` | Reads + writes the manifest log. The protocol lives here. |
| `src/operation-queue.ts` | Buffers local writes; persists to IndexedDB for offline-first. |
| `src/s3-client-lite.ts` | Minimal HTTP S3 client (avoids AWS SDK weight). |
| `src/json.ts` | RFC 7386 JSON Merge Patch. |
| `src/types.ts` | Branded types (`Ref`, `ManifestKey`, `UUID`, `VersionId`). |
| `src/constants.ts` | Protocol constants. New magic values go here. |
| `src/errors.ts` | `MPS3Error` class. All thrown errors should be instances. |
| `src/s3-types.ts` | Minimal S3 wire-protocol types (replaces `@aws-sdk/client-s3` for type surface only). |
| `src/hashing.ts`, `src/time.ts`, `src/xml.ts`, `src/o-map.ts`, `src/indexdb.ts`, `src/memory-fetch.ts` | Utilities. |

The full lifecycle of `put()` and `subscribe()` is documented in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — read it before changing
`syncer.ts` or `manifest.ts`.

## When editing X, read Y

Path-scoped conventions. **Read the matching file before editing.**

| When you're editing… | Read first |
|---|---|
| `src/**/*.ts` (excluding tests) | [docs/conventions/src.md](docs/conventions/src.md) |
| `src/**/*.test.ts`, `tests/**` | [docs/conventions/tests.md](docs/conventions/tests.md) |
| `docs/**` | [docs/conventions/docs.md](docs/conventions/docs.md) |
| `src/syncer.ts`, `src/manifest.ts` | [docs/sync_protocol.md](docs/sync_protocol.md) + [docs/causal_consistency_checking.md](docs/causal_consistency_checking.md) |
| `src/json.ts` | [docs/JSON_merge_patch.md](docs/JSON_merge_patch.md) |
| Public API on `MPS3` | [docs/EXTENDING.md](docs/EXTENDING.md) |

Claude users: `.claude/rules/{src,tests,docs}.md` auto-load on matching
edits and point at the same files.

## Conventions

- **Imports are relative.** `tsconfig.json` uses `moduleResolution: "bundler"`
  and no `baseUrl`. Inside `src/` write `import { Ref } from "./types"`.
- **Branded types are load-bearing.** `Ref`, `ManifestKey`, `UUID`,
  `VersionId` exist to prevent confusion bugs. Don't paper over a type
  mismatch with `as string`; widen only if you understand why.
- **Magic values live in `src/constants.ts`** with a JSDoc citing where the
  value comes from (often `docs/sync_protocol.md`).
- **Errors must be `MPS3Error` instances.** Use the `code` discriminant
  (`error.code === "NetworkError"`), not `instanceof` chains. Hierarchy
  lives in `src/errors.ts`.
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
- ❌ Hard-coding new magic numbers. Add to `src/constants.ts`.
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
