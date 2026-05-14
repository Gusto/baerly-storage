# 04 — Staged `pnpm pack` install path + README rewrite

**One-liner.** Add `prepack` hooks to both publishable packages,
bump versions to `0.1.0`, rewrite the root `README.md` Quick Start
to lead with the scaffold flow (using tarballs as the staged
install path), and update `docs/operating/day-one-gate.md`.

**Estimated effort.** 1 day. **Risk.** Low — primarily packaging
+ docs; verified end-to-end via a manual `pnpm dlx` smoke.

---

> **Self-contained.** You don't need to consult any planning notes
> or chat logs. Everything you need is in this file, the repo, and
> the conventions referenced at the bottom. Note: tickets 01, 02,
> and 03 MUST land first — this ticket validates the full
> scaffold → install → `baerly dev` chain.

## Why we're doing this

End-to-end, the canonical first-touch path is:

```
$ npm create baerly@latest my-app
$ cd my-app && pnpm install
$ pnpm dev
```

The middle two steps work today (after tickets 01-03). The
first step does not, because both `create-baerly` and
`@baerly/cli` are `private: true` in their `package.json` files
and have never been published to npm. We are not publishing in
this workstream — the user wants to stage via local tarballs
first to shake out the rest of first-touch. This ticket:

1. Makes both packages `pnpm pack`-able with reproducible tarball
   filenames (i.e. set `version` to `0.1.0`; add a `prepack`
   build hook).
2. Rewrites the root `README.md` Quick Start to **lead** with the
   scaffold flow (`pnpm dlx file:./packages/create-baerly/create-baerly-0.1.0.tgz my-app`),
   moving the existing inline-code "use it as a library" Quick
   Start lower as "Or wire it by hand."
3. Updates `docs/operating/day-one-gate.md` so the day-1 gate
   reflects the new on-ramp.
4. Records the manual smoke that validates the full chain.

This is intentionally a separate, deferred ticket from "publish
to npm" — the latter requires a registry decision (public vs.
private), a publish workflow (Changesets? release-please? hand-
rolled?), and visibility about which `@baerly/*` workspace
packages also need publishing. Out of scope here.

## Current state

- `packages/create-baerly/package.json` (verified):
  - `name: "create-baerly"`, `version: "0.0.0"`, `private: true`.
  - `bin: { "create-baerly": "./dist/index.js" }`.
  - `files: ["dist", "templates"]` — note the `templates` entry
    is leftover from before commit `103289c`; templates now live
    under `dist/templates/` via the rolldown copy plugin, so the
    standalone `templates` directory no longer exists at pack
    time. **`files` must be reduced to `["dist"]`** (or `dist`
    must be left + verified to ship `dist/templates/`).
  - `scripts.build: "rolldown -c"`. No `prepack`.

- `packages/cli/package.json` (verified):
  - `name: "@baerly/cli"`, `version: "0.0.0"`, `private: true`.
  - `bin: { "baerly": "./dist/baerly.js" }`.
  - `scripts.build: "rolldown -c"`. No `prepack`.
  - No `files` field — `pnpm pack` will default to packing
    everything outside `.gitignore`. Add a `files: ["dist"]` to
    keep the tarball lean.

- `README.md` (root) currently leads with a code-snippet Quick
  Start that imports `@baerly/adapter-node` from a Node script.
  No mention of `npm create baerly@latest` until after the
  helpdesk reference.

- `docs/operating/day-one-gate.md` exists (referenced from
  CLAUDE.md). Verify its current contents — the day-1 gate
  checklist will need an "install via tarball" path for
  contributors validating their work against this branch.

- `pnpm` version pinned at `10.31.0` per
  `package.json:packageManager`. `pnpm pack -F <name>` is the
  workspace-aware pack command.

## Implementation steps

### Step 1. Tighten `files` and add `prepack`

`packages/create-baerly/package.json`:

```json
{
  "version": "0.1.0",
  "files": ["dist"],
  "scripts": {
    "build": "rolldown -c",
    "prepack": "rolldown -c"
  }
}
```

`packages/cli/package.json`:

```json
{
  "version": "0.1.0",
  "files": ["dist"],
  "scripts": {
    "build": "rolldown -c",
    "prepack": "rolldown -c"
  }
}
```

