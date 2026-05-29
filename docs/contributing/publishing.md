---
title: Publishing
audience: maintainer
summary: "How to publish @gusto/baerly-storage + @gusto/create-baerly-storage privately under the @gusto org on npmjs.com."
last-reviewed: 2026-05-28
tags: [publishing, release, npm]
related: ["development.md", "../../CLAUDE.md"]
---

# Publishing

Two packages publish from this repo, both scoped to `@gusto/` and
both published to the standard public npm registry (npmjs.com) under
the `@gusto` org — Gusto's npm enterprise license. They are **not**
on a separate private registry; there is no such thing. "Private"
here means `publishConfig.access: "restricted"`, which makes the
package private *within npmjs.com* (org members with auth can
install it; the public cannot). The local Verdaccio registry
(`pnpm verdaccio:publish`, `localhost:4873`) is a throwaway
test harness for scaffolder iteration only — never a publish target.

| Package                          | Path                              | Bin                       |
|----------------------------------|-----------------------------------|---------------------------|
| `@gusto/baerly-storage`          | `./` (root)                       | `baerly`                  |
| `@gusto/create-baerly-storage`   | `packages/create-baerly-storage/` | `create-baerly-storage`   |

Workspace `@baerly/*` packages are marked `"private": true` and are
never published — they bundle into the published `@gusto/baerly-storage`.

## One-time setup

No `~/.npmrc` scope routing is needed — the default registry
(`https://registry.npmjs.org/`) is the target. You just need to be
logged in to npm as a member of the `@gusto` org with publish
rights:

```sh
npm login            # standard npmjs.com login
npm whoami           # confirm you're authenticated
```

Membership in the `@gusto` org (and the publish role) is granted by
Gusto's npm org admins. Don't add an `@gusto:registry=` line — that
would point installs at a registry that doesn't exist and is the
root cause of agents inventing a "Gusto private registry."

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
npm view @gusto/baerly-storage
npm view @gusto/create-baerly-storage
```

Confirm each is **private**, not public — this is the bit that bites:

```sh
npm access get status @gusto/baerly-storage          # expect: private
npm access get status @gusto/create-baerly-storage   # expect: private
```

If either reports `public`, flip it immediately with
`npm access set status=private @gusto/<pkg>` and check
`publishConfig.access` is `"restricted"` before the next publish.

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

Plain `0.x.y` semver — no pre-release suffixes. The `0.x` channel
is itself the unstable signal; consumers under `^0.x` opt into "I
might break you on a minor bump."

- **Patch (`0.1.0` → `0.1.1`)**: routine iteration. Use during heavy
  development even when changes are technically breaking — pre-1.0
  semver doesn't owe consumers compat guarantees.
- **Minor (`0.1.x` → `0.2.0`)**: a logical milestone. Something
  you'd point at in a CHANGELOG or post in Slack. The bump is the
  announcement signal.
- **Major (`0.x` → `1.0.0`)**: a commitment to backwards
  compatibility. Could be years away.

Both packages bump together (same release train). Update root
`package.json` and `packages/create-baerly-storage/package.json` in
a single commit before publishing — for this volume of releases,
hand-edit; if it ever grates, write a ~20-line script modeled on
`scripts/verdaccio-publish.mjs` (bumps both, no auto-version, takes
the version as an arg).

Tag the release commit so `git log v0.1.4..v0.1.5` answers "what
changed":

```sh
git tag v0.1.5 && git push --tags
```

## Notes on the publish config

- `publishConfig.provenance` is intentionally NOT set. If/when the
  project is open-sourced (access flipped to `"public"`), restore
  the flag to get npm Sigstore attestations.
- `publishConfig.access` is set to `"restricted"` on both
  published packages. The `@gusto` org on npmjs.com defaults new
  scoped packages to `public`, so leaving `access` unset would
  publish world-readable — `"restricted"` forces a private publish.
  Never change to `"public"`. If you ever add a third `@gusto/*`
  package, set `"access": "restricted"` in its `publishConfig`
  before the first publish.
- The 7 workspace `@baerly/*` packages have `"private": true` as a
  defensive lock. Never remove these flags — those packages are
  bundled into the published `@gusto/baerly-storage`, never
  shipped separately.
