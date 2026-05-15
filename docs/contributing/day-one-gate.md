---
title: Day-one handshake gate
audience: operator
summary: Pre-release manual gate that times scaffold → deploy → first record against the day-one SLO.
last-reviewed: 2026-05-14
tags: [operations, gate, day-one, scaffold, deploy]
related: ["../guide/backups.md"]
---

# Day-one handshake gate (`pnpm gate:day-one`)

The day-one gate asserts that a non-engineer + Claude can go from
`npm create baerly@latest` (post-publish) to a working
`client.table().insert()` inside the day-one SLO:

- Cloudflare target: **< 5 min cold**
- Node target: **< 3 min local**

Without any manual credential editing.

## Local install (pre-npm)

> 🚧 **Pre-publish.** `create-baerly` + `@baerly/cli` are not yet
> on npm. The canonical `pnpm dlx file:...tgz` flow doesn't resolve
> the scaffolded `@baerly/*` / `create-baerly` `^0.1.0` devDeps,
> which the registry doesn't know about. Tarball-based staging
> lands separately; until then, validate the gate from inside this
> clone:

```sh
pnpm install && pnpm -r build

# Scaffold inside the workspace so pnpm-workspace.yaml resolves
# @baerly/* + create-baerly to the in-tree packages. The scaffolder
# rejects slashes in the project name, so cd into examples/ first:
cd examples
node ../packages/create-baerly/dist/index.js gate-smoke \
  --target=node --json

cd gate-smoke && pnpm install && pnpm dev
```

Once published, the canonical first-touch path is `npm create
baerly@latest my-app` — the gate's `SUMMARY` assertions and stage
names below are unchanged either way.

## When to run

- Before a release.
- After any change to `npm create baerly` (ticket 38), the deploy
  templates (tickets 39/40), or the auth presets (ticket 37).
- After a `wrangler` major-version bump (the `--x-provision
--x-auto-create` flags are experimental; renames break the gate).

The gate is **NOT** part of `pnpm verify` or `pnpm test`. It takes
minutes per run and burns small amounts of cloud quota; run it
manually.

## Lifecycle

### 1. Generate a per-run secret

```sh
export SHARED_SECRET="$(openssl rand -hex 32)"
```

### 2. Prepare credentials

#### Node target (default)

No extra credentials. The gate spawns `apps/server` locally and
talks to it on a free port.

#### Cloudflare target

Provision in the Cloudflare dashboard once:

- API token with `Workers Scripts:Edit`, `R2:Edit`, `Account:Read`
  scopes. Save as `CF_API_TOKEN`.
- Note the Cloudflare account id. Save as `CF_ACCOUNT_ID`.

```sh
export CF_API_TOKEN="..."
export CF_ACCOUNT_ID="..."
```

### 3. Run the gate

```sh
# Node only:
DAY_ONE_TARGETS=node pnpm gate:day-one

# Both:
DAY_ONE_TARGETS=cloudflare,node pnpm gate:day-one
```

Output (success):

```
day-one handshake — node target
  [+0 ms] start
  [+11023 ms] scaffold-complete
  [+24502 ms] install-complete
  [+27190 ms] server-ready
  [+27192 ms] no-manual-env-edit
  [+27445 ms] first-write
  [+27510 ms] first-read
SUMMARY day-one-node ms=27510 stages=start:0;scaffold-complete:11023;install-complete:24502;server-ready:27190;no-manual-env-edit:27192;first-write:27445;first-read:27510
✓ scaffold → deploy (local) → first record < 3 min, no manual credential editing
```

Output (failure):

```
✗ day-one handshake — cloudflare target
  AssertionError: expected 312050 to be less than 300000
```

The budget violation pinpoints the regression: the per-stage stamps
in the `SUMMARY` line tell you which step exceeded the budget.

### 4. Tear down

The gate's `afterAll` blocks delete the temp scaffold directory and
best-effort-delete the Cloudflare Worker (`wrangler delete
day-one-<unix-ms>`). If the gate process is killed before teardown:

```sh
# List leftover scaffolds (under /tmp/baerly-day-one-*)
ls -d /tmp/baerly-day-one-*

# List leftover Workers
wrangler list | grep day-one-

# Delete each
wrangler delete day-one-<unix-ms>
```

R2 buckets created by `--x-provision --x-auto-create` survive the
Worker deletion. Sweep with:

```sh
wrangler r2 bucket list | grep day-one-
wrangler r2 bucket delete <name>
```

## What the budgets measure

- **`scaffold-complete`** — `npm create baerly@latest` returned.
- **`install-complete`** — `pnpm install` inside the scaffold
  returned.
- **`server-ready`** (Node) — `apps/server`'s `/v1/healthz` returned 200.
- **`deploy-complete`** (CF) — `baerly deploy` returned.
- **`deploy-url-resolved`** (CF) — `.baerly/deploy.json` exists +
  parses.
- **`no-manual-env-edit`** — `.env` mtime is within the gate budget
  (proves it wasn't hand-edited after `pnpm install`).
- **`first-write`** — `client.table().insert()` returned a `_id`.
- **`first-read`** — `client.table().where({_id}).first()`
  round-tripped the doc.

## Adjusting the budgets

```sh
DAY_ONE_BUDGET_NODE_MS=120000 DAY_ONE_TARGETS=node pnpm gate:day-one
# 2 min instead of 3
```

The default budgets are the day-one SLO. Don't loosen them in CI;
loosen only for local-debug runs.

## Failure modes (with fixes)

| Symptom                                                 | Cause                                      | Fix                                                     |
| ------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------- |
| `assertNoManualEnvEdit: ... older than the gate budget` | `.env` was on disk before the scaffold ran | `rm -rf` the temp dir; re-run.                          |
| `wrangler: not found`                                   | `wrangler` not installed                   | `pnpm i -g wrangler` or via `pnpm dlx`.                 |
| CF gate: `Unauthorized`                                 | API token missing R2:Edit                  | Recreate token with all three scopes.                   |
| Node gate: `EADDRINUSE`                                 | Port collision with another process        | `pickFreePort` should prevent; if it fires, file a bug. |
| `wrangler delete <name> failed` in afterAll             | Worker already removed / billing scope     | Manual sweep (see Tear down).                           |
