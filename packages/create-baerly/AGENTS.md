# create-baerly — agent quickref

The `pnpm create baerly` / `pnpm dlx create-baerly` CLI. Scaffolds a
new app from one of the templates in `examples/`. Bundled to a
single-file bin by rolldown.

## Pipeline at a glance

Source of truth → build → publish artifact → user's machine:

```
examples/<template>/                       (source — runnable as an example)
   │
   │  rolldown `closeBundle` hook copies subset (excludes match
   │  `.baerly/scaffold.json:excludePaths` / `excludeNames`)
   ▼
packages/create-baerly/dist/templates/<template>/
   │
   │  `pnpm pack` / npm publish bundles dist/ into the tgz
   ▼
~/.cache/pnpm/dlx/create-baerly@<ver>/...   (resolved tarball)
   │
   │  `pnpm create baerly` extracts + applies scaffold.json
   │  rename sentinels and devDep drops
   ▼
<user's project dir>                       (final scaffolded app)
```

## Key files

- `packages/create-baerly/src/scaffold.ts` — `STARTER_TO_EXAMPLE` map
  (wizard choice → `examples/<name>/` source dir) and the copy/rename
  engine.
- `examples/<name>/.baerly/scaffold.json` — per-template manifest:
  rename sentinels (`appName`), `excludePaths`/`excludeNames` lists,
  devDep drops applied at scaffold time.
- `packages/create-baerly/templates/addons/<name>/` — opt-in overlays
  layered on top of the base template when `--with=<name>` is passed.
  Today only `docker/` exists (Dockerfile + healthcheck.js +
  .dockerignore; requires `--target=node`).
- `packages/create-baerly/rolldown.config.ts` — `copyTemplates()` plugin
  with a `closeBundle` step that mirrors `examples/<picked>/` into
  `dist/templates/<picked>/` and `templates/addons/` into
  `dist/templates/addons/` so the published bin is self-contained.

## Bolt-on branch

When `pnpm create baerly .` is run inside a directory that already has
a `wrangler.jsonc`, the runner and wizard dispatch to the bolt-on flow
instead of scaffolding a template.

**Runner dispatch (`src/runner.ts`):** After `projectName` is resolved
via `resolveOutDir`, `handleCreateBaerly` calls `existsSync` on
`resolve(outDir, "wrangler.jsonc")`. If found, it dispatches to
`dispatchBoltOn` (which calls `boltOnExistingWrangler` from
`bolt-on.ts`) and returns early — the scaffold path is never entered.
`--target=node` + `wrangler.jsonc` is an error (bolt-on is
Cloudflare-only).

**Wizard mid-flow detection (`src/prompts.ts`):** After the
`projectName` prompt resolves, `runWizard` checks `existsSync` on the
resolved `wrangler.jsonc` path. If found, it shows a `note()` and
returns a `BoltOnWizardOutput` (`mode: "bolt-on"`) — skipping the
target, starter, git, and Docker prompts entirely (all are forced:
no template, target=cloudflare, no git).

**Orchestrator (`src/bolt-on.ts`, `boltOnExistingWrangler`):** Reads
`wrangler.jsonc` via `readWranglerName` + `readWranglerMain` from
`@baerly/cli/wrangler-patch`, then runs five writes in order — each
gated on skip-if-exists or merge-if-present semantics:

1. `wrangler.jsonc` — `patchWranglerJsonc` merges R2 binding + four `vars`.
2. `.dev.vars` — created with `SHARED_SECRET=dev-shared-secret`; skipped if already exists.
3. `.gitignore` — appends `.dev.vars` unless a covering pattern exists.
4. `baerly.config.ts` — written if absent; `--force` overwrites.
5. `package.json` — appends `baerly-storage` to `dependencies` if absent.

Returns `BoltOnResult` containing `app`, `tenant`, `changes` (human-
readable list), `snippet` (the worker-entry snippet text), `snippetTarget`
(path from `wrangler.jsonc:main`), and `nextSteps`.

**Pure helpers (in `@baerly/cli`):** `patchWranglerJsonc` and
`readWranglerName`/`readWranglerMain` come from
`@baerly/cli/wrangler-patch`; `renderWorkerEntrySnippet` comes from
`@baerly/cli/init-snippet`. Both are consumed here and by `baerly
deploy` (which patches wrangler.jsonc for the same reason on the other
end of the lifecycle).

**Convex-style boundary:** structured config (`wrangler.jsonc`,
`baerly.config.ts`) is fair game to write; the user's worker entry
(`src/index.ts`) is printed as a snippet, never written.

## When iterating against local Verdaccio

`pnpm dlx` caches resolved tarballs by `pkg@version`. Republishing
`create-baerly@0.1.0` to Verdaccio does **not** bust the cache.
After every `pnpm verdaccio:publish`, run `pnpm dlx:bust-cache` (or
the publish script does it for you — check the package.json wiring).
Do not probe `pnpm config get cache-dir` to find the cache; see the
CLAUDE.md Anti-patterns section for why.

## When editing templates

- Use sentinels (e.g. `appName`, not the literal value) so the
  substituter doesn't double-rewrite. See
  `packages/create-baerly/src/scaffold.test.ts` for examples.
- Each scaffoldable template ships a `.baerly/scaffold.json` — adding
  a new template means adding both a directory and a manifest, and
  wiring `STARTER_TO_EXAMPLE` in `src/scaffold.ts`.
- Tests in `packages/create-baerly/src/**/*.test.ts` drive the full
  scaffold flow against tmp dirs; the bundle-no-live-import
  regression test in `tests/integration/` asserts the bin doesn't
  try to resolve workspace deps at runtime.