Leave `private: true` in place — we are **not** publishing to
npm in this ticket. `pnpm pack` works on private packages.

If `pnpm install` complains about a missing `prepublishOnly` hook
or similar, ignore — npm-publish surface is not in scope.

### Step 2. Validate the pack

```sh
pnpm install
pnpm -r build
pnpm -F create-baerly pack
pnpm -F @baerly/cli pack
ls packages/create-baerly/create-baerly-0.1.0.tgz
ls packages/cli/baerly-cli-0.1.0.tgz   # or whatever name pnpm pack chose
tar -tzf packages/create-baerly/create-baerly-0.1.0.tgz | head -30
# Verify dist/templates/minimal-{cloudflare,node}/ is present in the tarball
tar -tzf packages/create-baerly/create-baerly-0.1.0.tgz | \
  grep -E "dist/templates/minimal-(cloudflare|node)/.baerly/scaffold.json"
```

If `dist/templates/` is missing from the tarball, check the
rolldown `copyTemplates` plugin in
`packages/create-baerly/rolldown.config.ts` — `closeBundle` may
not have written before `pnpm pack` reads the directory. Worst-
case fix: add a `pnpm -F create-baerly build` step inside the
`prepack` script (which the snippet above already does).

### Step 3. Manual end-to-end smoke

```sh
TARBALL=$PWD/packages/create-baerly/create-baerly-0.1.0.tgz
CLI_TARBALL=$PWD/packages/cli/baerly-cli-0.1.0.tgz   # adjust filename

# Fresh shell, fresh directory
rm -rf /tmp/scaffold-smoke && mkdir /tmp/scaffold-smoke && cd /tmp/scaffold-smoke

# Scaffold via the tarball
pnpm dlx "file:$TARBALL" my-app --target=cloudflare --json

# The scaffolded project's package.json now references @baerly/cli
# as a workspace:* dep — that won't resolve in /tmp. Two options:
#
# (a) Test from inside the repo: pnpm dlx "file:$TARBALL" examples/test-app
#     and let the workspace resolve @baerly/cli automatically.
# (b) Install the CLI tarball alongside: cd my-app && pnpm install
#     "file:$CLI_TARBALL" && pnpm install.
#
# (a) is what we'll document in the README. (b) is the "after
# packaging is fully decoupled" path; verify it works but don't
# put it in the README yet.

cd my-app && pnpm install && pnpm dev &
sleep 2
curl -s http://localhost:3000/v1/since?app=my-app | head -1
kill %1
```

### Step 4. Rewrite `README.md` Quick Start

Replace the existing `## Quick start` block (currently a TypeScript
import snippet) with the scaffold-led version. Keep the snippet,
but demote it under a `## Or wire it by hand` heading further
down — it's still the right docs for "I have an existing app and
want to embed baerly directly."

New Quick Start text (paste into `README.md`):

```markdown
## Quick start

```sh
# Until baerly hits npm, stage locally from a clone:
pnpm install && pnpm -r build
pnpm -F create-baerly pack
pnpm -F @baerly/cli pack

# Then in the directory where you want your project to live:
pnpm dlx file:/path/to/baerly-storage/packages/create-baerly/create-baerly-0.1.0.tgz my-app
cd my-app
pnpm install
pnpm dev
```

`pnpm dev` runs `baerly dev`: a local Node listener over
`LocalFsStorage` on `http://localhost:3000`. The same verb works
for both Cloudflare-Workers and self-hosted-Node targets — pick
your deploy target at scaffold time and the appropriate
`apps/server/` shell is written, but day-1 iteration is target-
agnostic. (Cloudflare users can `pnpm dev:wrangler` for parity
testing.)

For the runnable multi-tab demo, see
[`examples/helpdesk/`](./examples/helpdesk).
```

Then add a new section further down (after the existing
"Where things live" or wherever it fits naturally):

```markdown
## Or wire it by hand

If you'd rather embed baerly into an existing app, the kernel is
about 30 lines:

