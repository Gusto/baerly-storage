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
