# Followups: publish direction

**Status: decided 2026-05-27. Closes A3 (Quick start) and A6
(`@baerly/protocol` description) — see "Downstream cleanups"
below.**

Phased publish: `@gusto/`-scoped to Gusto's private registry
now; unscoped to public npm at OSS launch.

## Published names

Two published packages. Everything else in the monorepo is
workspace-internal.

| Phase                          | Library + CLI            | Scaffolder                       |
|--------------------------------|--------------------------|----------------------------------|
| Phase 1 — private (now)        | `@gusto/baerly-storage`  | `@gusto/create-baerly-storage`   |
| Phase 2 — public OSS (future)  | `baerly-storage`         | `create-baerly-storage`          |

Phase 1 invocations:

```sh
pnpm install @gusto/baerly-storage
pnpm create @gusto/baerly-storage@latest -- my-app --target=cloudflare
   # pnpm resolves @gusto/baerly-storage to @gusto/create-baerly-storage
pnpm baerly deploy        # bin name unchanged regardless of pkg scope

import { Db }            from "@gusto/baerly-storage"
import { LocalFsStorage } from "@gusto/baerly-storage/dev"
```

## What stays as-is

- The 7 workspace `@baerly/*` packages: `@baerly/server`,
  `@baerly/protocol`, `@baerly/client`, `@baerly/adapter-node`,
  `@baerly/adapter-cloudflare`, `@baerly/dev`, `@baerly/cli`.
  Workspace-only, never published. Source-code imports and
  developer-facing docs keep these names.
- The published surface stays single-thick. No per-adapter or
  per-audience package splits. Subpaths (`/cloudflare`, `/node`,
  `/client/react`, `/dev/vite`, …) carry the audience split.
- The `baerly` bin name. `bin: { "baerly": "./dist/baerly.js" }`
  in the root `package.json` is independent of the package name.

## Phase 1 implementation checklist

1. **Rewrite root `package.json` `name:`** → `@gusto/baerly-storage`.
   Pick a private-preview version (e.g. `0.1.0-private.1`). Update
   the 4 `examples/*/package.json` files that depend on it
   (`"baerly-storage": "workspace:*"` →
   `"@gusto/baerly-storage": "workspace:*"`).
2. **Rename the scaffolder package.** Move
   `packages/create-baerly/` → `packages/create-baerly-storage/`;
   set its `name:` to `@gusto/create-baerly-storage`; change its
   `bin:` key from `create-baerly` to `create-baerly-storage`.
   Update workspace deps that reference it (root
   `devDependencies`) and the `STARTER_TO_EXAMPLE` map in
   `packages/create-baerly-storage/src/scaffold.ts`.
3. **Update the CLI's bin-name detection.**
   `packages/cli/src/bin-runner.ts` and
   `packages/cli/src/output.ts` switch behavior on whether the
   bin is `baerly` or `create-baerly`. The scaffolder bin is
   becoming `create-baerly-storage`; both files need updating.
4. **Update every emission of the published library name**
   to `@gusto/baerly-storage` for Phase 1. Covers:
   - `README.md` (the LLM zero-shot anchor for new users)
   - `packages/server/API.md` (copied to `dist/API.md` on
     every build — bundled into the published package)
   - JSDoc `@example` blocks across `packages/server/src/*.ts`
     (~10 files: `db.ts`, `table.ts`, `index.ts`, `compactor.ts`,
     `gc.ts`, `maintenance.ts`, `rebuild-index.ts`, `schema.ts`,
     `snapshot.ts`, `writer.ts`) — IDE hover and tsgo surface
     these directly
   - `docs/guide/**` install + import snippets (6 files)
   - `examples/*/README.md` + `examples/README.md`
   - Install-command lines inside developer-internal docs
     (`CLAUDE.md`, `docs/contributing/architecture.md`,
     `docs/contributing/day-one-gate.md`,
     `docs/contributing/features.md`) — the docs as a whole stay
     internal, but the install lines mismatch the published name
