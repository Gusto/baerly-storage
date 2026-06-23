---
title: Publishing
audience: maintainer
summary: "How to publish @gusto/baerly-storage + @gusto/create-baerly-storage publicly to npmjs.com."
last-reviewed: 2026-06-16
tags: [publishing, release, npm]
related: ["development.md", "../../CLAUDE.md"]
---

# Publishing

Two packages publish from this repo, both scoped to `@gusto/` and
both published publicly to the standard npm registry (npmjs.com) with
`publishConfig.access: "public"` — the project is open source under
Apache-2.0, so anyone can install them without auth.

## Cutting a release

Versioning and the changelog are driven by [Changesets](https://github.com/changesets/changesets).
Publishing goes through `pnpm release`, which builds first and passes
`--access public` explicitly.

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

4. **Publish:**

   ```sh
   pnpm release
   ```

   `pnpm release` runs `pnpm build` (which copies the updated `CHANGELOG.md`
   into `dist/CHANGELOG.md`) and publishes both packages with
   `--access public`.

> **Prefer `pnpm release` over `changeset publish`.** `pnpm release`
> (`scripts/publish.mjs`) builds first, so `dist/` is fresh and
> `dist/CHANGELOG.md` is current before the tarball is cut.

| Package                        | Path                              | Bin                     |
| ------------------------------ | --------------------------------- | ----------------------- |
| `@gusto/baerly-storage`        | `./` (root)                       | `baerly`                |
| `@gusto/create-baerly-storage` | `packages/create-baerly-storage/` | `create-baerly-storage` |

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

## Publish via `pnpm release`

`pnpm release` (`scripts/publish.mjs`) is the sanctioned path. It:

1. builds,
2. publishes both packages with an **explicit** `--access public`
   (pnpm has historically dropped `publishConfig.access` on the wire,
   so the flag is passed by hand to be safe).

```sh
pnpm release --dry-run     # build + pack + report current visibility, no writes
pnpm release               # the real thing
pnpm release --otp=123456  # forward a 2FA one-time code if prompted
```

Review the dry-run file list — anything outside `dist/` is a
packaging bug. A green `pnpm release` ends with
`✓ Both packages published.`

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

Both packages bump together (same release train) via the Changesets
`fixed` group. Don't hand-edit versions — run `pnpm changeset:version`
(it bumps both packages and writes `CHANGELOG.md`), then tag the release
commit so `git log v0.1.4..v0.1.5` answers "what changed". The end-to-end
mechanics live in [Cutting a release](#cutting-a-release) above.

## Third-party license notices

The published `@gusto/baerly-storage` bundle ships a
`dist/THIRD-PARTY-LICENSES.txt` file alongside the code. Here's why it
exists and how it's produced.

**Why.** rolldown _inlines_ our runtime deps (`aws4fetch`,
`fast-xml-parser`, `hono`, `@hono/node-server`, `jose`,
`@logtape/logtape`, `picocolors`, plus the CLI's `citty` + `jsonc-parser`)
into `dist/`. Those deps are MIT/ISC/BSD/Apache-2.0; every one of those
licenses requires its copyright + permission notice to travel with any
copy of the code. Bundling is a copy, so the notices must ship too.

**Architecture.** The notices file is generated at build time, never
hand-maintained:

1. Each rolldown build runs codepunkt's `rollup-license-plugin`
   (`rolldown.config.ts` for the library entries,
   `packages/cli/rolldown.config.ts` for the `baerly` bin). Each plugin
   discovers the third-party packages _that build_ bundled and writes a
   partial JSON manifest — `dist/.third-party-licenses.lib.json` and
   `dist/.third-party-licenses.cli.json` respectively.
2. The final `pnpm build` step runs
   `node scripts/merge-third-party-licenses.mjs`, which unions + dedupes
   the partials by `name@version`, renders each dep's verbatim license
   text into `dist/THIRD-PARTY-LICENSES.txt`, then deletes the partials
   so they never reach the tarball.

The notices file ships via the root package's `files: ["dist"]` — no
extra packaging wiring. `tests/integration/third-party-licenses.test.ts`
pins that it exists, lists every bundled lib across both builds, and
carries verbatim text.

**Allowlist gate.** `scripts/third-party-licenses.mjs` holds the
permissive-license allowlist (MIT / ISC / BSD-2 / BSD-3 / Apache-2.0 /
0BSD / Unlicense / CC0-1.0) and the SPDX acceptability check. The plugin
calls it as `unacceptableLicenseTest`, and the merge step re-checks as a
belt-and-suspenders guard. **The build fails** if any bundled dep carries
a non-permissive license (e.g. any copyleft GPL/AGPL/LGPL/MPL), so a
license-incompatible dep can never silently ship.

## Notes on the publish config

- `publishConfig.access` is set to `"public"` on both published
  packages, and `pnpm release` also passes `--access public`
  explicitly. If you add a third published `@gusto/*` package, set
  `"access": "public"` in its `publishConfig`.
- `publishConfig.provenance` is intentionally NOT set. npm provenance
  (Sigstore attestations) is only available when publishing from a
  supported CI/OIDC environment (e.g. GitHub Actions) — it cannot be
  generated by a manual `pnpm release` from a laptop, where it would
  fail the publish. Enable it if/when release moves into CI.
- The 7 workspace `@baerly/*` packages have `"private": true` as a
  defensive lock. Never remove these flags — those packages are
  bundled into the published `@gusto/baerly-storage`, never
  shipped separately. (This is a workspace-packaging detail, unrelated
  to the project being open source.)
