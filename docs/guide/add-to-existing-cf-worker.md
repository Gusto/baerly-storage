---
title: Add baerly to an existing Cloudflare Worker
audience: integrator
summary: One-command bolt-on for an existing `wrangler create` project — `pnpm create @gusto/baerly-storage@latest .` detects wrangler.jsonc, patches it, prints the worker-entry snippet.
last-reviewed: 2026-05-24
tags: [getting-started, cloudflare]
related: [../contributing/extending.md]
---

# Add baerly to an existing Cloudflare Worker

This is the path when you already have a Wrangler project (`wrangler
create`, an existing repo, etc.) and want to bolt baerly on. The same
command (`pnpm create @gusto/baerly-storage@latest .`) covers the fresh-scaffold case — it
dispatches based on what's already in the directory.

## The one-step

```sh
pnpm create @gusto/baerly-storage@latest .
```

`@gusto/create-baerly-storage` detects your `wrangler.jsonc`, patches it with an R2
binding and the four `vars` baerly expects, seeds a `.dev.vars` with
a dev secret, adds `.dev.vars` to `.gitignore` if it isn't already
covered, appends `@gusto/baerly-storage` to your `package.json` dependencies,
runs your package manager's install, and prints the worker-entry
snippet for you to paste.

(`npm create baerly .`, `yarn create baerly .`, `bun create baerly .`
all work — the underlying package-manager dispatch picks the right
one.)

## What gets written (skip-if-exists / merge-if-present)

| File | What happens |
|---|---|
| `wrangler.jsonc` | Adds `r2_buckets: [{ binding: "BUCKET", bucket_name: <app> }]` if no entry named `BUCKET` exists. Merges `vars: { APP, TENANT }` — keys you've already set win. |
| `.dev.vars` | Created with `SHARED_SECRET=dev-shared-secret`. **Replace before deploy** via `wrangler secret put SHARED_SECRET`. Skipped if `.dev.vars` already exists. |
| `.gitignore` | Appends `.dev.vars` unless an equivalent pattern (`.env*.local`, `*.local`, `.env`) is already present. |
| `package.json` | Appends `@gusto/baerly-storage` to `dependencies` if not present. |
| `baerly.config.ts` | Written if absent. Pass `--force` to overwrite. |

## What does NOT get written

- `src/index.ts` — printed as a snippet you paste. baerly never
  auto-edits your Worker entry. Convex draws the same line: structured
  config is fair game; app code is yours.
- `wrangler` secrets — `wrangler secret put SHARED_SECRET` is yours
  to run before deploy.

## After the one-step

1. Paste the printed snippet into the path declared in
   `wrangler.jsonc:main` (typically `src/index.ts`), replacing the
   stock `wrangler create` handler.
2. `pnpm dev` (or `wrangler dev`) to boot. Hit
   `http://localhost:8787/v1/<collection>/...` to verify; see
   [the routes ref](../contributing/extending.md).
3. Before deploy: `wrangler secret put SHARED_SECRET` to set the
   production secret, then `wrangler deploy`.

## Re-running

`pnpm create @gusto/baerly-storage@latest .` is idempotent on existing wrangler projects.
Re-run it any time — every write is gated by detection, so a second
run with the same flags is a no-op. Use this to add a missing `vars`
key or to re-check the R2 binding after editing `wrangler.jsonc` by
hand.
