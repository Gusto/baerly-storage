---
title: Publishing
audience: maintainer
summary: "How to publish @gusto/baerly-storage + @gusto/create-baerly-storage publicly to npmjs.com."
last-reviewed: 2026-11-17
tags: [publishing, release, npm]
related: ["development.md", "../../CLAUDE.md"]
---

# Publishing

Two packages publish from this repo, both scoped to `@gusto/` and both published publicly to the standard npm registry (npmjs.com) with `publishConfig.access: "public"` — the project is open source under Apache-2.0, so anyone can install them without auth.

## Cutting a release

Versioning and the changelog are driven by [Changesets](https://github.com/changesets/changesets). Publishing happens only in CI: pushing a `v*` tag runs `.github/workflows/release.yml`, which publishes both packages with npm [trusted publishing](https://docs.npmjs.com/trusted-publishers/). No npm token exists for these packages, and every release from 0.7.0 on carries a provenance attestation.

Provenance makes the move one-way. Our scaffolds set pnpm's `trustPolicy: no-downgrade`, so once a version carries provenance, an install refuses a later version that doesn't. A token-published release after 0.7.0 would break every scaffolded app's install; that refusal is the guarantee.

Generated artifacts (`baerly.spec.json`, `version-matrix.json`) must be fresh at publish time. `pnpm changeset:version` regenerates both automatically; `pnpm release` refuses to publish a stale one.

1. **While developing** — for any user-facing change, add a changeset:

   ```sh
   pnpm changeset
   ```

   Select `@gusto/baerly-storage` only (the scaffolder bumps with it via the `fixed` group). Write the body for an LLM reader; breaking changes MUST include an old→new migration block (see `.changeset/README.md`).

   Two gotchas invisible until a dry run: `changeset version` bumps and writes a `CHANGELOG.md` for **every** non-ignored workspace package that depends on the bumped one, including `private: true` ones — the `examples/*` apps depend on `baerly-storage: workspace:*`, so a leaf dependent needs to sit in the Changesets `ignore` list or it gets a spurious changelog. And `changeset version` prepends new versions immediately under the `CHANGELOG.md` H1, displacing any preamble between the H1 and the first `## <version>` — put meta-notes as a footer at EOF instead, since prepends never touch the bottom.

2. **At release time** — consume the changesets:

   ```sh
   pnpm changeset:version
   ```

   This bumps both `@gusto/baerly-storage` and `@gusto/create-baerly-storage` to the next version (lockstep), updates the root `CHANGELOG.md`, and deletes the scaffolder's generated changelog (we don't ship one for it). Review the diff — the generated changelog is an editable draft.

3. **Open a release PR.** `main` is protected (a ruleset requires a PR, passing `ci`, and linear history), so the release commit **cannot** be pushed directly — it lands through a PR like any other change:

   ```sh
   V=$(node -p "require('./package.json').version")
   git switch -c "release/v$V"
   git add -A && git commit -m "chore(release): v$V"
   git push -u origin "release/v$V"
   gh pr create --base main --title "chore(release): v$V" \
     --body "Release v$V — see CHANGELOG.md."
   ```

   Wait for `ci` to pass, then **squash- or rebase-merge** it. A merge commit is rejected by the linear-history rule.

4. **Tag the merged commit.** A tag ruleset on `refs/tags/v*` restricts creating, moving and deleting release tags to the owner and admins:

   ```sh
   git switch main && git pull --ff-only
   V=$(node -p "require('./package.json').version")
   git tag "v$V" && git push origin "v$V"
   ```