<existing TypeScript snippet — keep as-is>
```

### Step 5. Update `docs/operating/day-one-gate.md`

Read the file. If it has a "Install path" or "Smoke test" section,
replace any `npm create baerly@latest` reference with the staged
tarball flow. If it has none, add a section near the top
labelled "Local install (pre-npm)" with the same four-line
`pnpm pack` snippet from `README.md`.

Keep the existing `npm create baerly@latest -- my-app
--target=cloudflare` references in
`packages/create-baerly/package.json:5` (description) and
`packages/create-baerly/src/index.ts:2-3` (JSDoc). They are the
**post-publish** invocation and remain accurate as a future-state
docstring. Add a short JSDoc comment on each citing this ticket
or noting "live once published to npm."

### Step 6. Update memory pointers (optional)

If the user keeps a project memory file pointing at "phase 8" or
"on-ramp work," consider adding a short note that the canonical
on-ramp is `npm create baerly@latest` → `baerly dev`. Out of
scope of this ticket — flag it for the post-merge memory update
step.

## Conventions to follow

- README format follows the existing structure: H1 title, intro
  paragraph, then `## Quick start`. Don't reorder above
  Quick Start.
- Code blocks in markdown use ```sh / ```ts as appropriate.
  See `docs/conventions/docs.md` if present.
- `docs/operating/` files have audience metadata in frontmatter
  (verify by reading any existing file in that directory).
- Do not lift `private: true` in this ticket. That's a separate
  decision tied to publish workflow.
- The tarball filename pattern is `<name>-<version>.tgz`; pnpm's
  hyphenation rules turn `@baerly/cli` into `baerly-cli` — verify
  exact filename after first pack and update the README to match.

## Verification

```sh
# Static
pnpm verify
pnpm format:check README.md docs/operating/day-one-gate.md

# Pack
pnpm install && pnpm -r build
pnpm -F create-baerly pack
pnpm -F @baerly/cli pack

# Tarballs contain the expected payload
tar -tzf packages/create-baerly/create-baerly-0.1.0.tgz | grep -c "dist/templates/" | xargs test 1 -le
tar -tzf packages/cli/baerly-cli-0.1.0.tgz | grep -c "dist/baerly.js" | xargs test 1 -le

# End-to-end (manual)
# See `Step 3` above. Done when the scaffolded app boots via
# `pnpm dev` and serves a 200 on `/v1/since`.
```

Done when:
- Both tarballs build via `pnpm pack`.
- The README's Quick Start documents the staged tarball flow as
  the canonical first-touch path.
- A fresh user, following only the README, can scaffold and run
  an app from a clone of the repo without consulting any other
  docs.
- `docs/operating/day-one-gate.md` reflects the same flow.

## Out of scope

- **Publishing to public npm.** Separate ticket needed; involves
  registry choice, semver discipline, the rest of the
  `@baerly/*` workspace packages, and a release workflow.
- **Auto-publishing on tag push.** Same.
- **A `baerly` npm CLI wrapper that auto-installs the CLI globally.**
  Not necessary for staging.
- **Polishing the README's "Where things live" or feature list.**
  Touch only the Quick Start and the new "Or wire it by hand"
  section.

## Conflict notes

- **Depends on**: tickets 01 (`baerly dev` exists), 02 (wizard
  experience users see when running the tarball interactively),
  03 (scaffolded `dev` scripts call `baerly dev`).
- **Blocks**: nothing in this ticket-set. A future "publish to
  npm" ticket depends on this one but is not in this batch.
- **No file overlap** with tickets 00 (`docs/adr/`), 01
  (`packages/cli/src/`), 02 (`packages/create-baerly/src/`), 03
  (`examples/`). This ticket only touches `README.md`,
  `docs/operating/day-one-gate.md`, and the two `package.json`
  files in `packages/{create-baerly,cli}/`.

## Pointers

- `packages/create-baerly/package.json` — version, files, prepack.
- `packages/cli/package.json` — same.
- `packages/create-baerly/rolldown.config.ts` — `copyTemplates`
  plugin (verify `dist/templates/` is populated).
- `README.md` (repo root) — Quick Start rewrite.
- `docs/operating/day-one-gate.md` — install steps.
- `docs/conventions/docs.md` — docs style if present.
- pnpm pack documentation:
  https://pnpm.io/cli/pack (link only — not required reading).
