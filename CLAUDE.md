---
title: CLAUDE.md — agent guidance for baerly-storage
audience: agent
summary: Toolchain, verification matrix, module map, conventions, anti-patterns. The main agent entry point.
last-reviewed: 2026-08-04
tags: [agent-entry, conventions, verification]
related: ["docs/README.md", "docs/architecture.md", "docs/contributing/development.md"]
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

**Current state:** Open source under Apache-2.0, published publicly as
`@gusto/baerly-storage` (and the `@gusto/create-baerly-storage`
scaffolder) on npm (npmjs.com) with `publishConfig.access: "public"`.
See
[`docs/contributing/publishing.md`](docs/contributing/publishing.md) for
the publish workflow.

The protocol kernel and HTTP server are landed. Day-1 templates ship
for Cloudflare Workers and self-hosted Node; both are first-class.
AWS Lambda / Bun / Deno / Fly are an adapter package away.

## Toolchain

Read `packageManager` + `devDependencies` in `package.json`. Don't
introduce alternate tooling without justification.

## Verification

Under Claude Code, `vitest` runs use the compact `minimal` reporter —
vitest 4.1 auto-detects AI-agent environments, and the repo config
(`vitest.config.ts`) additionally pins this behavior when
`CLAUDECODE=1` is set so it isn't silently broken by detection
changes. Failures still print in full. Override with
`--reporter=dot` for long suites (`test:randomize`,
`test:fuzz-maintenance`) when progress signal matters more than
compactness, or `--reporter=default` to force the full reporter.
`pnpm verify` / `pnpm test` is what humans run before pushing. `pnpm
verify` is split into `verify:code` (the whole chain minus markdown) and
`verify:docs` (markdown/mermaid validation); `verify` runs both. The
lefthook pre-commit hook runs them by glob — `verify:code` when a
`.ts`/`.tsx` file is staged, `verify:docs` when a `.md` file is staged
(so a docs-only commit is now validated locally too, and a code-only
commit skips the markdown checks it can't affect) — plus a scoped
`pnpm bundle-sizes` (see below), but NOT the full `pnpm test` suite.
`pnpm verify:agent` / `pnpm test:agent` are explicit compact-output
variants for environments where the env var isn't propagated.

> **Agents: don't pipe `verify:agent` / `test:agent` through `| tail -N` or `| head -N`.** Both scripts are already compact — one finding per line, with full detail preserved on failures. Piping to `tail`/`head` removes the lines you need; if the first run prints nothing useful, the _output is empty because the gate passed_, not because the tail was wrong. Same applies to `pnpm bundle-sizes`.

> **Two `test:agent` invocation traps.** `pnpm test:agent -- <path>` silently
> runs the whole default-project suite — the `--` becomes a positional that
> neutralizes vitest's path filter; write `pnpm test:agent <path>` instead.
> `pnpm test:agent --project=<name>` also fails silently: the script already
> hard-codes `--project=default`, so a second `--project=` supplies two
> conflicting filters rather than overriding the first. There's no way to
> retarget `test:agent` at another vitest project — use the project's own
> script (e.g. `pnpm test:adapter-cloudflare <paths>`). And `FC_NUM_RUNS` in
> front of `pnpm test:fuzz-maintenance` is a no-op — the script hardcodes
> `FC_NUM_RUNS=10000` — so read the effective value off the `$ ...` command
> vitest echoes rather than assuming your override took.

| Command | What it catches | Runtime | Clean on `main`? |
| --- | --- | --- | --- |
| `pnpm verify` | typecheck (`tsgo --noEmit`, run twice — the Node-only root program, then the Workers program via `-p tsconfig.cloudflare.json`) + `verify:examples` + lint (`oxlint`) + `format:check` (`oxfmt --check .`, whole-repo) + `lint-format-coverage` (ownership guard) + `verify:docs` (markdown validation) + `check-spec-drift` + `check-version-matrix` | ~seconds | ✅ — non-zero exit _is_ your regression |
| `pnpm verify:agent` | same gate as `pnpm verify` (code + `verify:docs`), with `tsgo --pretty false` + `oxlint --format=unix --quiet` for one-line-per-finding output (warnings hidden — `pnpm verify` still surfaces them). Shares the common check spine with `verify:code` via `verify:rest`, so a new check is added once; the two differ only in the compact typecheck/lint flags and that `verify:agent` runs the whole gate (it's invoked whole by agents, not glob-dispatched like the lefthook hook). | ~seconds | ✅ — same gate as `verify`, just quieter |
| `pnpm test` | vitest unit + integration (zero infra) — includes the `memory` + `local-fs` variants of `randomized.test.ts` | ~3s | ✅ — Minio + credentials tests are gated, see below |
| `pnpm test:agent` | same gate as `pnpm test`, with `--reporter=minimal --silent=passed-only` baked in (failures still full-detail). Works regardless of `CLAUDECODE` | ~3s | ✅ — same gate as `test`, just quieter |
| `pnpm test:adapter-cloudflare` | runs `r2BindingStorage` conformance, the `cloudflare-r2` variant of `randomized.test.ts`, the `cloudflare-r2` variant of `collection-api.test.ts`, **and** the `cloudflare-r2` variant of `http-conformance.test.ts` under miniflare (`@cloudflare/vitest-pool-workers`, project `cloudflare-pool`) | ~3s | ✅ — first run downloads the `workerd` binary |
| `pnpm test:http-conformance` | runs the HTTP cascade on `memory` + `local-fs` (default project) | ~3s | ✅ |
| `pnpm test:parity` | cross-adapter parity — one shared `Storage` conformance + cascade contract across memory / local-fs (+ minio under `MINIO=1`); the canonical `green locally ⇒ green in cloud` gate. See [docs/contributing/conventions/tests.md](docs/contributing/conventions/tests.md#cross-adapter-parity-gate). | ~3s (base) | ✅ — no-infra rows; minio gated; R2 via `test:adapter-cloudflare` |
| `pnpm build` | rolldown bundle to `dist/` | ~seconds | ✅ |
| `pnpm build:agent` | same build as `pnpm build`, with rolldown's per-asset/chunk size table (no CLI suppress flag exists) captured and replayed only on failure — mirrors `verify:agent`/`test:agent`. Prefer this over `pnpm build` before `pnpm test:agent` | ~seconds | ✅ — same gate as `build`, just quieter |
| `pnpm test:randomize` | property-based fuzzer (`FC_NUM_RUNS=10000`) over the default project, excluding the dedicated crash fuzzer and the expensive non-property `maintenance-profile-equivalence` / `maintenance-e2e` suites. The randomized cascade itself is fault-injection-driven, so `FC_NUM_RUNS` is a no-op for `randomized.test.ts`; its enabled default-project variants run once while property tests scale up | run for minutes | use when changing protocol code |
| `pnpm test:fuzz-maintenance` | crash-injection fuzzer for the maintenance loop (`maintenance-crash-fuzz.test.ts`) — aborts the K-th storage op inside `Writer` / `compact()` / `runGc()` and asserts the reader still sees a consistent row set | minutes-hours at `FC_NUM_RUNS=10000` | use after touching `compactor.ts` / `gc.ts` / `writer.ts` |
| `pnpm worktree:bootstrap` | `pnpm install --frozen-lockfile` (the `install`-triggered `prepare` hook builds `dist/`; no separate build step). Run this once after `git worktree add` to prime `dist/` so `baerly`, `pnpm bundle-sizes`, and any dist-consuming test work. `verify:agent` itself doesn't need it; everything else does | ~10-30s | n/a |
| `pnpm bundle-sizes` | delta-gated bundle budgets (`raw`/`gz`/`min-gz`). Self-builds. Not part of `pnpm verify` — the lefthook hook runs it scoped. Clear intended growth with `--write` plus a reason in the commit message | ~seconds | ✅ |
| `pnpm dev:storage` | brings up Minio `:9102` + Toxiproxy `:9104` + Postgres `:5433` | n/a | required for `test:minio` / `test:conformance` / `test:export-smoke` / `test:adapter-node` / `test:adapters` |

Everything else — the `verify:*` sub-checks, infra-gated and credentialed
suites, `test:mutate`, `model:multilevel`, `freeze:fold-stage0`, all
`bench:*`, the `baerly` operator CLI, `test:manual-e2e` — is in the
**`verification` skill** (`.claude/skills/verification/`). Invoke it when a
command you need isn't above.

`pnpm verify` is also enforced as a [lefthook](https://lefthook.dev/)
pre-commit hook (`lefthook.yml`); `pnpm install` wires it up via the
`prepare` script. The hook runs `oxfmt --fix` + `oxlint --fix`, then
`verify:code` (code-globbed) and/or `verify:docs` (markdown-globbed) —
together equivalent to `pnpm verify` on a mixed commit, with neither
running for a commit that stages nothing in its glob — plus
`pnpm bundle-sizes` **only when a
staged file matches `packages/**/_.{ts,tsx}`(excluding`_.test.\*`) or
`rolldown.config.ts`** — bundle budgets live in `pnpm test`/`pnpm bundle-sizes`, NOT in `pnpm verify`, so the scoped hook is what
keeps a budget-blowing kernel edit from committing green and surfacing
late (in CI or a manual `pnpm test`). The hook does **not** run the
full `pnpm test`suite. Bypass with`git commit --no-verify` when needed.

Claude Code sessions run the same commands through `lefthook.agent.yml`
instead (`extends: [lefthook.yml]` + `output: [failure]`), selected via
`LEFTHOOK_CONFIG` in `.claude/settings.json`'s `env` block — silent on a
clean commit, full command name + output on failure. Humans and CI are
unaffected; they never set that env var, so they keep `lefthook.yml`'s
banner and summary output.

### Test gating

`pnpm test` runs green on a fresh checkout with zero infrastructure deps.
Suites needing Minio, credentials, Postgres, or Workerd are env-gated and
skip by default — see the `verification` skill for which gate applies to
which suite.

## Local dev

Integration tests can run against a local Minio + Toxiproxy stack:

```sh
pnpm dev:storage         # docker compose up -d --wait (Minio :9102, Toxiproxy :9104, Postgres :5433)
pnpm dev:storage:stop    # docker compose down
```

> **Two worktrees, two stacks?** Set `BAERLY_MINIO_HOST_PORT`,
> `BAERLY_TOXIPROXY_HOST_PORT`, `BAERLY_TOXIPROXY_ADMIN_PORT`, and
> `BAERLY_POSTGRES_HOST_PORT` in a per-worktree `.env.local` (or just
> inline before the command) and the compose stack will bind those host
> ports instead of the defaults. The test setup helper at
> `tests/setup/ports.ts` reads the same variables, so consumers stay in
> sync. Without overrides the second `compose up` still fails with
> `port already allocated`.

See [docs/contributing/development.md](docs/contributing/development.md) for full setup.

## Module map

Reading order for a mental model: `packages/server/src/` →
`index.ts` (public barrel + bundler entry) → `db.ts` (`Db`) →
`collection.ts` + `query.ts` (SQL-shape API + predicate AST) →
`writer.ts` (commit path) → `indexes.ts` → `compactor.ts` / `gc.ts` /
`maintenance.ts` (durability sweeps). Pure, I/O-free modules live in
`@baerly/protocol`; Node-only `Storage` impls in `@baerly/dev`;
concrete S3/R2 adapters in `@baerly/adapter-{node,cloudflare}`. Each
package has its own `AGENTS.md` — read that before its source.

Two non-obvious invariants in there, because you can't see them by
skimming:

- **`writer.ts`**: serialize the `I` / `U` post-image into
  `LogEntry.after` → PUT additive index markers → create `log/<seq>` via
  `If-None-Match: "*"`. **That create IS the commit** — there is no
  `current.json` write on the commit path. Stale index entries are DELETEd
  only after it succeeds.
- **`indexes.ts`**: index keys are lex-order-preserving base-32. The
  writer's emission is deliberately *hybrid-polarity* — new markers
  before the committing log create, stale marker deletes after it.

The full lifecycle of `db.collection().insert()`, plus a Mermaid
dependency graph, is in
[docs/architecture.md](docs/architecture.md) — read it before changing
`writer.ts` or the query evaluation path.

## When editing X, read Y

Path-scoped conventions. **Read the matching file before editing.**

| When you're editing… | Read first |
| --- | --- |
| `tests/**` | [docs/contributing/conventions/tests.md](docs/contributing/conventions/tests.md) |
| `docs/**` | [docs/contributing/conventions/docs.md](docs/contributing/conventions/docs.md) |
| `packages/server/src/writer.ts` | [docs/spec/sync-protocol.md](docs/spec/sync-protocol.md) + [docs/spec/causal-consistency-checking.md](docs/spec/causal-consistency-checking.md) |
| `packages/protocol/src/json.ts` | [docs/spec/json-merge-patch.md](docs/spec/json-merge-patch.md) |
| `packages/protocol/src/log.ts`, the log-emit path in `writer.ts` | [docs/spec/log-entry-shape.md](docs/spec/log-entry-shape.md) |
| `packages/server/src/observability/**` | [docs/contributing/conventions/observability.md](docs/contributing/conventions/observability.md) |
| Public API on `Db` / `Collection` | [docs/contributing/extending.md](docs/contributing/extending.md) |
| `packages/server/src/schema.ts` or `CollectionDefinition.schema` | [docs/contributing/extending.md](docs/contributing/extending.md) §"Declare a schema for a collection" |
| `tests/fixtures/fold-stage0/pre-change/**` — **do not hand-edit** | [tests/fixtures/fold-stage0/pre-change/README.md](tests/fixtures/fold-stage0/pre-change/README.md). These are captured bytes bound to a SHA-256 manifest, which the promoted study record in turn binds by hash. Reformatting or "fixing" one file breaks the chain; regenerate with `pnpm freeze:fold-stage0` instead |
| Durable schemas, wire, or version axes | [docs/contributing/conventions/versioning.md](docs/contributing/conventions/versioning.md) |
| `bundle-sizes.json`, `rolldown.config.ts`, or any `packages/*/src/**` size-affecting change | [docs/contributing/conventions/bundle-budgets.md](docs/contributing/conventions/bundle-budgets.md) |

Claude users: `.claude/rules/{tests,docs,change-discipline,bundle-budgets}.md`
carry `paths:` frontmatter, so they load only when you touch a matching
file, and point at the same conventions. A rule that loses its `paths:`
field loads unconditionally at launch instead — silently.

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
  `oxlint`'s `import/extensions: ["error", "always", { ignorePackages: true }]`
  on `packages/**` + `tests/**` + `bench/` + `examples/` + `manual-e2e/` +
  `scripts/` + the root config files, and by
  `scripts/add-ts-extensions.mjs --check` for the autofix capability oxlint
  lacks (it can flag a missing extension but not filesystem-resolve `./foo`
  to `./foo.ts` vs `./foo/index.tsx` and rewrite it) — `deploy/` isn't linted
  by oxlint yet since the directory doesn't exist in the repo.
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
  directly — no rendered markdown ref to maintain. Navigation pointers
  ("this file does X, dispatched from Z") go in the package's
  `AGENTS.md` instead; a source header holds only why-non-obvious
  context.
- **Per-collection linearizability is a hard invariant.** The
  `log/<seq>` `If-None-Match: "*"` create linearizes each collection;
  cross-collection writes are unordered and non-atomic.
  [docs/spec/sync-protocol.md](docs/spec/sync-protocol.md)
  and [docs/spec/causal-consistency-checking.md](docs/spec/causal-consistency-checking.md)
  describe how it works. Read those before touching
  `packages/server/src/writer.ts`.

## Anti-patterns

- ❌ Adding **runtime** dependencies to anything that ships to user
  apps. The runtime footprint of `baerly-storage` and the adapters
  is intentionally small (`aws4fetch`, `@rgrove/parse-xml`, `hono`,
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
- ❌ Trimming JSDoc, comments, or error-message text to squeeze under a
  **bundle budget**. Comments ship un-stripped so they cost `raw`/`gz`, but
  they vanish under a consumer's minifier — golfing them buys bytes nobody
  pays. `min-gz` is the axis a consumer actually pays; all three are
  delta-gated. Intended growth is cleared with `pnpm bundle-sizes --write`
  plus a reason in the commit message; do NOT add a dated changelog entry to
  any file. Absolute ceilings are deliberately almost absent — only
  `app-config.js` has one, and it asserts that entry has no runtime closure
  rather than that it is small. Full policy:
  [docs/contributing/conventions/bundle-budgets.md](docs/contributing/conventions/bundle-budgets.md).
- ❌ Reintroducing `bun:test`, Rome, or baseUrl imports — all replaced.
- ❌ Extensionless relative imports (`from "./foo"`). Always write
  `from "./foo.ts"` or `from "./foo/index.ts"`. Node's
  strip-types runtime can't resolve them; oxlint's
  `import/extensions` rule fails the lint.
- ❌ Calling `vitest` via `pnpm exec vitest` or `./node_modules/.bin/vitest` —
  both skip the `pretest` hook (`pnpm run build`), leaving `dist/` empty or
  stale and producing spurious failures in bundle-size / dist-consuming tests.
  **`pnpm test:agent` has the same gap** — npm/pnpm only auto-runs a
  `pre<script>` hook for a script's exact name, so `pretest` fires for
  `pnpm test` but not for `pnpm test:agent`. Run `pnpm build:agent` first (or
  run `pnpm test` once to prime `dist/`) before `pnpm test:agent`. `pnpm
  bundle-sizes` is the one command here that genuinely self-builds — its
  script calls the build itself rather than relying on a lifecycle hook.
  Same idea for the other tools: prefer `pnpm verify:agent` / `pnpm
  build:agent` over `pnpm exec tsgo` / `pnpm exec rolldown` so the canonical
  flags (`--pretty false`, `--format=unix --quiet`, etc.) come along.
- ❌ Proposing maintenance/cleanup/coordination mechanisms that require
  _operator-installed_ scheduling (`wrangler.jsonc` `triggers.crons`,
  `node-cron`, k8s `CronJob`, systemd timer, DO Alarms). The kernel must
  work on a bare bucket with zero operator infrastructure — the pitch is
  "Just a Bucket" (thesis criterion #6, [thesis.md](docs/about/thesis.md#what-apps-within-the-envelope-need)).
  Scheduled cron is a _user-opt-in_ acceleration via the exported
  `runScheduledMaintenance` SDK, never a default and never a requirement.
  **In-band write-tick maintenance is the sanctioned default and it
  SATISFIES this doctrine** (zero operator infrastructure): writes
  opportunistically tick — a budgeted `runGc` slice, then a go/no-go
  fold bounded by a static two-way snapshot ceiling (`C` bytes AND `E`
  rows); Cloudflare relocates the fold past the response via
  `ctx.waitUntil`, everywhere else runs inline. **Reads are pure — they
  never tick.** No timer, no `setInterval`, no sweep thread, no lease, no
  environment-divergent behavior, no operator cron, no app-plane knob —
  the only operator surface is the `BAERLY_MAINTENANCE_*` env vars read
  by the adapters. `runBoundedMaintenance`
  (`packages/server/src/maintenance.ts`) is the runner; the in-band tick
  and the opt-in `runScheduledMaintenance` are the two maintenance
  triggers that exist. The anti-pattern below still stands — don't
  require _operator-installed_ scheduling; in-band is the sanctioned
  shape that needs none. Anti-precedent:
  Cassandra's `read_repair_chance` (removed in 4.0,
  [CASSANDRA-13910](https://issues.apache.org/jira/browse/CASSANDRA-13910)) —
  unbounded probabilistic on-request maintenance is harmful; bounded under
  a per-pass CPU budget (PostgreSQL HOT pruning precedent) is the safe
  shape. Use the operator-burden test at
  [docs/contributing/conventions/change-discipline.md](docs/contributing/conventions/change-discipline.md#operator-burden-test-for-new-mechanisms)
  before proposing any new background-work mechanism.

## Scope guidance

- **Bugfix?** Reproduce with a failing test first. Pick the right test file
  by topic (`json.test.ts`, `time.test.ts`, etc.). Before shipping, re-inject
  the original implementation and confirm the new test goes red — a test
  that only passes against the fix is unproven; the fixture (not the
  assertion) is what has to discriminate the two implementations.
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

## Pull request bodies, code comments, and planning docs

Follow [`.github/pull_request_template.md`](.github/pull_request_template.md)
for PRs. It applies whether or not the template was rendered into your
editor — `gh pr create --body` bypasses it, so read the file.

All three are references for whoever reads them next, not a record of
how you got there. Default to short and lead with the conclusion. State
what the code or decision does/is *now*; don't narrate how you arrived
at it — no session dates, no PR-number-as-evidence, no "the reviewer
said" attribution inside prose that's just describing current behavior.
A tried-and-abandoned approach or a changed plan gets **one line**
(under a PR's "Key points", or as a decision sentence in the doc/comment
it constrains) and appears nowhere else — never a "Revision history"
section. Deferred work is an issue link, not an inventory. The full
version of this rule, with concrete before/after examples, lives in
[change-discipline.md](docs/contributing/conventions/change-discipline.md#comments-pr-bodies-and-planning-docs-describe-now-not-how-you-got-there).

Most of what wants to sprawl into a PR body belongs somewhere durable
instead — a changeset for user-facing behavior, `docs/spec` or `docs/adr`
for rationale and invariants, JSDoc for why a constant has its value, the
regenerated `bundle-sizes.json` plus a reason in the commit message for a
bundle-size rebaseline (dated baseline notes are gone — see
[bundle-budgets.md](docs/contributing/conventions/bundle-budgets.md)).
Put it there and let the PR point at it.

No AI attribution in the title or body.

## Pointers

- Doc topic map: [docs/README.md](docs/README.md) — start here if
  unsure where to look.
- Feature → code map: [docs/contributing/features.md](docs/contributing/features.md)
- Architecture overview: [docs/architecture.md](docs/architecture.md)
- Local dev setup: [docs/contributing/development.md](docs/contributing/development.md)
- How to add a feature / module / test: [docs/contributing/extending.md](docs/contributing/extending.md)
- Protocol theory: [docs/spec/sync-protocol.md](docs/spec/sync-protocol.md),
  [docs/spec/causal-consistency-checking.md](docs/spec/causal-consistency-checking.md),
  [docs/spec/json-merge-patch.md](docs/spec/json-merge-patch.md)
- Architecture decisions ("why"): [docs/adr/](docs/adr/)
- Troubleshooting: [docs/contributing/development.md#troubleshooting](docs/contributing/development.md#troubleshooting)
- Path-scoped conventions: [docs/contributing/conventions/](docs/contributing/conventions/) (table at top)
