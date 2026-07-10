---
'@gusto/baerly-storage': minor
---

`baerlyDev` can now load `baerly.config` itself instead of requiring the caller
to import it and pass the object.

`BaerlyDevOptions.config` is now optional; two new resolution modes:

- `configPath` — absolute path to the config module, loaded lazily at
  dev-server startup via Vite's `ssrLoadModule`.
- **convention** (nothing passed) — loads `<viteRoot>/src/baerly.config.ts`,
  mirroring how `reactRouter()` loads `react-router.config.ts`.

Passing an explicit `config` object still works and is unchanged, including
fail-fast verifier resolution at factory time.

**Why:** when an app's `vite.config.ts` imports its `baerly.config` to pass the
object in, Nx's `@nx/vite` / `@nx/vitest` inference plugins bundle that config
during project-graph creation, dragging the config module's transitive imports
(`@gusto/baerly-storage/config`, `zod`) into the config bundle. Those fail to
resolve in CI and crash graph creation, forcing every baerly app into the root
`nx.json` inference-plugin exclusion lists — a global edit that marks the whole
monorepo affected. Letting `baerlyDev` load the config itself keeps the caller's
`vite.config` import-free, so the exclusion is no longer needed. See
Gusto/web#25730 for the motivating case (and the interim `yarn patch` it ships
until this releases).