5. **Update every emission of the scaffolder bin name** to
   `create-baerly-storage` for Phase 1. The scaffolder's source
   code generates content for end-user apps; the generated output
   must reference the Phase 1 names:
   - `packages/create-baerly-storage/src/init-snippet.ts`
     (worker-entry imports it emits)
   - `packages/create-baerly-storage/src/bolt-on.ts`
     (`baerly.config.ts` template it emits)
   - `packages/create-baerly-storage/src/agent-rules.ts`
     (AGENTS.md block it emits, pointing at
     `node_modules/<pkg>/dist/API.md`)
   - `packages/create-baerly-storage/src/substitute.ts`
     (workspace-dep rewrite logic — encodes the published name)
   - Scaffold template `package.json` files (under
     `packages/create-baerly-storage/templates/**` if present, or
     mirrored from `examples/`) that contain the workspace dep
6. **Audit scaffolder runtime dependencies.** Today its
   `package.json` lists `@baerly/cli` and `@baerly/server` as
   `dependencies`. If rolldown bundles them into `dist/index.js`
   they must move to `devDependencies` or be dropped; if rolldown
   externalises them, `pnpm install @gusto/create-baerly-storage`
   will 404. Closes before first publish.
7. **Update test fixtures asserting exact names.** ~5 files
   assert published name strings:
   `packages/create-baerly-storage/src/{scaffold,index,bolt-on}.test.ts`,
   `tests/integration/public-surface.test.ts`,
   `tests/integration/lint-use-query.test.ts`.
8. **Add `repository` / `bugs` / `homepage` / `author` fields**
   to both published packages — closes
   [prelaunch-package-json-polish.md](prelaunch-package-json-polish.md)
   with the now-known repo host (under `github.com/Gusto`; pick
   the repo name).
9. **Configure private-registry routing.** `.npmrc` needs
   `@gusto:registry=<url>` for `pnpm publish` and for downstream
   consumers. Decide whether to commit a project `.npmrc` or
   document the contributor setup.
10. **Strip `provenance: true`** from `publishConfig` if Gusto's
    private registry doesn't support npm Sigstore attestations
    (most private registries don't). Restore for Phase 2.
11. **Confirm no workspace deps land in published
    `dependencies`** for the root `baerly-storage`. Root currently
    has only `@logtape/logtape`; re-verify pre-publish.

## Downstream cleanups

### A3. README "Quick start"

`README.md:14-23` admits `pnpm dlx create-baerly@latest`
"doesn't resolve end-to-end." With Phase 1 in place, replace
with:

```sh
pnpm create @gusto/baerly-storage@latest -- my-app --target=cloudflare
cd my-app
pnpm install
pnpm dev
```

The "Or wire it by hand" snippet's three workspace imports
(`@baerly/adapter-node`, `@baerly/server/auth`, `@baerly/dev`)
become subpaths of `@gusto/baerly-storage`: `/node`, `/auth`,
`/dev`. Drop the "doesn't resolve" admission once the publish
lands.

### A6. `@baerly/protocol` description

`packages/protocol/package.json:4` description ("not a public
API: import from `@baerly/server` instead") becomes inert: the
167 `@baerly/protocol` imports across `packages/`, `tests/`,
`examples/`, `eval/` are workspace-internal; the package is
never published.

- Rewrite the description: `Workspace-internal protocol kernel.
  Bundled into @gusto/baerly-storage (private) and baerly-storage
  (public). Not a separately published package.`
- Add `"private": true` to `packages/protocol/package.json` to
  lock it from accidental publish. Apply to the other 6
  workspace `@baerly/*` packages at the same touch.

## Phase 2 launch checklist (deferred)

These do not block Phase 1. Resolve before public publish.

1. **Mirror or rename?** Does Gusto's private registry mirror
   public npm at launch (internal engineers run
   `pnpm install baerly-storage` and routing handles the rest),
   or do internal apps run a one-time rename?
2. **`@gusto/*` sunset window.** Keep `@gusto/baerly-storage`
   alive post-launch as a thin re-export of `baerly-storage`,
   then publish a deprecation-throwing version on a pinned
   date. How long is the re-export window?
3. **Public-name squat now?** Publish `0.0.0-reserved`
   placeholders for `baerly-storage` and `create-baerly-storage`
   to public npm during Phase 1 to block dependency-confusion
   attacks. Yes/no/defer.
