---
title: Publishing
audience: maintainer
summary: "How to publish @gusto/baerly-storage + @gusto/create-baerly-storage privately under the @gusto org on npmjs.com."
last-reviewed: 2026-06-03
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

## Cutting a release

Versioning and the changelog are driven by [Changesets](https://github.com/changesets/changesets).
Publishing stays on `pnpm release` for private-access enforcement.

1. **While developing** — for any user-facing change, add a changeset:

   ```sh
   pnpm changeset
   ```

   Select `@gusto/baerly-storage` only (the scaffolder bumps with it via
   the `fixed` group). Write the body for an LLM reader; breaking changes
   MUST include an old→new migration block (see `.changeset/README.md`).

2. **At release time** — consume the changesets:

   ```sh
   pnpm changeset:version
   ```

   This bumps both `@gusto/baerly-storage` and `@gusto/create-baerly-storage`
   to the next version (lockstep), updates the root `CHANGELOG.md`, and
   deletes the scaffolder's generated changelog (we don't ship one for it).
   Review the diff — the generated changelog is an editable draft.

3. **Commit + tag** the release:

   ```sh
   git add -A && git commit -m "chore(release): v$(node -p "require('./package.json').version")"
   git tag "v$(node -p "require('./package.json').version")"
   ```

4. **Publish** with the private-access-enforcing path:

   ```sh
   pnpm release
   ```

   `pnpm release` runs `pnpm build` (which copies the updated `CHANGELOG.md`
   into `dist/CHANGELOG.md`) and publishes both packages with
   `--access restricted` + force-private verification.

> **Do not run `changeset publish`.** It issues a bare publish that drops
> `--access restricted`, which lands the package world-readable. `pnpm release`
> (`scripts/publish.mjs`) is the only sanctioned publish path.

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

## Publish — always via `pnpm release`

> ⚠️ **Never run a bare `pnpm publish` / `npm publish`.** A
> `prepublishOnly` guard (`scripts/guard-publish.mjs`) blocks it on
> both packages, because a bare publish leaks them **public**. Two
> things conspire: `pnpm publish` silently drops
> `publishConfig.access: "restricted"`, and the `@gusto` org default
> visibility is **public**, so the registry publishes world-readable.
> This burned us twice.

`pnpm release` (`scripts/publish.mjs`) is the only sanctioned path. It:

1. builds,
2. publishes both packages with an **explicit** `--access restricted`,
3. forces `npm access set status=private` on each (only needs package
   write access, not org admin — and it's the authoritative lever,
   since `--access` is honoured only on a package's *first* publish),
4. **verifies** with `npm access get status` and **exits non-zero,
   loudly, if either package is not private.**

```sh
pnpm release --dry-run     # build + pack + report current visibility, no writes
pnpm release               # the real thing
pnpm release --otp=123456  # forward a 2FA one-time code if prompted
```

Review the dry-run file list — anything outside `dist/` is a
packaging bug. A green `pnpm release` ends with
`✓ Both packages published and verified PRIVATE.` Anything else is a
failed release; follow the script's printed remediation
(`npm access set status=private <pkg>`) until `npm access get status`
prints `private`.

> **The durable backstop is the org setting.** If you (or an org
> admin) can set the `@gusto` org's *default package visibility* to
> private on npmjs.com, do it — that removes the public window
> entirely. `pnpm release` is the admin-free safeguard for when you
> can't.

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
