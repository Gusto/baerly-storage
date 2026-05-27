---
title: Publishing
audience: maintainer
summary: "How to publish @gusto/baerly-storage + @gusto/create-baerly-storage to Gusto's private npm registry."
last-reviewed: 2026-05-27
tags: [publishing, release, npm]
related: ["development.md", "../../CLAUDE.md"]
---

# Publishing

Two packages publish from this repo, both scoped to `@gusto/` and
both targeting Gusto's private npm registry:

| Package                          | Path                              | Bin                       |
|----------------------------------|-----------------------------------|---------------------------|
| `@gusto/baerly-storage`          | `./` (root)                       | `baerly`                  |
| `@gusto/create-baerly-storage`   | `packages/create-baerly-storage/` | `create-baerly-storage`   |

Workspace `@baerly/*` packages are marked `"private": true` and are
never published — they bundle into the published `@gusto/baerly-storage`.

## One-time setup

Add the `@gusto:` scope routing to `~/.npmrc` so both `pnpm publish`
and downstream `pnpm install @gusto/baerly-storage` find the
registry:

```
@gusto:registry=<gusto-private-registry-url>
//<gusto-private-registry-host>/:_authToken=${NPM_TOKEN}
```

Replace `<gusto-private-registry-url>` with the URL from Gusto's
infra team. Set `NPM_TOKEN` in your shell environment (publish
tokens are personal; don't share). Confirm auth:

```sh
npm whoami --registry=<gusto-private-registry-url>
```

## Pre-publish gate

```sh
pnpm verify            # typecheck + lint + examples typecheck
pnpm test:agent        # full unit + integration suite
pnpm build             # rolldown bundle to dist/
```

All three must be green. The build is required for any test that
reads `dist/`, and for the publish to ship a valid bundle.

`dist/API.md` is bundled into the published package and is the LLM
zero-shot anchor for installed engineers. Sanity-check it after the
build:

```sh
grep -c '@gusto/baerly-storage' dist/API.md
```

The count should match `packages/server/API.md`.

## Local pack smoke

```sh
pnpm pack
tar -tzf gusto-baerly-storage-*.tgz | head -30
tar -xzOf gusto-baerly-storage-*.tgz package/package.json | head -10
```

Confirm: `package/dist/index.js`, `package/dist/cloudflare.js`,
`package/dist/API.md`, `package/dist/baerly.js` (the CLI bin) are
present. The unpacked `package.json` `name:` field matches the
scoped name.

Repeat for the scaffolder:

```sh
cd packages/create-baerly-storage
pnpm pack
tar -tzf gusto-create-baerly-storage-*.tgz | head -30
tar -xzOf gusto-create-baerly-storage-*.tgz package/package.json | head -10
```

Confirm: `package/dist/index.js` and
`package/dist/templates/{minimal,react}-{cloudflare,node}/package.json`
are present. Cleanup the local `.tgz` files when done.

## Dry-run

```sh
pnpm publish --dry-run --no-git-checks
pnpm --filter @gusto/create-baerly-storage publish --dry-run --no-git-checks
```

Each dry-run reports the version it would publish and lists the
files. Review the file list — anything outside `dist/` is a
packaging bug.

## Real publish

```sh
pnpm publish --no-git-checks
pnpm --filter @gusto/create-baerly-storage publish --no-git-checks
```

Verify each landed:

```sh
npm view @gusto/baerly-storage --registry=<gusto-private-registry-url>
npm view @gusto/create-baerly-storage --registry=<gusto-private-registry-url>
```

## Post-publish smoke

Sanity-install in a scratch directory:

```sh
mkdir -p /tmp/baerly-smoke && cd /tmp/baerly-smoke
pnpm init --yes
pnpm install @gusto/baerly-storage
ls node_modules/@gusto/baerly-storage/dist/
```

Expected: `dist/index.js`, `dist/API.md`, `dist/baerly.js` present.

Scaffold smoke:

```sh
cd /tmp
pnpm create @gusto/baerly-storage@latest -- baerly-smoke-app --target=cloudflare
cd baerly-smoke-app
pnpm install
pnpm baerly doctor --target=cloudflare
```

The scaffold should succeed, install should resolve, and `baerly
doctor` should run (it may flag missing wrangler auth on a fresh
scratch dir — that's expected).

## Versioning

Use a private-preview suffix on the version: `0.1.0-private.N`
where `N` increments for each publish. Both packages bump
together — they ship in the same release train. Update both root
`package.json` and `packages/create-baerly-storage/package.json`
in a single commit before publishing.

## Notes on the publish config

- `publishConfig.provenance` is intentionally NOT set. Most private
  registries don't accept npm Sigstore attestations. If/when the
  project moves to public npm, restore the flag.
- `publishConfig.access: "public"` is set on the root. For the
  private registry it's a no-op; carried forward so that Phase 2's
  public publish doesn't need a separate config edit.
- The 7 workspace `@baerly/*` packages have `"private": true` as a
  defensive lock. Never remove these flags — those packages are
  bundled into the published `@gusto/baerly-storage`, never
  shipped separately.
