# @baerly/cli — agent quickref

`baerly` does things to a project that already has baerly.
`create-baerly-storage` is the one that puts baerly into a project in the first
place (see `packages/create-baerly-storage/AGENTS.md`).

`@baerly/cli` is workspace-internal. It bundles to a single-file bin at
`dist/baerly.js` via rolldown with a `#!/usr/bin/env node` banner; the
published `baerly-storage` tarball ships that bin. Every subcommand is
lazy-loaded behind dynamic `import()` so `node baerly --help` pays only
the entry shim (~28 KiB) plus citty parser before dispatching.

## Verbs

The static-import closure (`src/baerly.ts:25-59`) reaches *only*
`citty` + `bin-runner.ts`. Every verb below is reached via a
`() => import("./x.ts").then(m => m.x)` factory — the dispatched
module's transitive imports are evaluated lazily.

| Verb | Module | Role |
|---|---|---|
| `baerly deploy` | `src/deploy.ts` → `src/deploy/cloudflare.ts` | Reads `baerly.config.ts:target` and dispatches. Today only `target: "cloudflare"` is accepted; patches `wrangler.jsonc`, then shells out to `wrangler deploy --x-provision --x-auto-create`. `target: "node"` is rejected (self-host via your PaaS/container build). |
| `baerly doctor` | `src/doctor.ts` | Two modes. `--bucket <uri>` live-probes a real bucket's CAS support (writes + deletes one sentinel; verifies `If-Match` / `If-None-Match` are honoured — the protocol's load-bearing backend prerequisite), independent of `--target`. Otherwise walks deploy invariants for `baerly.config.ts:target` (wrangler config, R2 bindings, required secrets, CF Access audience tag, cron triggers, domain coherence). `--fix` auto-creates missing R2 buckets. |
| `baerly inspect` | `src/inspect.ts` | Read-only summary of one collection's snapshot / log / index state. |
| `baerly export` | `src/export.ts` | Snapshot dump of one collection to SQL (`--target=sqlite`, `--target=postgres`). |
| `baerly cost` | `src/cost.ts` | Class A / Class B operation accounting from `log_seq_start … next_seq`. |
| `baerly admin rebuild-index` | `src/admin/rebuild-index.ts` | Idempotent reconciliation of one `IndexDefinition` against the materialised view. |
| `baerly admin dump` | `src/admin/dump.ts` | Canonical NDJSON of one collection's current row set. |
| `baerly admin restore` | `src/admin/restore.ts` | Re-imports `admin dump` NDJSON into a fresh bucket. |
| `baerly admin fsck` | `src/admin/fsck.ts` | Walks `current.json` → snapshot hash → log range → index prefixes read-only; exits 4 on any finding. |
| `baerly admin usage` | `src/admin/usage.ts` | Wire-byte / object-count accounting for one bucket. |

Exit-code contract (per `src/deploy.ts:10-16` and friends): 0 success,
1 user error, 2 storage/external error, 3 protocol invariant.

## Shared with create-baerly-storage

`@baerly/cli` surfaces exactly one subpath export:
`@baerly/cli/wrangler-patch`. It exposes `patchWranglerJsonc`,
`readWranglerName`, and `readWranglerMain` — all pure functions over
`wrangler.jsonc` source text (via `jsonc-parser` so comments survive).

Two consumers, one source of truth:

- `packages/cli/src/deploy/cloudflare.ts` — patches `wrangler.jsonc`
  before `wrangler deploy` to ensure R2 binding + `vars` are present.
- `packages/create-baerly-storage/src/bolt-on.ts` — patches the same file when
  `pnpm create @gusto/baerly-storage .` runs inside an existing Worker project.

`renderWorkerEntrySnippet` (the worker-entry snippet template) used to
live here too, behind `@baerly/cli/init-snippet`. It only ever had one
consumer (`create-baerly-storage`'s bolt-on), so it now lives at
`packages/create-baerly-storage/src/init-snippet.ts`. The deployed `baerly`
CLI never renders user-facing code snippets.

## Bundle policy

`dist/baerly.js` is **intentionally unbudgeted** in
`tests/integration/bundle-size.test.ts:46-56`. Reason: static-import
closure is ~28 KiB regardless of how much each verb pulls, citty-style
lazy dispatch is the load-bearing discipline, and the bin runs on dev
machines / CI where cold-start size is not a useful signal.

What *is* budgeted there is a behavioural guard:
`BUNDLED_OPTIONAL_PEERS` walks `dist/baerly.js` to ensure
`@xmldom/xmldom` and `aws4fetch` are bundled, not live-imported (the
agent-struggle #14 regression class).

Anti-patterns to flag in review:

- A top-level `import { x } from "./some/verb.ts"` in `src/baerly.ts`
  or `bin-runner.ts`. Breaks the lazy-dispatch discipline; the
  closure inflates by the verb's transitive cost.
- Adding a runtime dep just to support one verb. Most verbs already
  reach into `@baerly/protocol` / `@baerly/server` / `@baerly/dev`;
  prefer dragging there over inflating the bin's external surface.

## When iterating

- `pnpm verify:agent` after a verb edit — typecheck + lint catch most
  regressions; the verb's own `*.test.ts` is the next gate.
- `pnpm bundle-sizes` after touching `src/baerly.ts` or any new
  static import. Self-builds, prints `BUNDLE_SIZE <entry> raw=… gz=…`
  for every entry. Don't pipe through `tail`/`head`; output is
  already compact.
- The worktree-bootstrap dance matters here:
  `pnpm worktree:bootstrap` rebuilds `dist/baerly.js`, which is what
  every example's `node_modules/.bin/baerly` symlinks to. Without it,
  `pnpm baerly <verb>` from an example dir resolves to a missing
  file.
