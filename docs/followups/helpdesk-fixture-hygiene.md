# `examples/helpdesk/`: fixture hygiene

**Severity: MEDIUM. Three small cleanups in one fixture, all
reviewable together. Helpdesk is the "what does Baerly feel like?"
tour — these noises shape first impression.**

`examples/helpdesk/` is the dev-only teaching fixture (per
`examples/README.md` and `examples-readme-helpdesk-positioning.md`).
Three drifty bits:

## 1. `.baerly-data/` is committed but the seed runs on every dev start

`examples/helpdesk/.baerly-data/app/helpdesk/tenant/helpdesk-demo/`
contains 15 JSON files (manifest + log entries). `vite.config.ts`
wires `seedTickets` from `./src/server/seed.ts` into `baerlyDev({
  seed: seedTickets })` — the data is re-seeded on every dev start.
And `package.json` ships a `"reset": "rm -rf .baerly-data"` script,
which is the project signaling that the directory is *disposable*.

Net effect: every dev session writes the same files, the
working-tree churns on each run, and `git status` is noisy unless
the user runs `pnpm reset` first.

**Fix:** Add `.baerly-data/` to a new `examples/helpdesk/.gitignore`,
then `git rm -r --cached examples/helpdesk/.baerly-data/` so the
working-tree state stops churning on every dev start. The seed
path stays correct; just don't track the output.

## 2. `examples/helpdesk/` has no `.gitignore` at all

Every other example dir has one:

- `examples/minimal-cloudflare/.gitignore` ✓
- `examples/minimal-node/.gitignore` ✓
- `examples/helpdesk-cloudflare/.gitignore` ✓
- `examples/helpdesk/.gitignore` ✗

So `apps/`, `.baerly-data/` (per item 1), and any local build
output churn on every run. Add the standard set:

```gitignore
node_modules/
dist/
.baerly-data/
.env
.env.local
.DS_Store
*.tsbuildinfo
```

Coordinate trailing-slash style with `gitignore-drift-across-templates.md`.

## 3. `scripts/dev.mjs` is a 28-line SIGINT-to-exit-0 hack

`examples/helpdesk/scripts/dev.mjs` exists to wrap `vite` and
convert SIGINT (signal 130) into exit code 0 so pnpm doesn't print
`[ELIFECYCLE] Command failed.` on Ctrl-C. The `package.json` dev
script is `"dev": "node scripts/dev.mjs"` instead of `"vite"`.

A learner reading "the canonical Node-side Baerly dev pattern"
sees this and assumes the wrapper is required. It isn't — it's
cosmetic.

**Fix:** Delete `scripts/dev.mjs`. Change `package.json` to
`"dev": "vite"`. Accept the ELIFECYCLE noise on Ctrl-C, or file a
pnpm upstream issue if it's really bothersome. The pedagogical
value of "this is what the dev command looks like" is higher than
the value of "no ELIFECYCLE noise on Ctrl-C."

## Why bundle these

All three live in `examples/helpdesk/`, all three are cosmetic
drift around a fixture (not a deployable template), and a single
PR with three small commits closes the cluster.