5. **Approve the deployment.** The tag push runs the `release` workflow in three jobs:
   - `pack` has no OIDC token. It checks that the tag equals `v<version>` for both packages and that the tagged commit is on `origin/main`, installs with the pnpm store cache disabled (so a cache entry written by another run can't reach a tarball), runs `pnpm release --pack` (see [The `pnpm release` script](#the-pnpm-release-script)) and uploads the two tarballs as an artifact.
   - `publish` waits on the `npm-publish` environment's required reviewer; approve it in the Actions tab. It is the only job with `id-token: write`. It sets up Node with `actions/setup-node` alone and installs nothing, not even pnpm, and runs no build or lifecycle script, so no dependency, build plugin or package-manager release can mint the token. It publishes the uploaded tarballs with the npm CLI bundled with Node (`npm publish <tarball> --provenance`), which exchanges the OIDC token for a short-lived publish credential.
   - `attest` holds no token and installs nothing. It polls the registry for up to 10 minutes per package until both published versions serve a provenance attestation, and fails if they don't. It is a separate job so that if the registry is slow, "Re-run failed jobs" repeats only this check; re-running `publish` would try to publish an existing version and fail.

6. **Run the [post-publish smoke](#post-publish-smoke).**

> **Never `changeset publish`, and never publish from a laptop.** `pnpm release` builds before packing, so `dist/` and `dist/CHANGELOG.md` are current when the tarball is cut. A local publish would ship without provenance, so `scripts/publish.mjs --publish` refuses to run outside a GitHub Actions tag run.

| Package                        | Path                              | Bin                     |
| ------------------------------ | --------------------------------- | ----------------------- |
| `@gusto/baerly-storage`        | `./` (root)                       | `baerly`                |
| `@gusto/create-baerly-storage` | `packages/create-baerly-storage/` | `create-baerly-storage` |

Workspace `@baerly/*` packages are marked `"private": true` and are never published — they bundle into the published `@gusto/baerly-storage`.

The published subpaths (`./cloudflare`, `./auth`, `./http`, `./node`, `./config`, `./client`, `./client/react`, `./dev`, `./dev/vite`, `./maintenance`, `./observability`, …) are defined in the **root** `package.json`'s `exports`, not in any `packages/*/package.json`. The workspace packages have their own internal `exports` (e.g. `./_internal/testing`) that are not part of the published surface — grepping `packages/*/package.json` for a subpath is a false negative.

## One-time setup

These are repository and npm-org settings, not files in the repo. Each one is a control the release depends on:

1. **npm trusted publisher**, set by Gusto's npm org admins on **each** package (Settings → Trusted Publisher → GitHub Actions): organization `Gusto`, repository `baerly-storage`, workflow `release.yml`, environment `npm-publish`. A new config expires if no publish uses it within 2 days, and a config can't be edited, only replaced. Renaming the workflow file or the environment breaks publishing until the config is replaced.
2. **`npm-publish` GitHub environment**: the owner as required reviewer, a deployment tag rule of `v*`, and no secrets. This gate holds even if bad code reaches `main`.
3. **Tag ruleset** on `refs/tags/v*`: creation, update and deletion restricted to the owner and admins.
4. **After the first trusted publish succeeds:** on both packages, Settings → Publishing access → "Require two-factor authentication and disallow tokens". Revoke any automation token that could publish these packages.

No `~/.npmrc` scope routing is needed — the default registry (`https://registry.npmjs.org/`) is the target. Don't add an `@gusto:registry=` line — that would point installs at a registry that doesn't exist and is the root cause of agents inventing a "Gusto private registry."

## Pre-publish gate

```sh
pnpm verify            # typecheck + lint + examples typecheck
pnpm build             # rolldown bundle to dist/
pnpm test:agent        # full unit + integration suite
```

All three must be green. **Build before `test:agent`** — `test:agent` skips the `pretest` build hook, so dist-consuming tests (e.g. `dist-docs.test.ts`) read a stale `dist/` and fail spuriously if the bundle wasn't just rebuilt. The build is also required for the publish to ship a valid bundle.

`dist/API.md` is bundled into the published package and is the LLM zero-shot anchor for installed engineers. Sanity-check it after the build:

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

Confirm: `package/dist/index.js`, `package/dist/cloudflare.js`, `package/dist/API.md`, `package/dist/baerly.js` (the CLI bin) are present. The unpacked `package.json` `name:` field matches the scoped name.

Repeat for the scaffolder:

```sh
cd packages/create-baerly-storage
pnpm pack
tar -tzf gusto-create-baerly-storage-*.tgz | head -30
tar -xzOf gusto-create-baerly-storage-*.tgz package/package.json | head -10
```

Confirm: `package/dist/index.js` and `package/dist/templates/{minimal,react}-{cloudflare,node}/package.json` are present. Cleanup the local `.tgz` files when done.

To validate the published manifests and type resolution without a full release, run the same two checks `pnpm release` gates on, standalone:

```sh
pnpm check:exports   # attw — entry points resolve for consumers
pnpm check:publint   # publint — both published manifests are well-formed
```

Both build first, then pack with `pnpm pack` (so `publishConfig.exports` applies). Neither is wired into `verify`/CI — the build + packs belong at release time, not on every PR.

## The `pnpm release` script

`scripts/publish.mjs` has three modes, and takes exactly one. Flags parse strictly, so a typo such as `--dryrun` aborts instead of doing anything.

```sh
pnpm release --dry-run                    # gates, then a publish dry run of both packages
pnpm release --pack=<dir>                 # gates, then pack both packages into <dir> (the `pack` job)
node scripts/publish.mjs --publish=<dir>  # publish the two tarballs in <dir> (the `publish` job)
```

The gates, which `--dry-run` and `--pack` both run:

1. **Generated artifacts are fresh** — `verify:artifacts` (`check-spec-drift` + `check-version-matrix`). A stale checked-in `baerly.spec.json` or `version-matrix.json` aborts before the build runs.
2. **Build and packaging contract** — `verify:package` builds, then runs `check:exports` (attw: every entry point resolves for consumers) and `check:publint` (publint: both manifests are well-formed). A finding aborts before anything is packed. Packing reuses that build (`BAERLY_SKIP_BUILD=1`).

`--publish` runs no gates and no build, and needs no `node_modules`. It refuses unless `GITHUB_ACTIONS=true` and `GITHUB_REF_TYPE=tag`, and it requires the directory to hold exactly the two tarballs for the tag's version. It reads each tarball's `package/package.json` and refuses one whose name or version doesn't match, or whose `publishConfig` sets anything but `access: "public"` and `exports` (npm applies a packed `publishConfig`, so a `registry` or `tag` there would redirect or retag the publish). It then runs `npm publish <tarball> --provenance --access public --ignore-scripts` from the tarball directory, because npm refuses every command inside the checkout (`devEngines.packageManager` names pnpm). `--provenance` makes a failed signature fail the publish; left at its default, provenance is best-effort and a signing failure would publish unattested.

Run the dry run locally, or from the Actions tab (`release` → Run workflow), which runs it on a clean runner without publish permissions. Review the file list — anything outside `dist/` is a packaging bug.

## Post-publish smoke

Sanity-install in a scratch directory:

```sh
mkdir -p /tmp/baerly-smoke && cd /tmp/baerly-smoke
pnpm init --yes
pnpm install @gusto/baerly-storage
ls node_modules/@gusto/baerly-storage/dist/
```

Expected: `dist/index.js`, `dist/API.md`, `dist/baerly.js` present.

Presence isn't enough — assert the published tarball's content matches the published version too. This catches drift that any local gate missed, e.g. a manual `pnpm publish` bypassing `publish.mjs` entirely. Read the version in the repo, then run `npm` from outside it, because npm refuses every command inside a checkout whose `devEngines.packageManager` names pnpm (`EBADDEVENGINES`):

```sh
V=$(node -p "require('./package.json').version")
cd "$(mktemp -d)"
npm pack "@gusto/baerly-storage@$V"            # downloads the published tarball
tar -xzOf "gusto-baerly-storage-$V.tgz" package/dist/baerly.spec.json \
  | node -e 'const s=JSON.parse(require("fs").readFileSync(0));const v=process.argv[1];if(s.serverVersion!==v){console.error(`FAIL: published spec serverVersion ${s.serverVersion} != ${v}`);process.exit(1)}console.log("ok:",s.serverVersion)' "$V"
rm -f "gusto-baerly-storage-$V.tgz"
```

Expected: `ok: <version>`. A hand-corrupted or stale tarball makes it exit 1.

Provenance check (the workflow's `attest` job checks the same field for both):

```sh
pnpm view "@gusto/baerly-storage@$V" dist.attestations.provenance
pnpm view "@gusto/create-baerly-storage@$V" dist.attestations.provenance
```

Both must print a `predicateType` of `https://slsa.dev/provenance/v1`. In the scaffold smoke below, `npm audit signatures` must pass after install.

Scaffold smoke:

```sh
cd /tmp
pnpm create @gusto/baerly-storage@latest baerly-smoke-app --target=cloudflare
cd baerly-smoke-app
pnpm install
npm audit signatures
pnpm baerly doctor --target=cloudflare
```

The scaffold should succeed, install should resolve, and `baerly doctor` should run (it may flag missing wrangler auth on a fresh scratch dir — that's expected).

## Versioning

Plain `0.x.y` semver — no pre-release suffixes. The `0.x` channel is itself the unstable signal; consumers under `^0.x` opt into "I might break you on a minor bump."

- **Patch (`0.1.0` → `0.1.1`)**: routine iteration. Use during heavy development even when changes are technically breaking — pre-1.0 semver doesn't owe consumers compat guarantees.
- **Minor (`0.1.x` → `0.2.0`)**: a logical milestone. Something you'd point at in a CHANGELOG or post in Slack. The bump is the announcement signal.
- **Major (`0.x` → `1.0.0`)**: a commitment to backwards compatibility. Could be years away.

Both packages bump together (same release train) via the Changesets `fixed` group. Don't hand-edit versions — run `pnpm changeset:version` (it bumps both packages and writes `CHANGELOG.md`), then tag the release commit so `git log v0.1.4..v0.1.5` answers "what changed". The end-to-end mechanics live in [Cutting a release](#cutting-a-release) above.

## Third-party license notices

The published `@gusto/baerly-storage` bundle ships a `dist/THIRD-PARTY-LICENSES.txt` file alongside the code. Here's why it exists and how it's produced.

**Why.** rolldown _inlines_ our runtime deps (`aws4fetch`, `@rgrove/parse-xml`, `hono`, `@hono/node-server`, `jose`, `@logtape/logtape`, plus the CLI's `citty` + `jsonc-parser`) into `dist/`. Those deps are MIT/ISC/BSD/Apache-2.0; every one of those licenses requires its copyright + permission notice to travel with any copy of the code. Bundling is a copy, so the notices must ship too.

**Architecture.** The notices file is generated at build time, never hand-maintained:

1. Each rolldown build runs codepunkt's `rollup-license-plugin` (`rolldown.config.ts` for the library entries, `packages/cli/rolldown.config.ts` for the `baerly` bin). Each plugin discovers the third-party packages _that build_ bundled and writes a partial JSON manifest — `dist/.third-party-licenses.lib.json` and `dist/.third-party-licenses.cli.json` respectively.
2. The final `pnpm build` step runs `node scripts/merge-third-party-licenses.mjs`, which unions + dedupes the partials by `name@version`, renders each dep's verbatim license text into `dist/THIRD-PARTY-LICENSES.txt`, then deletes the partials so they never reach the tarball.

The notices file ships via the root package's `files: ["dist"]` — no extra packaging wiring. `tests/integration/third-party-licenses.test.ts` pins that it exists, lists every bundled lib across both builds, and carries verbatim text.

**The scaffolder.** `@gusto/create-baerly-storage` has no runtime dependencies: its rolldown config (`packages/create-baerly-storage/rolldown.config.ts`) bundles `@clack/prompts`, `citty` and their transitive deps, and externalizes only `node:` builtins. `npm create` installs the scaffolder outside our lockfile and pnpm policies, so a `^` range there would let a hijacked patch release run on every new scaffold; bundled, the tarball ships exactly what our lockfile resolved. The same plugin, with the same allowlist, writes `packages/create-baerly-storage/dist/THIRD-PARTY-LICENSES.txt` in that build, and the same test pins it.

**Allowlist gate.** `scripts/third-party-licenses.mjs` holds the permissive-license allowlist (MIT / ISC / BSD-2 / BSD-3 / Apache-2.0 / 0BSD / Unlicense / CC0-1.0) and the SPDX acceptability check. The plugin calls it as `unacceptableLicenseTest`, and the merge step re-checks as a belt-and-suspenders guard. **The build fails** if any bundled dep carries a non-permissive license (e.g. any copyleft GPL/AGPL/LGPL/MPL), so a license-incompatible dep can never silently ship.

## Notes on the publish config

- `publishConfig.access` is set to `"public"` on both published packages, and `scripts/publish.mjs` also passes `--access public` explicitly. If you add a third published `@gusto/*` package, set `"access": "public"` in its `publishConfig`.
- Provenance is requested with `--provenance` on the publish command rather than `publishConfig.provenance`, so a local `pnpm pack` or dry run doesn't try to sign. Left at its default, provenance is best-effort under trusted publishing (in npm and pnpm alike), so a signing failure would publish unattested; one unattested release would make our scaffolds' `trustPolicy: no-downgrade` refuse every later release.
- The 7 workspace `@baerly/*` packages have `"private": true` as a defensive lock. Never remove these flags — those packages are bundled into the published `@gusto/baerly-storage`, never shipped separately. (This is a workspace-packaging detail, unrelated to the project being open source.)

## Incident runbook

Open a private [GitHub Security Advisory](https://docs.github.com/en/code-security/security-advisories/working-with-repository-security-advisories/creating-a-repository-security-advisory) for the repo first in every case: it is the coordination space and, once published, the notice users and Dependabot see. Involve Gusto Security.

### A release of ours is compromised

A version was published that we didn't build from `main`, or one that ships malicious or badly broken code.

1. Deprecate the version on both packages so installs warn: `npm deprecate "@gusto/baerly-storage@<v>" "<reason>; upgrade to <fixed>"`, and the same for `@gusto/create-baerly-storage`. Run `npm` from outside the checkout. Unpublishing is limited by npm's policy and breaks lockfiles, so deprecate instead.
2. Fix on `main`, then cut a fixed release through the normal tag flow. The fixed release carries provenance, so `trustPolicy: no-downgrade` keeps accepting it.
3. Publish the advisory naming the affected range and the fixed version.
4. If the bad version didn't come from `release.yml`, someone published outside trusted publishing; treat it as credential exposure too.

### A dependency we bundle is compromised

`@gusto/baerly-storage` inlines its runtime deps into `dist/` (see [Third-party license notices](#third-party-license-notices)), and `@gusto/create-baerly-storage` bundles all of its deps. A compromised version of one of them is in our tarball if our lockfile resolved it when we built.

1. Check: `pnpm why <dep>` on the release tag, and `dist/THIRD-PARTY-LICENSES.txt` in the published tarball, which lists each bundled `name@version`.
2. Pin the lockfile to a clean version (an `overrides` entry if no clean version satisfies the range), rebuild, and cut a patch release.
3. Deprecate the affected versions and publish the advisory, as above.

### Publish credentials may be exposed

A token, an npm account with publish rights, or the `npm-publish` environment may be in the wrong hands.

1. Revoke the token or reset the account's credentials. In npm, check each package's maintainers and trusted-publisher config, and remove anything unexpected.
2. Confirm both packages still have "disallow tokens" set, so only `release.yml` can publish.
3. Check that the tag ruleset and the `npm-publish` environment's reviewer rule are unchanged, and audit recent tags and `release` runs.
4. Compare every version published since the suspected exposure with a tagged `release` run that published it. Treat any version without one as a compromised release (above).
